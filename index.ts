/**
 * mesh —— pi 的并行分身内核(agent / send / sessions / stop)。
 *
 * TUI 这一侧只做三件事:注册自己的 presence、把四个动词挂成工具、把自己信箱里的信在空闲时注入。
 * 工人全部跑在 mesh-hostd 守护进程里(src/hostd.ts);本进程不寄宿任何会话。
 * 设计:README.md;策略归技能 mesh-engineering。
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COALESCE_MS, DEFAULT_MESH_ROOT, HEARTBEAT_MS, HOSTD_TERM_WAIT_MS, MAX_RUNNING, MESH_SESSIONS_DIR, SWEEP_MS, addUsage, cacheLabel, clip, isThinkingLevel, isToolError, isUrgentIntent, isWakeWorthy, meshPaths, sid8 } from "./src/types.ts";
import type { MeshPaths } from "./src/types.ts";
import { allPresence, ensureDirs, inSessionList, isLive as isLiveAgent, patchPresence, pidAlive, readPresence, registerSelf, rootOf, sessionState } from "./src/registry.ts";
import { consumeMail, listMail, pendingCount, planInjection, renderMail, watchMailbox } from "./src/mailbox.ts";
import { planInjectGate } from "./src/inject-gate.ts";
import type { HoldState } from "./src/inject-gate.ts";
import { makeResolveModel } from "./src/factory.ts";
import { TOOL_DEFS, toKernelArgs } from "./src/tools.ts";
import { clearHostdState, ensureHostd, hostdStatusLine, readHostdState } from "./src/hostd-launch.ts";
import { createKernel } from "./src/kernel.ts";
import type { Kernel } from "./src/kernel.ts";

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);

export default function (pi: ExtensionAPI) {
	setupMesh(pi, meshPaths(DEFAULT_MESH_ROOT));
}

/** 路径注入供事件回归测试使用,不触碰真实舰队。 */
export function setupMesh(pi: ExtensionAPI, paths: MeshPaths) {
	let lastCtx: ExtensionContext | null = null;
	let selfSid: string | undefined;
	let selfAlias = "?";
	let kernel: Kernel | null = null;
	let unwatchSelf: (() => void) | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let sweepTimer: ReturnType<typeof setInterval> | null = null;
	let injectTimer: ReturnType<typeof setTimeout> | null = null;
	let injectDueAt = 0;

	/** 内核零策略文本:方法在技能 mesh-engineering 里,这里只留一行入网事实。 */
	const humanFacts = "## mesh\n本会话已入网: agent(派)/send(说)/sessions(看)/stop(停)。使用原则与按需配方见技能 `mesh-engineering`(/skill:mesh-engineering)。结果与异常会自动通知创建者, 无需轮询; agent 给你写信用 to:\"creator\"。";

	// ---- own mailbox 注入(human 分支:只在空闲时,紧急立即,其余合批) ----

	let hold: HoldState = {};
	let lastInjectedFleet: string | undefined;

	const fleetSummary = (injecting = 0) => {
		const now = Date.now();
		const all = allPresence(paths);
		const self = all.find((p) => p.sid === selfSid);
		const visible = self ? all.filter((p) => p.kind === "agent" && inSessionList(paths, self, p, now)) : [];
		const running = visible.filter((p) => sessionState(p, now) === "running");
		// 固定别名展示顺序,避免目录枚举顺序造成假变化。
		const dormant = visible.filter((p) => sessionState(p, now) === "dormant").sort((a, b) => a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0);
		const unread = Math.max(0, (selfSid ? pendingCount(paths, selfSid) : 0) - injecting); // 正在注入的这批不算未读
		return `你的舰队: ${running.length} running / ${dormant.length} dormant${dormant.length ? `(${dormant.slice(0, 6).map((p) => p.alias).join(", ")}${dormant.length > 6 ? "…" : ""})` : ""} / ${unread} 未读。`;
	};

	const scheduleInject = (ms: number = COALESCE_MS) => {
		const due = Date.now() + ms;
		if (injectTimer) {
			if (injectDueAt <= due) return;
			clearTimeout(injectTimer);
		}
		injectDueAt = due;
		injectTimer = setTimeout(flushInject, ms);
		injectTimer.unref?.();
	};

	const flushInject = () => {
		injectTimer = null;
		injectDueAt = 0;
		if (!selfSid) return;
		const mail = listMail(paths, selfSid);
		consumeMail(mail.filter(({ msg }) => msg.kind === "control").map((m) => m.file));
		const deliverable = mail.filter(({ msg }) => msg.kind !== "control");
		if (deliverable.length === 0) {
			hold = {};
			return;
		}
		if (lastCtx && !lastCtx.isIdle()) return; // 忙时不注入,留箱合并
		const isHuman = (sid: string) => readPresence(paths, sid)?.kind === "human";
		const gate = planInjectGate({
			now: Date.now(),
			letters: deliverable.map(({ msg }) => ({
				kind: msg.kind,
				at: msg.at,
				urgent: msg.kind === "message" && (isUrgentIntent(msg.intent) || (msg.from !== "system" && isHuman(msg.from))),
			})),
			state: hold,
		});
		hold = gate.state;
		if (gate.action === "wait") {
			scheduleInject(gate.waitMs);
			return;
		}
		const plan = planInjection(deliverable, { isHuman });
		consumeMail(plan.drop.map((m) => m.file));
		if (plan.inject.length === 0) return;
		const fleet = fleetSummary(plan.inject.length);
		const text = renderMail(plan.inject.map((m) => m.msg), {
			...(fleet !== lastInjectedFleet ? { fleet } : {}),
			...(plan.summary ? { deferred: plan.summary, hint: `全文用 sessions({id:"${sid8(selfSid)}", unread_full:true})` } : {}),
		});
		try {
			pi.sendUserMessage(text);
			lastInjectedFleet = fleet; // 只有成功投递才推进比较基线
			consumeMail(plan.inject.map((m) => m.file));
		} catch {
			try {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
				lastInjectedFleet = fleet;
				consumeMail(plan.inject.map((m) => m.file));
			} catch {
				/* 投递失败:文件不动,下次重试 */
			}
		}
		updateWidget();
	};

	// ---- widget:一行一个在跑的工人 + 未读数 ----

	const updateWidget = () => {
		let alive = false;
		try {
			alive = !!lastCtx?.hasUI;
		} catch {
			lastCtx = null;
		}
		if (!alive || !lastCtx) return;
		try {
			const now = Date.now();
			const all = allPresence(paths);
			const self = selfSid ? all.find((p) => p.sid === selfSid) : undefined;
			const mine = self ? all.filter((p) => p.kind === "agent" && inSessionList(paths, self, p, now)) : [];
			const running = mine.filter((p) => sessionState(p, now) === "running");
			// 回答四件事: 在做什么 / 多久没活动 / 是否在等我 / 本轮为什么结束。静默按 agent 自己的最近活动算, 不按宿主心跳。
			const lines = running.map((p) => {
				const dur = Math.round((now - p.born_at) / 1000);
				const idle = Math.round((now - (p.last_activity_at ?? p.heartbeat_at)) / 1000);
				const tool = p.current_tool ? ` · ${p.current_tool.name} ${Math.max(0, Math.round((now - p.current_tool.started_at) / 1000))}s` : "";
				return `▶ ${p.alias} ${sid8(p.sid)} ${dur < 60 ? `${dur}s` : `${Math.round(dur / 60)}m`} · ${p.stats.turns}t${cacheLabel(p.stats) ? ` · ${cacheLabel(p.stats)}` : ""}${tool}${idle > 30 ? ` · 静默${idle}s` : ""}`;
			});
			for (const p of mine.filter((x) => sessionState(x, now) === "dormant" && x.last_fact && x.last_fact !== "quiescent")) {
				lines.push(`${p.last_fact === "died" ? "✗" : "⏹"} ${p.alias} ${sid8(p.sid)} ${p.last_fact}${cacheLabel(p.stats) ? ` · ${cacheLabel(p.stats)}` : ""}${p.last_note ? ` · ${clip(p.last_note, 40)}` : ""}`);
			}
			const unread = selfSid ? pendingCount(paths, selfSid) : 0;
			if (unread > 0) lines.push(`✉ ${unread} 封未读(空闲时注入)`);
			lastCtx.ui.setWidget("mesh", lines.length > 0 ? lines : undefined);
			const dormant = mine.filter((p) => sessionState(p, now) === "dormant").length;
			lastCtx.ui.setStatus("mesh", running.length + unread > 0 || dormant > 0 ? `mesh ${running.length}▶${dormant > 0 ? ` ${dormant}⏸` : ""}${unread > 0 ? ` ${unread}✉` : ""}` : undefined);
		} catch {
			/* UI 不可用不影响内核 */
		}
	};

	// ---- 宿主守护进程:TUI 只负责"确保它活着" ----

	const ensure = () => ensureHostd(paths, EXT_DIR).then((r) => (r.status === "failed" ? { ok: false, error: r.error } : { ok: true }));

	const restartHostd = async (): Promise<string> => {
		const s = readHostdState(paths);
		if (s?.pid) {
			try {
				process.kill(s.pid, "SIGTERM");
			} catch {
				/* 已经不在了 */
			}
			const deadline = Date.now() + HOSTD_TERM_WAIT_MS;
			while (Date.now() < deadline && pidAlive(s.pid)) await new Promise((r) => setTimeout(r, 100));
			clearHostdState(paths);
		}
		const r = await ensureHostd(paths, EXT_DIR);
		return r.status === "failed" ? `宿主重启失败: ${r.error}` : `宿主已${r.status === "started" ? "换代" : "在运行"}(pid ${r.pid})`;
	};

	// ---- 初始化 ----

	function ensureInit(ctx: ExtensionContext): boolean {
		lastCtx = ctx;
		if (selfSid && kernel) return true;
		let sid: string;
		let file: string | undefined;
		try {
			sid = ctx.sessionManager.getSessionId();
			file = ctx.sessionManager.getSessionFile();
		} catch {
			return false;
		}
		ensureDirs(paths);
		selfSid = sid;
		selfAlias = registerSelf(paths, { sid, cwd: ctx.cwd, pid: process.pid, sessionFile: file, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined }).alias;
		if (isThinkingLevel(ctx.thinkingLevel)) patchPresence(paths, sid, { thinking_level: ctx.thinkingLevel });
		kernel = createKernel({
			paths,
			cap: MAX_RUNNING,
			selfSid: () => selfSid,
			resolveModel: makeResolveModel(() => lastCtx?.modelRegistry),
			nudgeSelf: scheduleInject,
			ensureHostd: ensure,
		});
		unwatchSelf = watchMailbox(paths, sid, scheduleInject);
		heartbeatTimer = setInterval(() => {
			if (selfSid) {
				patchPresence(paths, selfSid, {
					host_pid: process.pid,
					heartbeat_at: Date.now(),
					model: lastCtx?.model ? `${lastCtx.model.provider}/${lastCtx.model.id}` : undefined,
					...(isThinkingLevel(lastCtx?.thinkingLevel) ? { thinking_level: lastCtx!.thinkingLevel } : {}),
				});
			}
			updateWidget();
		}, HEARTBEAT_MS);
		heartbeatTimer.unref?.();
		sweepTimer = setInterval(() => {
			if (selfSid && pendingCount(paths, selfSid) > 0) scheduleInject();
			// 宿主看门: 有工人需要宿主(崩溃遗留 / 休眠但有值得唤醒的信)而宿主不在 → 拉起, 不等下一次 agent()/send()。
			const now = Date.now();
			const needHost = allPresence(paths).some(
				(p) =>
					p.kind === "agent" &&
					((p.host_pid !== undefined && p.host_pid !== process.pid && !pidAlive(p.host_pid) && !p.clean_exit) ||
						(!isLiveAgent(p, now) && listMail(paths, p.sid).some(({ msg }) => isWakeWorthy(msg)))),
			);
			if (needHost) void ensure();
			updateWidget();
		}, SWEEP_MS);
		sweepTimer.unref?.();
		scheduleInject(); // 隔夜投递:上线先 drain 自己的信箱
		updateWidget();
		return true;
	}

	// ---- 工具 ----

	for (const d of TOOL_DEFS) {
		pi.registerTool({
			name: d.verb,
			label: d.label,
			description: d.description,
			...(d.verb === "agent"
				? {
						promptSnippet: "agent/send/sessions/stop: 并行分身 —— agent 派活(讣告自动回报, 无需等待), send 指挥/续跑, sessions 看舰队, stop 强停",
						promptGuidelines: [
							"用 agent 将额外 token 换成更快的可靠交付: 并行推进、隔离上下文或改善判断。委派本身不是目标, 多个步骤也不等于多个独立工作面",
							"已决定通过 agent 并行的独立工作应同批派出。主会话可继续其他独立工作, 不重复已委派的范围; 没有可推进的工作时结束回合, 等待自动通知, 不轮询",
							"agent 的自述不是执行证据。按风险和证据缺口验收, 不因使用了 agent 就默认追加验收会话; 用户或项目明确要求的检查仍须执行",
						],
					}
				: {}),
			parameters: d.params,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!ensureInit(ctx) || !kernel || !selfSid) return { content: [{ type: "text", text: "mesh 未初始化(会话上下文不可用)" }], isError: true, details: undefined };
				const r = await kernel.execute(d.verb, selfSid, toKernelArgs(d.verb, (params ?? {}) as Record<string, unknown>));
				updateWidget();
				return { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: isToolError(r), details: r as never };
			},
		});
	}

	// ---- /mesh:全景文本总览(每行标出属于哪棵树)+ 宿主状态;/mesh restart 换代宿主 ----

	pi.registerCommand("mesh", {
		description: "mesh 全景: 谁在跑、在跑什么、宿主状态 (/mesh restart 换代宿主守护进程)",
		handler: async (args, ctx) => {
			if (!ensureInit(ctx) || !ctx.hasUI) return;
			if (typeof args === "string" && args.trim() === "restart") {
				ctx.ui.notify(await restartHostd(), "info");
				return;
			}
			const now = Date.now();
			const rows = allPresence(paths)
				.sort((a, b) => b.heartbeat_at - a.heartbeat_at)
				.map((p) => {
					const st = sessionState(p, now);
					const root = rootOf(paths, p);
					const tree = root === p.sid ? "" : ` ⟨${readPresence(paths, root)?.alias ?? sid8(root)}⟩`;
					const unread = pendingCount(paths, p.sid);
					return `${st === "dormant" ? "⏸" : st === "running" ? "▶" : "◉"} ${p.alias} ${sid8(p.sid)}${tree} [${p.kind}/${st}]${p.model ? ` ${p.model}` : ""} tok:${p.stats.tokens}${unread ? ` ✉${unread}` : ""}${p.last_note ? ` — ${clip(p.last_note, 48)}` : ""}${p.sid === selfSid ? " ←你" : ""}`;
				});
			ctx.ui.notify(`${rows.join("\n") || "(网络为空)"}\n\nroot: ${paths.root}\nagent 会话: ${MESH_SESSIONS_DIR}(pi --session <文件> 可接管)\n${hostdStatusLine(paths, EXT_DIR)}`, "info");
		},
	});

	// ---- 事件 ----

	pi.on("session_start", (_e, ctx) => {
		ensureInit(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		ensureInit(ctx);
		// 身份在本会话生命周期内固定;舰队计数只能进 user 注入,保护提示缓存前缀。
		const identity = `你的 mesh 身份: ${selfAlias}(${selfSid ? sid8(selfSid) : "?"})。`;
		return { systemPrompt: `${event.systemPrompt}\n\n${humanFacts}\n\n${identity}` };
	});

	// human 编排会话也采集同口径用量,让 sessions 深查能比较主会话与工人。
	pi.on("message_end", (event) => {
		if (!selfSid || event.message.role !== "assistant") return;
		const self = readPresence(paths, selfSid);
		if (self) patchPresence(paths, selfSid, { stats: addUsage(self.stats, event.message.usage) });
	});

	pi.on("agent_settled", (_e, ctx) => {
		lastCtx = ctx;
		flushInject();
		updateWidget();
	});

	pi.on("session_shutdown", () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (sweepTimer) clearInterval(sweepTimer);
		if (injectTimer) clearTimeout(injectTimer);
		heartbeatTimer = sweepTimer = injectTimer = null;
		injectDueAt = 0;
		unwatchSelf?.();
		unwatchSelf = null;
		if (selfSid) patchPresence(paths, selfSid, { host_pid: undefined, heartbeat_at: Date.now(), clean_exit: true });
		try {
			lastCtx?.ui.setWidget("mesh", undefined);
			lastCtx?.ui.setStatus("mesh", undefined);
		} catch {
			/* UI 已销毁 */
		}
	});
}

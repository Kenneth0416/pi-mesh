/**
 * kernel —— 四动词的执行语义(agent / send / sessions / stop)。
 *
 * `agent` 与 `send` 是同一条投递路径的两支(收件人尚不存在 / 已存在)。
 * human 会话的工具与寄宿 agent 的 customTools 共用这一个入口,只是 callerSid 不同。
 * 所有拒绝以错误载荷返回(不抛异常)。内核说 target/body,工具面说 to/message/task。
 *
 * 两种运行形态,同一份内核:
 * - TUI:没有 Host。spawn = 写 presence + 留出生信 + 确保 hostd 活着;send 给 dormant agent = 留信(hostd 的 watcher 会唤醒)。
 * - hostd:有 Host。spawn/wake 直接寄宿。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MeshMessage, MeshPaths, MessageIntent, NoticeFact, Presence, ToolError } from "./types.ts";
import { MAX_DEPTH, MESSAGE_INTENTS, PI_NATIVE_TOOLS, SID_SHORT_MIN, THINKING_LEVELS, TREE_MAX_LIVE, cacheHitPct, cacheLabel, normalizeTools, clip, isThinkingLevel, isToolError, sid8, thinkingForSpawn, toolError, uuidv7 } from "./types.ts";
import {
	allPresence,
	claimAlias,
	depthOf,
	humanRootOf,
	inSessionList,
	isLive,
	normalizeAlias,
	patchPresence,
	readPresence,
	resolveAlias,
	resolveTarget,
	rootOf,
	runningCount,
	sessionState,
	writePresence,
} from "./registry.ts";
import { listMail, newMessageId, pendingCount, sendMail } from "./mailbox.ts";
import { route } from "./deliver.ts";
import { gitHead, isGitRepo } from "./git.ts";
import type { Host } from "./host.ts";

export interface KernelOptions {
	paths: MeshPaths;
	/** 本进程的宿主;TUI 没有(只留信 + 确保 hostd)。 */
	host?: Host;
	cap: number;
	/** 本进程照看的 human 会话 sid(send 给它 = 走 own-inject 通道)。 */
	selfSid: () => string | undefined;
	/** 精确解析模型引用(fail-fast)。 */
	resolveModel: (ref: string) => { model: string } | { error: string };
	/** own mailbox 有新信时的回调(index 层调度注入)。 */
	nudgeSelf: () => void;
	/** 确保宿主守护进程活着(TUI 用;hostd 自己就是宿主,不需要)。 */
	ensureHostd?: () => Promise<{ ok: boolean; error?: string }>;
}

export type Verb = "agent" | "send" | "sessions" | "stop";
export const ALL_VERBS: Verb[] = ["agent", "send", "sessions", "stop"];

/** 能力即先验:深度到顶就不给 agent 动词。 */
export function verbsForDepth(depth: number): Verb[] {
	return depth < MAX_DEPTH ? [...ALL_VERBS] : ALL_VERBS.filter((v) => v !== "agent");
}

export function createKernel(opts: KernelOptions) {
	const { paths, host, cap } = opts;

	const caller = (sid: string) => readPresence(paths, sid);
	const callerTools = (c: Presence) => (c.kind === "human" ? PI_NATIVE_TOOLS : (c.tools ?? []));
	const running = () => runningCount(paths);

	/** 保留地址 creator 先于别名:直接读 started_by,不可能送错方向。 */
	function resolveFrom(c: Presence, target: string): { sid: string } | ToolError {
		const t = target.trim();
		if (/^(creator|starter)$/i.test(t)) {
			if (!c.started_by) return toolError("no_creator", "你是 human 会话, 没有创建者");
			const up = readPresence(paths, c.started_by);
			if (!up) return toolError("no_creator", `创建者 presence 已不在(${sid8(c.started_by)}), 用别名或短 id 寻址`);
			return { sid: up.sid };
		}
		const r = resolveTarget(paths, t, SID_SHORT_MIN);
		if ("error" in r) return toolError("unknown_target", r.error);
		return { sid: r.sid };
	}

	/** 树内计数:活跃数 + 累计 tokens(全部子孙;不含 root 自己)。 */
	function treeStats(c: Presence): { live: number; agents: number; tokens: number } {
		const root = rootOf(paths, c);
		const now = Date.now();
		let live = 0, agents = 0, tokens = 0;
		for (const x of allPresence(paths)) {
			if (x.kind !== "agent" || rootOf(paths, x) !== root) continue;
			agents++;
			if (isLive(x, now)) live++;
			tokens += x.stats.tokens;
		}
		return { live, agents, tokens };
	}

	// -------------------------------------------------------------------------
	// agent
	// -------------------------------------------------------------------------

	async function agent(callerSid: string, args: Record<string, unknown>): Promise<unknown> {
		const c = caller(callerSid);
		if (!c) return toolError("no_identity", `调用者 ${callerSid} 不在 registry(mesh 未初始化?)`);
		const depth = depthOf(paths, c);
		if (depth >= MAX_DEPTH) return toolError("refuse", `深度已达 ${MAX_DEPTH}: 你不能再派分身, 把需要并行的工作 send 给创建你的会话`);
		const live = treeStats(c).live;
		if (live >= TREE_MAX_LIVE) return toolError("tree_full", `树内活跃 ${live}/${TREE_MAX_LIVE}, 等讣告或 stop 一个再派`);
		const body = typeof args.body === "string" ? args.body : "";
		if (body.trim().length === 0) return toolError("invalid_params", "task 不能为空: 写清楚要它做什么、什么算完成");
		if (running() >= cap) return toolError("cap_full", `并发已满(${cap}), 先等讣告或 stop 一个再派`);

		// 工具:委派不得提权。
		const mine = callerTools(c);
		const tools = normalizeTools(Array.isArray(args.tools) ? (args.tools as string[]) : mine);
		for (const t of tools) {
			if (!PI_NATIVE_TOOLS.includes(t)) return toolError("unknown_tool", `未知工具 "${t}"。可授予: ${PI_NATIVE_TOOLS.join(", ")}`);
			if (!mine.includes(t)) return toolError("escalation", `工具 "${t}" 不在你自己的白名单内, 委派不得提权。你有: ${mine.join(", ")}`);
		}
		// 模型与推理等级。
		let model = c.model;
		const explicitModel = typeof args.model === "string" && args.model.trim().length > 0;
		if (explicitModel) {
			const m = opts.resolveModel((args.model as string).trim());
			if ("error" in m) return toolError("unknown_model", m.error);
			model = m.model;
		}
		if (args.thinking !== undefined && !isThinkingLevel(args.thinking)) return toolError("invalid_params", `thinking 只能是 ${THINKING_LEVELS.join(" | ")}`);
		const thinking = thinkingForSpawn({ explicit: isThinkingLevel(args.thinking) ? args.thinking : undefined, modelExplicit: explicitModel, callerLevel: c.thinking_level });
		// cwd。
		let cwd = c.cwd;
		if (typeof args.cwd === "string" && args.cwd.trim()) {
			cwd = path.resolve(args.cwd.trim());
			if (!fs.existsSync(cwd)) return toolError("bad_cwd", `cwd 不存在: ${cwd}`);
		}
		// timebox:只有声明了才有。
		let timeboxMs: number | undefined;
		if (args.timebox_min !== undefined) {
			const n = Number(args.timebox_min);
			if (!Number.isFinite(n) || n <= 0) return toolError("invalid_params", "timebox_min 必须是正数(分钟)");
			timeboxMs = Math.round(n * 60_000);
		}
		// alias:显式必须抢注成功;缺省自动。
		const sidPlaceholder = `pending-${Date.now().toString(36)}`;
		const explicitAlias = typeof args.alias === "string" && args.alias.trim() ? normalizeAlias(args.alias.trim()) : undefined;
		let alias: string;
		if (explicitAlias) {
			if (!claimAlias(paths, explicitAlias, sidPlaceholder)) return toolError("alias_taken", `别名 "${explicitAlias}" 已被 ${sid8(resolveAlias(paths, explicitAlias) ?? "?")} 占用`);
			alias = explicitAlias;
		} else alias = autoWorkerAlias(paths, c.alias, sidPlaceholder);

		const now = Date.now();
		const baseOid = isGitRepo(cwd) ? gitHead(cwd) : undefined;
		const pres: Presence = {
			sid: uuidv7(),
			alias,
			kind: "agent",
			cwd,
			model,
			thinking_level: thinking,
			tools,
			depth: depth + 1,
			started_by: c.sid,
			born_at: now,
			heartbeat_at: now,
			stats: { tokens: 0, turns: 0 },
			task_started_at: now,
			...(timeboxMs ? { timebox_ms: timeboxMs } : {}),
			...(baseOid ? { base_oid: baseOid } : {}),
		};
		const birth: MeshMessage = { id: newMessageId(), from: c.sid, from_alias: c.alias, to: pres.sid, at: now, kind: "message", body };

		const notes: string[] = [];
		if (host) {
			const r = await host.spawn(pres, birth);
			if ("error" in r) {
				releaseAliasPlaceholder(paths, alias, sidPlaceholder);
				return toolError("spawn_failed", r.error);
			}
		} else {
			writePresence(paths, pres);
			sendMail(paths, birth);
			const ens = (await opts.ensureHostd?.()) ?? { ok: false, error: "本进程没有宿主启动器" };
			if (!ens.ok) notes.push(`宿主未能启动(${ens.error ?? "未知原因"}), 消息留箱, 稍后 sweep 补投`);
		}
		rebind(paths, alias, pres.sid);

		const ts = treeStats(c);
		notes.push(`本树活跃 ${ts.live}/${TREE_MAX_LIVE}, 累计 ${ts.agents} 个 agent / ${fmtK(ts.tokens)} tok`);
		if (!explicitModel) notes.push(`未指定 model: 同型分身(${model ?? "会话默认"}), 推理 ${thinking}; 要独立视角就换 provider`);
		return {
			delivered: "created",
			session_id: sid8(pres.sid),
			alias,
			model: model ?? "(会话默认)",
			thinking,
			tools,
			...(timeboxMs ? { timebox_min: Math.round(timeboxMs / 60_000) } : {}),
			note: `完成/死亡/停滞时你会收到 system 讣告(附 git 事实); sessions() 看你派出的子树; ${notes.join("; ")}`,
		};
	}

	// -------------------------------------------------------------------------
	// send
	// -------------------------------------------------------------------------

	async function send(callerSid: string, args: Record<string, unknown>): Promise<unknown> {
		const c = caller(callerSid);
		if (!c) return toolError("no_identity", `调用者 ${callerSid} 不在 registry(mesh 未初始化?)`);
		const target = typeof args.target === "string" ? args.target.trim() : "";
		const body = typeof args.body === "string" ? args.body : "";
		if (!target) return toolError("invalid_params", 'to 必填: 会话名字、短 id 或 "creator"');
		if (body.trim().length === 0) return toolError("invalid_params", "message 不能为空");
		if (target === "new") return toolError("use_agent_tool", "创建新 agent 请用 agent 工具;send 只对已有会话说话");

		let intent: MessageIntent | undefined;
		if (args.intent !== undefined) {
			if (typeof args.intent !== "string" || !(MESSAGE_INTENTS as string[]).includes(args.intent)) return toolError("invalid_params", `intent 只能是 ${MESSAGE_INTENTS.join(" | ")}`);
			intent = args.intent as MessageIntent;
		}
		const r = resolveFrom(c, target);
		if (isToolError(r)) return r;
		const pres = readPresence(paths, r.sid);
		if (!pres) return toolError("unknown_target", `名字解析到 ${r.sid} 但 presence 缺失`);
		// 树的边界:agent 只能跟自己这棵树的人说话。
		if (c.kind === "agent" && pres.kind === "human" && humanRootOf(paths, c) !== pres.sid) {
			return toolError("foreign_human", '不能给别的方向的人会话写信; 给你的创建者用 to:"creator"');
		}
		const timeboxMin = args.timebox_min !== undefined ? Number(args.timebox_min) : undefined;
		if (timeboxMin !== undefined && (!Number.isFinite(timeboxMin) || timeboxMin <= 0)) return toolError("invalid_params", "timebox_min 必须是正数(分钟)");
		const notes: string[] = [];
		if (timeboxMin !== undefined) {
			if (pres.kind !== "agent") return toolError("refuse", "时限只能设给 agent 会话");
			if (c.kind !== "human" && pres.started_by !== c.sid) return toolError("refuse", "时限只能由它的创建者或人设定");
			const used = Date.now() - (pres.task_started_at ?? Date.now());
			patchPresence(paths, pres.sid, { timebox_ms: used + timeboxMin * 60_000, timebox_level: 0 });
			notes.push(`时限已重设: 从现在起 ${timeboxMin} 分钟`);
		}

		const msg: MeshMessage = {
			id: newMessageId(),
			from: c.sid,
			from_alias: c.alias,
			to: pres.sid,
			at: Date.now(),
			kind: "message",
			body,
			...(intent && intent !== "report" ? { intent } : {}),
		};
		const decision = route({
			target: pres,
			hostedHere: pres.sid === opts.selfSid() || Boolean(host?.isHosted(pres.sid)),
			live: isLive(pres, Date.now()),
			running: running(),
			cap,
			canHost: Boolean(host),
			intent,
		});
		sendMail(paths, msg);
		host?.recordSend(msg);
		const to = { alias: pres.alias, sid: sid8(pres.sid) };
		const done = (delivered: string, note?: string) => {
			const all = [note, ...notes].filter((x): x is string => Boolean(x));
			return { delivered, to, ...(intent ? { intent } : {}), ...(all.length ? { note: all.join("; ") } : {}) };
		};
		switch (decision.action) {
			case "steer_local":
				if (pres.sid === opts.selfSid()) {
					opts.nudgeSelf();
					return done("queued", "已入你自己的信箱, 下一回合注入");
				}
				return done("steered", "运行中, 下一推理边界注入");
			case "mailbox":
				return done("mailboxed", decision.note ?? (pres.kind === "human" && intent !== "blocker" ? "对方在线; 汇报类消息在它空闲时合批注入(不打断它推理)" : "对方进程在线, watcher 秒级注入"));
			case "defer":
				return done("mailboxed", decision.note);
			case "nudge": {
				const ens = (await opts.ensureHostd?.()) ?? { ok: false, error: "本进程没有宿主启动器" };
				return done(ens.ok ? "nudged" : "mailboxed", ens.ok ? "宿主会唤醒它, 消息作为它的输入" : `宿主未能启动(${ens.error}), 消息留箱, 稍后补投`);
			}
			case "wake": {
				const w = await host!.wake(pres.sid);
				if (w === "woken" || w === "already") return done("woken", "已唤醒, 消息作为它的输入");
				if (w === "defer_batch") return done("mailboxed", "等待短窗合批唤醒, 窗口内新信会一并注入; blocker 或人的工作信立即唤醒");
				if (w === "defer_cap") return done("mailboxed", "并发已满, 滞留邮箱, 槽位释放后自动补投");
				if (w === "defer_throttle") return done("mailboxed", "该会话被限频(唤醒过密), 消息已留箱, 窗口滑过自动恢复");
				if (w === "defer_shutdown") return done("mailboxed", "宿主进程正在退出, 消息已留箱, 下次上线补投");
				return done("mailboxed", `唤醒失败(${w.error}), 消息留箱`);
			}
		}
	}

	// -------------------------------------------------------------------------
	// sessions
	// -------------------------------------------------------------------------

	const timeboxLeft = (p: Presence, now: number) => (p.timebox_ms && p.task_started_at ? Math.round((p.task_started_at + p.timebox_ms - now) / 1000) : undefined);

	function sessions(callerSid: string, args: Record<string, unknown>): unknown {
		const now = Date.now();
		const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
		if (!id) {
			const viewer = readPresence(paths, callerSid);
			const rows = allPresence(paths)
				.map((p) => ({ p, state: sessionState(p, now) }))
				.filter(({ p }) => (viewer ? inSessionList(paths, viewer, p, now) : p.sid === callerSid))
				.sort((a, b) => (a.state === "dormant" ? 1 : 0) - (b.state === "dormant" ? 1 : 0) || b.p.heartbeat_at - a.p.heartbeat_at)
				.map(({ p, state }) => ({
					alias: p.alias,
					sid: sid8(p.sid),
					kind: p.kind,
					state,
					...(p.sid === callerSid ? { self: true } : {}),
					...(p.started_by ? { started_by: readPresence(paths, p.started_by)?.alias ?? sid8(p.started_by) } : {}),
					model: p.model,
					...(p.thinking_level ? { thinking: p.thinking_level } : {}),
					cwd: p.cwd,
					tokens: p.stats.tokens,
					...(cacheHitPct(p.stats) !== undefined ? { cache_pct: cacheHitPct(p.stats), cache: cacheLabel(p.stats, true) } : {}),
					age_s: Math.round((now - p.born_at) / 1000),
					idle_s: Math.round((now - p.heartbeat_at) / 1000),
					unread: pendingCount(paths, p.sid),
					...(timeboxLeft(p, now) !== undefined ? { timebox_left_s: timeboxLeft(p, now) } : {}),
					...(state === "dormant" && p.kind === "agent" ? { last_fact: factMark(p.last_fact) } : {}),
					...(p.last_note ? { last: p.last_note } : {}),
				}));
			const ts = viewer ? treeStats(viewer) : undefined;
			return {
				sessions: rows,
				running: running(),
				cap,
				scope: viewer?.alias,
				scope_mode: "subtree",
				...(ts ? { tree: { live: ts.live, max_live: TREE_MAX_LIVE, agents: ts.agents, tokens: ts.tokens } } : {}),
			};
		}
		const me = readPresence(paths, callerSid);
		const r = me ? resolveFrom(me, id) : resolveTarget(paths, id, SID_SHORT_MIN);
		if (isToolError(r)) return r;
		if ("error" in r) return toolError("unknown_target", r.error);
		const p = readPresence(paths, r.sid);
		if (!p) return toolError("unknown_target", `presence 缺失: ${r.sid}`);
		const full = args.unread_full === true;
		return {
			alias: p.alias,
			sid: p.sid,
			kind: p.kind,
			state: sessionState(p, now),
			model: p.model,
			...(p.thinking_level ? { thinking: p.thinking_level } : {}),
			cwd: p.cwd,
			tools: p.tools,
			started_by: p.started_by ? (readPresence(paths, p.started_by)?.alias ?? sid8(p.started_by)) : undefined,
			born_at: new Date(p.born_at).toISOString(),
			stats: p.stats,
			...(cacheHitPct(p.stats) !== undefined ? { cache_pct: cacheHitPct(p.stats), cache: cacheLabel(p.stats, true) } : {}),
			...(p.current_tool ? { current_tool: { name: p.current_tool.name, running_s: Math.round((now - p.current_tool.started_at) / 1000) } } : {}),
			...(p.timebox_ms ? { timebox_min: Math.round(p.timebox_ms / 60_000), timebox_left_s: timeboxLeft(p, now) } : {}),
			...(p.base_oid ? { base_oid: p.base_oid } : {}),
			session_file: p.session_file,
			children: allPresence(paths)
				.filter((x) => x.started_by === p.sid)
				.map((x) => `${x.alias}(${sid8(x.sid)})[${sessionState(x, now)}]`),
			unread: listMail(paths, p.sid)
				.slice(0, full ? 30 : 10)
				.map(({ msg }) => ({
					id: msg.id,
					from: msg.from === "system" ? "system" : (readPresence(paths, msg.from)?.alias ?? sid8(msg.from)),
					kind: msg.kind,
					...(msg.intent ? { intent: msg.intent } : {}),
					...(msg.fact ? { fact: msg.fact } : {}),
					body: full ? msg.body : clip(msg.body, 120),
				})),
			last_output: p.session_file ? (readLastAssistantText(p.session_file) ?? p.last_note) : p.last_note,
			hint: p.kind === "agent" ? "send(alias, 消息) 可续问/追加指令(dormant 会被唤醒); pi --session <session_file> 可人工接管" : undefined,
		};
	}

	// -------------------------------------------------------------------------
	// stop
	// -------------------------------------------------------------------------

	function stop(callerSid: string, args: Record<string, unknown>): unknown {
		const c = caller(callerSid);
		if (!c) return toolError("no_identity", `调用者 ${callerSid} 不在 registry`);
		const target = typeof args.target === "string" ? args.target.trim() : "";
		if (!target) return toolError("invalid_params", "target 必填");
		const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : `被 ${c.alias} 停止`;
		const r = resolveFrom(c, target);
		if (isToolError(r)) return r;
		const p = readPresence(paths, r.sid);
		if (!p) return toolError("unknown_target", `presence 缺失: ${r.sid}`);
		if (p.kind === "human") return toolError("refuse", "不能 stop human 会话(那是人的终端)");
		if (p.sid === callerSid) return toolError("refuse", "不必 stop 自己 —— 结束回合即归于安静");
		if (host?.stopLocal(p.sid, reason)) return { stopped: p.alias, note: "已中止; 会话文件保留, send 一条消息可再唤醒" };
		if (isLive(p, Date.now())) {
			sendMail(paths, { id: newMessageId(), from: c.sid, from_alias: c.alias, to: p.sid, at: Date.now(), kind: "control", body: "stop", data: { reason } });
			return { control_sent: p.alias, note: "对方在宿主进程运行, 停止指令已送达" };
		}
		return { noop: p.alias, note: "本就休眠, 无循环可停" };
	}

	async function execute(verb: Verb, callerSid: string, args: Record<string, unknown>): Promise<unknown> {
		switch (verb) {
			case "agent":
				return agent(callerSid, args);
			case "send":
				return send(callerSid, args);
			case "sessions":
				return sessions(callerSid, args);
			case "stop":
				return stop(callerSid, args);
		}
	}

	return { execute, agent, send, sessions, stop };
}

export type Kernel = ReturnType<typeof createKernel>;

function factMark(fact?: NoticeFact): string {
	return fact === "quiescent" ? "✓ quiescent" : fact === "died" ? "✗ died" : fact === "stopped" ? "⏹ stopped" : "⏸ 无终局";
}

function fmtK(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function autoWorkerAlias(paths: MeshPaths, base: string, placeholder: string): string {
	for (let n = 1; n < 1000; n++) {
		const candidate = n === 1 ? `${base}-a` : `${base}-a${n}`;
		if (claimAlias(paths, candidate, placeholder)) return candidate;
	}
	return placeholder;
}

function releaseAliasPlaceholder(paths: MeshPaths, alias: string, placeholder: string): void {
	if (resolveAlias(paths, alias) === placeholder) {
		try {
			fs.unlinkSync(path.join(paths.names, normalizeAlias(alias)));
		} catch {
			/* 已清 */
		}
	}
}

function rebind(paths: MeshPaths, alias: string, sid: string): void {
	try {
		fs.writeFileSync(path.join(paths.names, normalizeAlias(alias)), sid);
	} catch {
		/* names 目录损坏也不阻塞 spawn */
	}
}

/** 从落盘会话文件尾部读最后一条助手输出(dormant 会话的深查)。 */
export function readLastAssistantText(sessionFile: string, maxBytes = 512 * 1024): string | undefined {
	let raw: string;
	try {
		const stat = fs.statSync(sessionFile);
		const fd = fs.openSync(sessionFile, "r");
		try {
			const start = Math.max(0, stat.size - maxBytes);
			const buf = Buffer.alloc(stat.size - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			raw = buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		try {
			const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
			if (e.type !== "message" || e.message?.role !== "assistant") continue;
			const content = e.message.content;
			if (typeof content === "string" && content.trim()) return clip(content, 3000);
			if (Array.isArray(content)) {
				const text = content
					.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? ((c as { text?: string }).text ?? "") : ""))
					.filter((t) => t.trim().length > 0)
					.join("\n");
				if (text.trim()) return clip(text, 3000);
			}
		} catch {
			/* 半行 */
		}
	}
	return undefined;
}

/**
 * host —— 宿主引擎:在本进程里为 agent 会话跑循环(只有 mesh-hostd 构造它)。
 *
 * - spawn/wake:开真 pi 会话 → drain 邮箱作为 prompt → 循环;
 * - 运行中收信 → steer(下一推理边界注入);control stop 即时中止;
 * - consume-on-observe:只有在 user message 里观察到消息 id 才 unlink 文件(at-least-once);
 * - 通知律:quiescent(附最后输出 + workspace 事实)/died/stopped/stalled/timebox,以 system 名义发给创建者;
 * - 429:同模型退避三次;仍失败 → died 附尝试记录(换不换模型由创建者定);
 * - sweep:崩溃复活(host_pid 已死的 agent 重新托管)+ 滞留邮件补投(工作消息, 以及子代 quiescent/died 讣告 —— 派完结束回合的 agent 创建者靠它被唤醒)。
 *
 * 引擎与 pi 解耦:通过 SessionFactory 注入,测试用 FakeSession 驱动全部路径。
 */

import type { MeshMessage, MeshPaths, NoticeFact, Presence, SessionStats, SessionUsage, ThinkingLevel } from "./types.ts";
import { CAPACITY_BACKOFF_MS, NOTE_CAP, QUIESCENT_FOLD_MS, STALL_MS, TIMEBOX_GRACE, WAKE_BATCH_MS, addUsage, normalizeStats, clip, firstLine, isCapacityError, isUrgentIntent, isWakeWorthy, sid8, takeWakeBudget } from "./types.ts";
import { allPresence, isLive, patchPresence, pidAlive, readPresence, runningCount, writePresence } from "./registry.ts";
import { consumeMail, listMail, newMessageId, pendingBySid, planInjection, renderMail, sendMail, watchMailbox } from "./mailbox.ts";
import { observeWorkspace } from "./git.ts";

// ---------------------------------------------------------------------------
// 引擎接口(pi AgentSession 的最小投影;测试注 Fake)
// ---------------------------------------------------------------------------

export interface SessionEvent {
	type: string;
	/** agent_end 专属:pi 的内层退避还会不会再试(willRetry=false 才是"这轮真的失败了")。 */
	willRetry?: boolean;
	toolName?: string;
	message?: {
		role?: string;
		content?: unknown;
		usage?: SessionUsage;
		stopReason?: string;
		errorMessage?: string;
	};
}

export interface SessionHandle {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): void;
	dispose(): void;
	subscribe(cb: (e: SessionEvent) => void): () => void;
	getLastAssistantText(): string | undefined;
}

export interface SpawnSpec {
	cwd: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools: string[];
	depth?: number;
}

export interface SessionFactory {
	/** 以指定 sid 新建会话(presence 已由 kernel 写好)。 */
	create(spec: SpawnSpec, sid?: string): Promise<{ handle: SessionHandle; sid: string; sessionFile?: string }>;
	/** 打开既有会话;presence 无 session_file 时以 create({id}) 新建并回传路径。 */
	open(pres: Presence): Promise<{ handle: SessionHandle; sessionFile?: string }>;
}

/** 交接信(不是讣告):宿主换代/崩溃复活时投到工人自己的信箱,下一任宿主见 message 即唤醒。 */
export function handoverBody(reason: string): string {
	return `[mesh] ${reason}, 已重新托管; 上一动作可能半执行, 先核实副作用再继续`;
}

export interface HostOptions {
	paths: MeshPaths;
	factory: SessionFactory;
	pid: number;
	cap: number;
	stallMs?: number;
	/** 唤醒合并窗;测试可设 0,生产缺省 WAKE_BATCH_MS。 */
	wakeBatchMs?: number;
	capacityBackoffMs?: number[];
	onChange?: () => void;
	/** 崩溃复活用:确保宿主守护进程活着(hostd 自己 = 恒 ok)。 */
	ensureHostd?: () => Promise<{ ok: boolean; error?: string }>;
}

interface Vitals {
	elapsed_s: number;
	tokens: number;
	turns: number;
	current_tool?: { name: string; running_s: number };
}

interface HostedLoop {
	sid: string;
	alias: string;
	handle: SessionHandle;
	unsub: () => void;
	unwatch: () => void;
	awaiting: Map<string, string>;
	observed: Set<string>;
	aborted?: { reason: string };
	shutdownNotified?: boolean;
	handover?: boolean;
	delivered: boolean;
	lastStop?: string;
	lastError?: string;
	lastWillRetry?: boolean;
	/** 本轮最后一封发给创建者的 send;对方读走后仍可去重。 */
	lastReport?: MeshMessage;
	attempts: string[];
	backoffCancel?: () => void;
	lastActivity: number;
	stallLevel: number;
	currentTool?: { name: string; startedAt: number };
	/** 会话累计用量跨唤醒保留;tokens/turns 仍是本次运行的体征。 */
	stats: SessionStats;
	tokens: number;
	turns: number;
	startedAt: number;
	poll?: ReturnType<typeof setInterval>;
}

export type WakeResult = "woken" | "already" | "defer_cap" | "defer_batch" | "defer_throttle" | "defer_shutdown" | { error: string };

export interface HostedSnapshot {
	sid: string;
	alias: string;
	tokens: number;
	turns: number;
	startedAt: number;
	lastActivity: number;
	currentTool?: { name: string; startedAt: number };
}

/** 通知文案表:一种事实一行。 */
const FACT_TEXT: Record<NoticeFact, (alias: string, reason: string | undefined) => string> = {
	quiescent: (a) => `${a} 归于安静 —— 这只是停止说话的物理事实, 不等于任务完成; 最后输出见 data.last_output(重复汇报仅附 data.related_message_id), git 事实见 data.workspace, 采信前按需验收`,
	died: (a, r) => `${a} 异常终止: ${r}`,
	stopped: (a, r) => `${a} 被停止: ${r}`,
	stalled: (a, r) => `${a} ${r}(仍在运行, 不会被自动终止; 现场见 data, 可 send 问它, 确认没救再 stop)`,
	timebox: (a, r) => `${a} ${r}(未强停; 它已收到自检信要求收尾提交并报告; 要给时间用 send(timebox_min))`,
	workspace: (a, r) => `${a} ${r}(只报告不处置)`,
};

// ---------------------------------------------------------------------------

export class Host {
	private paths: MeshPaths;
	private factory: SessionFactory;
	private pid: number;
	private cap: number;
	private stallMs: number;
	private backoff: number[];
	private onChange: () => void;
	private ensureHostdFn: (() => Promise<{ ok: boolean; error?: string }>) | undefined;
	private hosted = new Map<string, HostedLoop>();
	private waking = new Set<string>();
	private wakeBatchMs: number;
	private wakeBatches = new Map<string, { until: number; timer: ReturnType<typeof setTimeout> }>();
	private shuttingDown = false;

	constructor(opts: HostOptions) {
		this.paths = opts.paths;
		this.factory = opts.factory;
		this.pid = opts.pid;
		this.cap = opts.cap;
		this.stallMs = opts.stallMs ?? STALL_MS;
		this.wakeBatchMs = opts.wakeBatchMs ?? WAKE_BATCH_MS;
		this.backoff = opts.capacityBackoffMs?.length ? [...opts.capacityBackoffMs] : [...CAPACITY_BACKOFF_MS];
		this.ensureHostdFn = opts.ensureHostd;
		const onChange = opts.onChange ?? (() => {});
		this.onChange = () => {
			try {
				onChange();
			} catch {
				/* 装饰失败,内核照跑 */
			}
		};
	}

	isHosted(sid: string): boolean {
		return this.hosted.has(sid);
	}

	hostedCount(): number {
		return this.hosted.size;
	}

	snapshot(): HostedSnapshot[] {
		return [...this.hosted.values()].map((l) => ({
			sid: l.sid,
			alias: l.alias,
			tokens: l.tokens,
			turns: l.turns,
			startedAt: l.startedAt,
			lastActivity: l.lastActivity,
			...(l.currentTool ? { currentTool: { ...l.currentTool } } : {}),
		}));
	}

	lastTextOf(sid: string): string | undefined {
		const loop = this.hosted.get(sid);
		return loop ? safeLastText(loop.handle) : undefined;
	}

	runningCount(): number {
		return runningCount(this.paths);
	}

	// -------------------------------------------------------------------------
	// spawn / wake
	// -------------------------------------------------------------------------

	async spawn(pres: Presence, birth: MeshMessage): Promise<{ sid: string } | { error: string }> {
		if (this.shuttingDown) return { error: "宿主进程正在退出" };
		if (runningCount(this.paths) >= this.cap) return { error: `并发已满(${this.cap}), 先等讣告或 stop 一个再派` };
		let created: { handle: SessionHandle; sid: string; sessionFile?: string };
		try {
			created = await this.factory.create({ cwd: pres.cwd, model: pres.model, thinkingLevel: pres.thinking_level, tools: pres.tools ?? [], depth: pres.depth }, pres.sid);
		} catch (err) {
			return { error: `创建会话失败: ${err instanceof Error ? err.message : String(err)}` };
		}
		// 工厂可能没接受指定 sid(测试用 Fake):以工厂返回的 sid 为准。
		const live: Presence = { ...pres, sid: created.sid, session_file: created.sessionFile, host_pid: this.pid, heartbeat_at: Date.now() };
		writePresence(this.paths, live);
		sendMail(this.paths, { ...birth, to: created.sid });
		this.runLoop(live, created.handle);
		return { sid: created.sid };
	}

	async wake(sid: string): Promise<WakeResult> {
		if (this.shuttingDown) return "defer_shutdown";
		if (this.hosted.has(sid) || this.waking.has(sid)) return "already";
		const pres = readPresence(this.paths, sid);
		if (!pres) return { error: `unknown sid ${sid}` };
		if (pres.kind !== "agent") return { error: "human 会话不能被唤醒" };
		if (isLive(pres, Date.now())) return "already";
		const mail = listMail(this.paths, sid).filter(({ msg }) => isWakeWorthy(msg));
		const immediate = mail.some(({ msg }) => isUrgentIntent(msg.intent) || readPresence(this.paths, msg.from)?.kind === "human");
		if (mail.length && !immediate && this.wakeBatchMs > 0) {
			let batch = this.wakeBatches.get(sid);
			if (!batch) {
				// 固定窗口而非静默去抖:持续来信也不会无限推迟;到点重新读箱,不缓存信件快照。
				const until = Date.now() + this.wakeBatchMs;
				const timer = setTimeout(() => {
					void this.sweep().catch(() => {
						/* 信仍留箱,由下一次巡检重试。 */
					});
				}, this.wakeBatchMs);
				timer.unref?.();
				batch = { until, timer };
				this.wakeBatches.set(sid, batch);
			}
			if (Date.now() < batch.until) return "defer_batch";
		}
		if (runningCount(this.paths) >= this.cap) return "defer_cap";
		if (!this.wakeAllowed(pres)) return "defer_throttle";
		this.clearWakeBatch(sid);
		this.waking.add(sid);
		try {
			let opened: { handle: SessionHandle; sessionFile?: string };
			try {
				opened = await this.factory.open(pres);
			} catch (err) {
				this.notice(pres, "died", `唤醒失败: ${err instanceof Error ? err.message : String(err)}`);
				return { error: `唤醒失败: ${err instanceof Error ? err.message : String(err)}` };
			}
			// open 在途时也可能收到宿主退出;不再启动新循环。
			if (this.shuttingDown) {
				opened.handle.dispose();
				return "defer_shutdown";
			}
			patchPresence(this.paths, sid, {
				host_pid: this.pid,
				heartbeat_at: Date.now(),
				clean_exit: false,
				last_fact: undefined,
				...(opened.sessionFile && opened.sessionFile !== pres.session_file ? { session_file: opened.sessionFile } : {}),
			});
			this.runLoop(readPresence(this.paths, sid) ?? pres, opened.handle);
			return "woken";
		} finally {
			this.waking.delete(sid);
		}
	}

	private clearWakeBatch(sid: string): void {
		const batch = this.wakeBatches.get(sid);
		if (batch) clearTimeout(batch.timer);
		this.wakeBatches.delete(sid);
	}

	/** send 落盘后记录,不依赖创建者是否已消费邮件。 */
	recordSend(msg: MeshMessage): void {
		const loop = this.hosted.get(msg.from);
		if (loop && msg.kind === "message" && msg.to === readPresence(this.paths, msg.from)?.started_by) loop.lastReport = msg;
	}

	/** wake 预算:只有 agent 互发的 message 计频;全是讣告 → 放行不计;有人的消息 → 放行且清窗。 */
	private wakeAllowed(pres: Presence): boolean {
		const mail = listMail(this.paths, pres.sid).filter(({ msg }) => msg.kind !== "control");
		if (mail.some(({ msg }) => readPresence(this.paths, msg.from)?.kind === "human")) {
			if (pres.wake_log?.length) patchPresence(this.paths, pres.sid, { wake_log: [] });
			return true;
		}
		if (mail.every(({ msg }) => msg.kind === "notice")) return true;
		const b = takeWakeBudget(pres.wake_log);
		patchPresence(this.paths, pres.sid, { wake_log: b.log });
		return b.ok;
	}

	// -------------------------------------------------------------------------
	// 主循环
	// -------------------------------------------------------------------------

	private runLoop(pres: Presence, handle: SessionHandle): void {
		const loop: HostedLoop = {
			sid: pres.sid,
			alias: pres.alias,
			handle,
			unsub: () => {},
			unwatch: () => {},
			awaiting: new Map(),
			observed: new Set(),
			delivered: false,
			attempts: [],
			lastActivity: Date.now(),
			stallLevel: 0,
			stats: normalizeStats(pres.stats),
			tokens: 0,
			turns: 0,
			startedAt: Date.now(),
		};
		this.hosted.set(pres.sid, loop);
		loop.unsub = handle.subscribe((e) => {
			loop.lastActivity = Date.now();
			loop.stallLevel = 0;
			if (e.type === "tool_execution_start") {
				loop.currentTool = { name: e.toolName ?? "?", startedAt: Date.now() };
				return;
			}
			if (e.type === "tool_execution_end") {
				loop.currentTool = undefined;
				return;
			}
			if (e.type === "agent_end") {
				if (typeof e.willRetry === "boolean") loop.lastWillRetry = e.willRetry;
				return;
			}
			const msg = e.message;
			if (e.type !== "message_end" || !msg) return;
			if (msg.role === "assistant") {
				loop.turns++;
				if (msg.usage?.totalTokens) loop.tokens += msg.usage.totalTokens;
				loop.stats = addUsage(loop.stats, msg.usage);
				loop.lastStop = msg.stopReason;
				loop.lastError = msg.errorMessage;
				return;
			}
			if (msg.role === "user") {
				const text = contentToText(msg.content);
				for (const [id, file] of loop.awaiting) {
					if (text.includes(id)) {
						loop.awaiting.delete(id);
						loop.observed.add(id);
						consumeMail([file]);
					}
				}
			}
		});
		loop.unwatch = watchMailbox(this.paths, pres.sid, () => this.onHostedMail(loop));
		loop.poll = setInterval(() => this.onHostedMail(loop), 1_000);
		loop.poll.unref?.();
		void this.drive(loop, pres);
	}

	/** 运行中新邮件:control 即时执行;其余 steer 到下一推理边界。 */
	private onHostedMail(loop: HostedLoop): void {
		for (const { file, msg } of listMail(this.paths, loop.sid)) {
			if (msg.kind === "control") {
				consumeMail([file]);
				if (msg.body === "stop") this.abortLoop(loop, msg.data?.reason ?? "被 stop");
				continue;
			}
			if (loop.awaiting.has(msg.id) || loop.observed.has(msg.id)) continue;
			loop.awaiting.set(msg.id, file);
			void loop.handle.steer(renderMail([msg])).catch(() => {
				/* steer 失败(会话已 settle):文件仍在,复查轮会带上它 */
			});
		}
		this.onChange();
	}

	private async drive(loop: HostedLoop, pres: Presence): Promise<void> {
		let round = 0;
		let crashed: string | undefined;
		try {
			for (;;) {
				if (loop.aborted) break;
				const fresh: Array<{ file: string; msg: MeshMessage }> = [];
				for (const { file, msg } of listMail(this.paths, loop.sid)) {
					if (msg.kind === "control") {
						consumeMail([file]);
						if (msg.body === "stop") this.abortLoop(loop, msg.data?.reason ?? "被 stop");
						continue;
					}
					if (loop.observed.has(msg.id)) continue;
					fresh.push({ file, msg });
				}
				const plan = planInjection(fresh, Number.MAX_SAFE_INTEGER);
				for (const m of plan.drop) loop.awaiting.delete(m.msg.id);
				consumeMail(plan.drop.map((m) => m.file));
				const toDeliver: MeshMessage[] = [];
				for (const { file, msg } of plan.inject) {
					loop.awaiting.set(msg.id, file);
					toDeliver.push(msg);
				}
				if (loop.aborted) break;
				if (toDeliver.length === 0) break; // 归于安静
				loop.delivered = true;
				const identity = round === 0 ? `${this.identityHeader(loop, readPresence(this.paths, loop.sid) ?? pres)}\n\n` : "";
				await this.promptOnce(loop, identity + renderMail(toDeliver));
				round++;
				if (loop.aborted) break;
				if (loop.lastStop === "error") {
					if (await this.recoverCapacity(loop, pres)) continue;
					break;
				}
			}
		} catch (err) {
			crashed = err instanceof Error ? err.message : String(err);
		} finally {
			this.finalize(loop, pres, crashed);
		}
	}

	/** 出生仪式头:身份 + harness 会去测量的事实(时限、git 基线与署名)。 */
	private identityHeader(loop: HostedLoop, pres: Presence): string {
		const lines = [`[mesh] 你是 ${loop.alias}(${sid8(loop.sid)}), 由 ${pres.started_by ? `${this.aliasOf(pres.started_by)}(${sid8(pres.started_by)})` : "?"} 创建 —— 给它写信用 send(to:"creator")。`];
		const facts: string[] = [];
		if (pres.timebox_ms && pres.task_started_at) {
			const left = Math.round((pres.task_started_at + pres.timebox_ms - Date.now()) / 60_000);
			facts.push(`timebox ${Math.round(pres.timebox_ms / 60_000)} 分钟(剩约 ${left} 分钟, 墙钟不因重试重置): 到点收到自检信就停止扩展→提交当前片→报告; 时限只能由创建者改`);
		}
		if (pres.base_oid) facts.push(`git 基线 ${pres.base_oid.slice(0, 7)}, 收场讣告会附相对它的 commits/改动/脏文件; 每次 commit 加 trailer: Mesh-Agent: ${loop.alias}/${sid8(loop.sid)}/${pres.model ?? "?"}`);
		if (facts.length) lines.push(`[mesh] 事实: ${facts.join(" | ")}`);
		return lines.join("\n");
	}

	private async promptOnce(loop: HostedLoop, text: string): Promise<void> {
		loop.lastStop = undefined;
		loop.lastError = undefined;
		loop.lastWillRetry = undefined;
		try {
			await loop.handle.prompt(text);
		} catch (err) {
			if (!loop.aborted) throw err;
		}
	}

	// -------------------------------------------------------------------------
	// 429:同模型退避三次;仍失败 → died(换不换模型由创建者定)
	// -------------------------------------------------------------------------

	private async recoverCapacity(loop: HostedLoop, pres: Presence): Promise<boolean> {
		if (loop.lastWillRetry !== false) return false;
		for (let attempt = 0; attempt < this.backoff.length; attempt++) {
			if (loop.aborted) return false;
			const err = loop.lastError ?? "";
			if (!isCapacityError(err)) return false;
			const ms = this.backoff[attempt];
			loop.attempts.push(`${stamp()} 退避 ${Math.round(ms / 1000)}s(第 ${attempt + 1}/${this.backoff.length} 次): ${clip(err, 120)}`);
			if (!(await this.waitBackoff(loop, ms))) return false;
			await this.promptOnce(loop, `[mesh] 上一轮因 ${pres.model ?? "provider"} 限速中断(第 ${attempt + 1} 次重试), 继续; 上一动作可能半执行, 先核实副作用`);
			if (loop.aborted) return false;
			if (!(loop.lastStop === "error" && loop.lastWillRetry === false)) return true;
		}
		loop.attempts.push(`${stamp()} 退避用尽, 不自动换模型 —— 由创建者决定重派`);
		return false;
	}

	private waitBackoff(loop: HostedLoop, ms: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				loop.backoffCancel = undefined;
				resolve(!loop.aborted);
			}, ms);
			timer.unref?.();
			loop.backoffCancel = () => {
				clearTimeout(timer);
				loop.backoffCancel = undefined;
				resolve(false);
			};
		});
	}

	// -------------------------------------------------------------------------
	// 收场
	// -------------------------------------------------------------------------

	private finalize(loop: HostedLoop, pres: Presence, crashed?: string): void {
		loop.unsub();
		loop.unwatch();
		if (loop.poll) clearInterval(loop.poll);
		this.hosted.delete(loop.sid);
		try {
			loop.handle.dispose();
		} catch {
			/* 已销毁 */
		}
		const lastText = safeLastText(loop.handle) ?? "";
		const silentEmptyWake = loop.handover || (!loop.delivered && loop.turns === 0 && !loop.aborted && !crashed);
		const terminal: { fact: "quiescent" | "died" | "stopped"; reason?: string } | undefined = silentEmptyWake
			? undefined
			: loop.aborted
				? { fact: "stopped", reason: loop.aborted.reason }
				: crashed
					? { fact: "died", reason: `宿主循环异常: ${crashed}` }
					: loop.lastStop === "error"
						? { fact: "died", reason: diedReason(loop) }
						: loop.turns === 0 || lastText.trim().length === 0
							? { fact: "died", reason: `会话结束但没有任何输出(stopReason=${loop.lastStop ?? "?"})` }
							: { fact: "quiescent" };

		patchPresence(this.paths, loop.sid, {
			host_pid: undefined,
			heartbeat_at: Date.now(),
			last_activity_at: loop.lastActivity,
			clean_exit: true,
			stats: statsOf(loop),
			last_note: clip(firstLine(lastText), 120),
			current_tool: undefined,
			...(terminal ? { last_fact: terminal.fact } : {}),
		});

		if (!loop.shutdownNotified && terminal) {
			const cur = readPresence(this.paths, loop.sid) ?? pres;
			const extra: MeshMessage["data"] = {};
			let output = lastText;
			if (terminal.fact === "quiescent") {
				const related = loop.lastReport ?? this.lastReportTo(loop.sid, pres.started_by);
				// 去空白后的前 200 字符一致即视作同一份汇报;不同正文不能被同批渲染折叠掉。
				if (related && reportPrefix(related.body) && reportPrefix(related.body) === reportPrefix(lastText)) {
					extra.related_message_id = related.id;
					output = "";
				}
				const ws = observeWorkspace(cur.cwd, cur.base_oid);
				if (ws) extra.workspace = ws;
			}
			this.notice(pres, terminal.fact, terminal.reason, output, extra);
		}
		this.onChange();
		void this.sweep();
	}

	/** 该工人在折叠窗口内发给创建者、还没被读走的最后一封 message。 */
	private lastReportTo(from: string, to: string | undefined): MeshMessage | undefined {
		if (!to) return undefined;
		const since = Date.now() - QUIESCENT_FOLD_MS;
		let best: MeshMessage | undefined;
		for (const { msg } of listMail(this.paths, to)) {
			if (msg.kind !== "message" || msg.from !== from || msg.at < since) continue;
			if (!best || msg.at >= best.at) best = msg;
		}
		return best;
	}

	/** 通知律:以 system 名义给创建者发讣告(data.subject = 当事 sid)。 */
	private notice(pres: Presence, fact: NoticeFact, reason?: string, lastText?: string, extra?: MeshMessage["data"]): void {
		const to = pres.started_by;
		if (!to) return;
		const incidents = (readPresence(this.paths, pres.sid) ?? pres).incidents;
		this.postNotice(to, fact, FACT_TEXT[fact](pres.alias, reason), {
			...(lastText ? { last_output: clip(lastText, NOTE_CAP) } : {}),
			...(reason ? { reason } : {}),
			...(pres.session_file ? { session_file: pres.session_file } : {}),
			subject: pres.sid,
			...(incidents ? { incidents } : {}),
			...(extra ?? {}),
		});
	}

	private postNotice(to: string, fact: NoticeFact, body: string, data: MeshMessage["data"]): void {
		sendMail(this.paths, { id: newMessageId(), from: "system", to, at: Date.now(), kind: "notice", fact, body, data });
		this.onChange();
	}

	private handoverLetter(sid: string, reason: string): void {
		sendMail(this.paths, { id: newMessageId(), from: "system", to: sid, at: Date.now(), kind: "message", body: handoverBody(reason) });
	}

	private aliasOf(sid: string): string {
		return readPresence(this.paths, sid)?.alias ?? sid8(sid);
	}

	// -------------------------------------------------------------------------
	// stop
	// -------------------------------------------------------------------------

	stopLocal(sid: string, reason: string): boolean {
		const loop = this.hosted.get(sid);
		if (!loop) return false;
		this.abortLoop(loop, reason);
		return true;
	}

	private abortLoop(loop: HostedLoop, reason: string): void {
		loop.aborted = { reason };
		try {
			loop.handle.abort();
		} catch {
			/* 已停 */
		}
		loop.backoffCancel?.();
	}

	// -------------------------------------------------------------------------
	// 巡检:崩溃复活 + 滞留邮件补投
	// -------------------------------------------------------------------------

	async sweep(): Promise<void> {
		if (this.shuttingDown) return;
		const now = Date.now();
		for (const pres of allPresence(this.paths)) {
			if (pres.kind !== "agent" || this.hosted.has(pres.sid)) continue;
			if (!pres.host_pid || pres.host_pid === this.pid || pidAlive(pres.host_pid) || pres.clean_exit) continue;
			const incidents = (pres.incidents ?? 0) + 1;
			const ens = this.ensureHostdFn ? await this.ensureHostdFn().catch(() => ({ ok: false })) : { ok: false };
			patchPresence(this.paths, pres.sid, { host_pid: undefined, heartbeat_at: now, incidents, ...(ens.ok ? {} : { last_fact: "died" as const }) });
			if (ens.ok) this.handoverLetter(pres.sid, `宿主进程(pid ${pres.host_pid})崩溃`);
			else this.notice(pres, "died", `宿主进程(pid ${pres.host_pid})崩溃, 会话中断; 重新托管失败; send 一条消息即可唤醒续跑`);
			this.onChange();
		}
		// 窗口内信被读走、会话被别处接管时清掉定时器,不凭旧快照空唤醒。
		for (const [sid] of this.wakeBatches) {
			const pres = readPresence(this.paths, sid);
			if (!pres || isLive(pres, now) || !listMail(this.paths, sid).some(({ msg }) => isWakeWorthy(msg))) this.clearWakeBatch(sid);
		}
		for (const [sid] of pendingBySid(this.paths)) {
			if (this.hosted.has(sid) || this.waking.has(sid)) continue;
			const pres = readPresence(this.paths, sid);
			if (!pres || pres.kind !== "agent" || isLive(pres, now)) continue;
			if (!listMail(this.paths, sid).some(({ msg }) => isWakeWorthy(msg))) continue;
			const r = await this.wake(sid);
			if (r === "defer_cap") break;
		}
	}

	/** 体征巡检:停滞(逐级翻倍,只报告)与 timebox(声明了才有;到点自检信,1.5× 通报创建者)。 */
	checkVitals(): void {
		const now = Date.now();
		for (const loop of this.hosted.values()) {
			const vitals = this.vitals(loop, now);
			this.checkTimebox(loop, now, vitals);
			const idle = now - loop.lastActivity;
			if (idle < this.stallMs) continue;
			const level = Math.floor(Math.log2(idle / this.stallMs)) + 1;
			if (level <= loop.stallLevel) continue;
			loop.stallLevel = level;
			const pres = readPresence(this.paths, loop.sid);
			if (pres) this.notice(pres, "stalled", `已静默 ${Math.round(idle / 1000)}s`, undefined, vitals);
		}
	}

	private checkTimebox(loop: HostedLoop, now: number, vitals: Vitals): void {
		const pres = readPresence(this.paths, loop.sid);
		if (!pres?.timebox_ms || !pres.task_started_at) return;
		const box = pres.timebox_ms;
		const used = now - pres.task_started_at;
		const level = used >= box * TIMEBOX_GRACE ? 2 : used >= box ? 1 : 0;
		if (level <= (pres.timebox_level ?? 0)) return;
		patchPresence(this.paths, loop.sid, { timebox_level: level });
		const boxMin = Math.round(box / 60_000);
		const mins = Math.round(used / 60_000);
		const ask =
			level === 1
				? `[mesh] 任务书 timebox ${boxMin} 分钟已到(实际 ${mins} 分钟 / ${loop.turns} 轮)。现在: 停止扩展范围 → 完成手上最小可提交的一片 → 跑 targeted 检查 → 把现状写成 checkpoint 报告(做了什么/剩什么/未验证的假设)后结束回合即可; harness 会把你最后一条消息作为讣告发给创建者, 不必再 send creator 同一份内容。不要自行续期; 需要更多时间就在报告里说明。只读任务不必 commit。`
				: `[mesh] 已超 timebox ${boxMin} 分钟的 1.5 倍(实际 ${mins} 分钟)。立即收尾: 不再开新动作, 把当前状态写成 checkpoint 报告后结束回合即可; harness 会把你最后一条消息作为讣告发给创建者, 不必再 send creator 同一份内容。创建者已收到通报。`;
		this.postNotice(loop.sid, "timebox", ask, { subject: loop.sid, timebox_s: Math.round(box / 1000), ...vitals });
		if (level === 2) this.notice(pres, "timebox", `已超时限 ${boxMin} 分钟的 1.5 倍(实际 ${mins} 分钟)`, undefined, { timebox_s: Math.round(box / 1000), ...vitals });
	}

	private vitals(loop: HostedLoop, now: number): Vitals {
		return {
			elapsed_s: Math.round((now - loop.startedAt) / 1000),
			tokens: loop.tokens,
			turns: loop.turns,
			...(loop.currentTool ? { current_tool: { name: loop.currentTool.name, running_s: Math.round((now - loop.currentTool.startedAt) / 1000) } } : {}),
		};
	}

	// -------------------------------------------------------------------------
	// shutdown:交接(hostd 换代/退出,不发讣告)或终局(发 stopped)
	// -------------------------------------------------------------------------

	shutdown(opts: { handover?: boolean } = {}): void {
		this.shuttingDown = true;
		for (const [sid] of this.wakeBatches) this.clearWakeBatch(sid);
		for (const loop of this.hosted.values()) {
			loop.shutdownNotified = true;
			if (opts.handover) {
				loop.handover = true;
				this.handoverLetter(loop.sid, "宿主换代");
			} else {
				const pres = readPresence(this.paths, loop.sid);
				if (pres) this.notice(pres, "stopped", "宿主进程退出; send 一条消息即可唤醒续跑", safeLastText(loop.handle) ?? "");
			}
			this.abortLoop(loop, opts.handover ? "宿主换代" : "宿主进程退出");
			patchPresence(this.paths, loop.sid, { host_pid: undefined, heartbeat_at: Date.now(), clean_exit: true });
		}
	}

	heartbeat(): void {
		const now = Date.now();
		for (const loop of this.hosted.values()) {
			patchPresence(this.paths, loop.sid, {
				host_pid: this.pid,
				heartbeat_at: now,
				last_activity_at: loop.lastActivity,
				stats: statsOf(loop),
				last_note: clip(firstLine(safeLastText(loop.handle) ?? ""), 120),
				current_tool: loop.currentTool ? { name: loop.currentTool.name, started_at: loop.currentTool.startedAt } : undefined,
			});
		}
	}
}

// ---------------------------------------------------------------------------

function reportPrefix(text: string): string {
	return text.replace(/\s/g, "").slice(0, 200);
}

function diedReason(loop: HostedLoop): string {
	const base = loop.lastError ?? "provider error";
	if (loop.attempts.length === 0) return base;
	return clip(`${base} | 尝试记录: ${loop.attempts.join("; ")}`, 600);
}

function stamp(now = Date.now()): string {
	return `${new Date(now).toISOString().slice(11, 19)}Z`;
}

function statsOf(loop: HostedLoop): SessionStats {
	return { ...loop.stats };
}

function safeLastText(handle: SessionHandle): string | undefined {
	try {
		return handle.getLastAssistantText();
	} catch {
		return undefined;
	}
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? ((c as { text?: string }).text ?? "") : "")).join("\n");
}

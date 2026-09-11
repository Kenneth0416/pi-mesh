/**
 * mesh 内核类型与常量。
 *
 * 本体三句话:在守护进程里以任务书起一个 pi 会话(spawn);在推理边界把消息投给会话(deliver);
 * 以 system 名义报告关于会话的可测事实(notice)。一种实体(session)、一种载体(message)、四个动词。
 * 其余全是策略,归技能 mesh-engineering,不归内核。
 *
 * v4(2026-09-07):删 429 换模型/冷却池/配置文件、所有权与契约钉子执法、freeze/epoch、interrupt 意图、
 * urgent/interrupt 预算、成本估算、缺省 timebox、human-facts 文本。留下的全是物理。
 */

import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 目录布局
// ---------------------------------------------------------------------------

export const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
/** agent 会话文件目录(与人的 sessions/ 分离)。 */
export const MESH_SESSIONS_DIR = path.join(AGENT_DIR, "mesh-sessions");

export interface MeshPaths {
	root: string;
	registry: string;
	mailbox: string;
	names: string;
	hostdLock: string;
	hostdState: string;
	hostdLog: string;
}

export function meshPaths(root: string): MeshPaths {
	return {
		root,
		registry: path.join(root, "registry"),
		mailbox: path.join(root, "mailbox"),
		names: path.join(root, "names"),
		hostdLock: path.join(root, "hostd.lock"),
		hostdState: path.join(root, "hostd.json"),
		hostdLog: path.join(root, "hostd.log"),
	};
}

export const DEFAULT_MESH_ROOT = path.join(AGENT_DIR, "mesh");

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 全局同时运行的循环数上限。默认不设限;PI_MESH_MAX_RUNNING 可恢复上限。 */
export const MAX_RUNNING = Number(process.env.PI_MESH_MAX_RUNNING) || Infinity;
/** 形状约束:depth(human)=0;spawn 允许当且仅当 depth(caller) < MAX_DEPTH。 */
export const MAX_DEPTH = Number(process.env.PI_MESH_MAX_DEPTH) || 2;
/** 同一 human root 树内 live 的 agent 数上限。 */
export const TREE_MAX_LIVE = Number(process.env.PI_MESH_TREE_MAX) || 12;
/** idle 合批:静默窗、最短持有、强制注入上限。 */
export const NOTICE_QUIET_MS = 5_000;
export const NOTICE_HOLD_MIN_MS = 10_000;
export const NOTICE_HOLD_MAX_MS = 30_000;
/** presence 心跳周期 / 判死窗口 / 巡检周期 / 注入合并窗。 */
export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 45_000;
export const SWEEP_MS = 15_000;
export const COALESCE_MS = 300;
/** 停滞通知窗口(只报告不处置;逐级翻倍)。 */
export const STALL_MS = 600_000;
/** timebox(只有声明了才有):1.5× 第二次提醒并通报创建者。不强停。 */
export const TIMEBOX_GRACE = 1.5;
/** 429 退避阶梯(同模型;三次仍失败 → died,换不换模型由创建者定)。 */
export const CAPACITY_BACKOFF_MS = [20_000, 60_000, 120_000];
/** 讣告附带 last_output 上限(全文用 sessions(id))。 */
export const NOTE_CAP = 1_500;
/** 短 id = uuid 末 8 位;寻址最短长度。 */
export const SID_SHORT_MIN = 6;
/** 注入预算:一批最多字符/封数;留箱超过 aging 的信升顶。 */
export const INJECT_MAX_CHARS = 24_000;
export const INJECT_MAX_COUNT = 20;
export const INJECT_AGING_MS = 180_000;
/** quiescent 讣告与该 agent 最后一封汇报的折叠窗口。 */
export const QUIESCENT_FOLD_MS = 180_000;
/** 宿主守护进程:空闲自退 / 拉起等待 / 换代等待 / watch 去抖。 */
export const HOSTD_IDLE_EXIT_MS = 600_000;
export const HOSTD_START_TIMEOUT_MS = 5_000;
export const HOSTD_TERM_WAIT_MS = 3_000;
export const HOSTD_WATCH_DEBOUNCE_MS = 200;
/** dormant 唤醒合并窗(从首封可唤醒信起算,不因新信续期);人的工作信与 blocker 绕过。 */
export const WAKE_BATCH_MS = Number(process.env.PI_MESH_WAKE_BATCH_MS) || 8_000;
/** 可授予 agent 的 pi 原生工具全集。 */
export const PI_NATIVE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * 唯一的频次预算:agent 互发消息把 dormant 会话叫起来的次数(讣告与人的消息不计,人的消息清窗)。
 * 这是无人值守时唯一能自激烧钱的环;超出只 defer 不丢信。
 */
export const WAKE_BUDGET = { max: 6, windowMs: 600_000 } as const;

// ---------------------------------------------------------------------------
// 推理等级(与 pi 的 ThinkingLevel 同形)
// 规则:显式 thinking 优先;否则继承创建者等级,未知时 medium,与是否指定 model 无关。
// ---------------------------------------------------------------------------

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
	return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

export function thinkingForSpawn(a: { explicit?: ThinkingLevel; modelExplicit: boolean; callerLevel?: ThinkingLevel }): ThinkingLevel {
	return a.explicit ?? a.callerLevel ?? "medium";
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

/** 出生即定:human=pi CLI 创建(绝不自动唤醒);agent=agent() 创建。 */
export type SessionKind = "human" | "agent";

export interface SessionStats {
	tokens: number;
	turns: number;
	/** 缓存可观测回合的未缓存输入;缺 cacheRead 的回合不进入命中率分母。旧记录允许缺字段。 */
	input?: number;
	cache_read?: number;
	cache_write?: number;
	output?: number;
	cost_usd?: number;
	/** 最近一回合的百分比(0–100);不可观测或零分母时未知。 */
	last_hit_pct?: number;
}

/** pi usage 的最小投影;不把未提供的 cacheRead 偷换成零。 */
export interface SessionUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

/** 读老 presence 时补齐累计值,未知的最近命中率仍保持 undefined。 */
export function normalizeStats(stats: Partial<SessionStats> = {}) {
	return {
		tokens: stats.tokens ?? 0,
		turns: stats.turns ?? 0,
		input: stats.input ?? 0,
		cache_read: stats.cache_read ?? 0,
		cache_write: stats.cache_write ?? 0,
		output: stats.output ?? 0,
		cost_usd: stats.cost_usd ?? 0,
		last_hit_pct: stats.last_hit_pct,
	};
}

export function addUsage(stats: SessionStats, usage?: SessionUsage): SessionStats {
	const next = normalizeStats(stats);
	next.tokens += usage?.totalTokens ?? 0;
	next.turns++;
	next.output += usage?.output ?? 0;
	next.cache_write += usage?.cacheWrite ?? 0;
	next.cost_usd += usage?.cost?.total ?? 0;
	next.last_hit_pct = undefined;
	if (usage?.cacheRead !== undefined) {
		const input = usage.input ?? 0;
		next.input += input;
		next.cache_read += usage.cacheRead;
		const total = input + usage.cacheRead;
		if (total > 0) next.last_hit_pct = 100 * usage.cacheRead / total;
	}
	return next;
}

export function cacheHitPct(stats: SessionStats): number | undefined {
	const total = (stats.input ?? 0) + (stats.cache_read ?? 0);
	return total > 0 ? 100 * (stats.cache_read ?? 0) / total : undefined;
}

export function cacheLabel(stats: SessionStats, warn = false): string {
	const pct = cacheHitPct(stats);
	if (pct === undefined) return "";
	const low = warn && pct < 50 && (stats.input ?? 0) + (stats.cache_read ?? 0) > 200_000;
	return `${low ? "⚠" : ""}cache ${Math.round(pct)}%`;
}

/** 工具集合用固定字典序,不依赖调用方顺序或系统 locale。 */
export function normalizeTools(tools: readonly string[]): string[] {
	return [...new Set(tools)].sort();
}

/** 讣告附带的 workspace 事实(harness 观测,不是模型自述;成本/用量在会话 jsonl 里,不重复)。 */
export interface WorkspaceFacts {
	head?: string;
	/** 派发时记下的基线 oid。 */
	base?: string;
	/** 相对基线新增的 commit(最多 20 条 "sha subject")。 */
	commits?: string[];
	/** 相对基线改动的 tracked 文件(最多 40)。 */
	changed?: string[];
	/** 工作区未提交改动数。 */
	dirty?: number;
}

export interface Presence {
	sid: string;
	alias: string;
	kind: SessionKind;
	session_file?: string;
	cwd: string;
	model?: string;
	thinking_level?: ThinkingLevel;
	/** agent 的工具白名单;human 无(=全集)。 */
	tools?: string[];
	depth?: number;
	/** 宿主崩溃后被重新托管的次数。 */
	incidents?: number;
	/** 创建者 sid;human 无。 */
	started_by?: string;
	born_at: number;
	/** 有活进程照看时的 pid(human=pi 进程;agent=宿主进程)。 */
	host_pid?: number;
	heartbeat_at: number;
	/** agent 最近一次真实活动(事件)时刻,由宿主心跳回写;与 heartbeat_at 分开 —— 宿主活着不代表任务在推进。 */
	last_activity_at?: number;
	stats: SessionStats;
	last_note?: string;
	clean_exit?: boolean;
	/** 上一次运行的终局(转录;再次唤醒时清除)。 */
	last_fact?: NoticeFact;
	current_tool?: { name: string; started_at: number };
	/** wake 预算的滑窗记录(裁到最近 12 条)。 */
	wake_log?: number[];
	/** 任务墙钟起点(spawn 时定;唤醒/重试不重置)。 */
	task_started_at?: number;
	/** 时限(只有声明了才有)。 */
	timebox_ms?: number;
	/** 已通报的 timebox 级别(1=到点, 2=超 grace)。 */
	timebox_level?: number;
	/** 派发时 cwd 的 git HEAD(不是仓库则无);收场 workspace 事实的基线。 */
	base_oid?: string;
}

/** 派生状态(不落盘)。 */
export type SessionState = "attached" | "running" | "dormant";

// ---------------------------------------------------------------------------
// message
// ---------------------------------------------------------------------------

export type MessageKind = "message" | "notice" | "control";

/**
 * 意图(唯一的消息路由元数据;缺省 report):
 * - report:汇报/追加指令 → human 收件人合批注入;dormant agent 短窗合批唤醒;
 * - blocker:不答就停工 → 立即注入;
 * - notify:仅供知悉 → 绝不唤醒 dormant agent;human 合批。
 */
export type MessageIntent = "report" | "blocker" | "notify";
export const MESSAGE_INTENTS: MessageIntent[] = ["report", "blocker", "notify"];

export function isUrgentIntent(intent: MessageIntent | undefined): boolean {
	return intent === "blocker";
}

/** 会把 dormant agent 叫起来干活的意图(notify 不算)。 */
export function isWorkIntent(intent: MessageIntent | undefined): boolean {
	return intent !== "notify";
}

/**
 * 一封信是否值得把 dormant agent 叫起来:
 * - 工作消息(report/blocker);
 * - 它派出的子代**自然收场**的讣告(quiescent/died)—— "派完结束回合, 讣告唤醒"这条约定对 agent 创建者同样成立;
 * - 不含 notify、stopped(人停整棵树时不得把父代拉起来继续派活)、stalled/timebox/workspace(体征与观测, 不是终局)。
 */
export function isWakeWorthy(msg: { kind: MessageKind; intent?: MessageIntent; fact?: NoticeFact }): boolean {
	if (msg.kind === "message") return isWorkIntent(msg.intent);
	if (msg.kind === "notice") return msg.fact === "quiescent" || msg.fact === "died";
	return false;
}

/** 通知律的客观事实,只报告不处置。 */
export type NoticeFact = "quiescent" | "died" | "stopped" | "stalled" | "timebox" | "workspace";

export interface MeshMessage {
	id: string;
	/** 发件人 sid,或 "system"。 */
	from: string;
	from_alias?: string;
	to: string;
	at: number;
	kind: MessageKind;
	body: string;
	intent?: MessageIntent;
	fact?: NoticeFact;
	data?: {
		last_output?: string;
		reason?: string;
		session_file?: string;
		/** 当事会话 sid —— 所有讣告必带。 */
		subject?: string;
		elapsed_s?: number;
		tokens?: number;
		turns?: number;
		current_tool?: { name: string; running_s: number };
		incidents?: number;
		related_message_id?: string;
		workspace?: WorkspaceFacts;
		timebox_s?: number;
	};
}

// ---------------------------------------------------------------------------
// 工具错误载荷 + 小工具
// ---------------------------------------------------------------------------

export interface ToolError {
	error: { code: string; message: string };
}

export function toolError(code: string, message: string): ToolError {
	return { error: { code, message } };
}

export function isToolError(v: unknown): v is ToolError {
	return Boolean(v && typeof v === "object" && "error" in (v as object));
}

export function clip(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function firstLine(s: string): string {
	return s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

/** 短 id = 去掉连字符后的末 8 位(uuidv7 前缀是时间戳,同小时几乎全撞)。 */
export function sid8(sid: string): string {
	return sid.replace(/-/g, "").slice(-8);
}

/** uuidv7(与 pi 默认 sid 同形;SessionManager.create 接受指定 id)。 */
export function uuidv7(now = Date.now()): string {
	const b = randomBytes(16);
	b[0] = (now / 2 ** 40) & 0xff;
	b[1] = (now / 2 ** 32) & 0xff;
	b[2] = (now / 2 ** 24) & 0xff;
	b[3] = (now / 2 ** 16) & 0xff;
	b[4] = (now / 2 ** 8) & 0xff;
	b[5] = now & 0xff;
	b[6] = (b[6] & 0x0f) | 0x70;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** wake 预算(纯函数):返回放行与否与新的滑窗记录。 */
export function takeWakeBudget(log: number[] | undefined, now = Date.now()): { ok: boolean; log: number[] } {
	const kept = (log ?? []).filter((t) => now - t < WAKE_BUDGET.windowMs);
	if (kept.length >= WAKE_BUDGET.max) return { ok: false, log: kept };
	kept.push(now);
	return { ok: true, log: kept.slice(-12) };
}

/** 容量类错误(429/配额)才值得退避;其余(401/402/400/网络)需要人 → 直接 died。 */
export function isCapacityError(msg: string | undefined): boolean {
	if (!msg) return false;
	return /usage limit|limit will reset|weekly|monthly|5 hour|quota|exhausted|rate.?limit|overloaded|temporarily|(?<!\d)429(?!\d)/i.test(msg);
}

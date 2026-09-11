/**
 * mailbox —— 每个 session 一个收件箱目录,消息 = 一个 JSON 文件。
 *
 * 投递律的持久层:
 * - 写入 = 同目录 tmp + rename(原子,watcher 只会看到完整文件);
 * - consume-on-inject:只有确认注入上下文后才 unlink —— 崩溃安全保持到最后一刻;
 * - fs.watch 即时触发(spike 实证 macOS rename-in 可靠),SWEEP 轮询兜底。
 *
 * 收件箱物理:注入按 token 预算而不是按封数;优先级 = 紧急 > 需判断的事实与汇报 > 知悉;
 * 超额留箱只给信封摘要(不摘要正文);quiescent 与同批的最后一封汇报折叠渲染(文件各自保留)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MeshMessage, MeshPaths } from "./types.ts";
import { INJECT_AGING_MS, INJECT_MAX_CHARS, INJECT_MAX_COUNT, isUrgentIntent, sid8 } from "./types.ts";
import { atomicWrite } from "./registry.ts";

let seq = 0;

function boxDir(p: MeshPaths, sid: string): string {
	return path.join(p.mailbox, sid);
}

export function newMessageId(): string {
	return `m_${Date.now().toString(36)}_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 投递一封信(落盘即送达持久层)。返回消息 id。 */
export function sendMail(p: MeshPaths, msg: MeshMessage): string {
	const dir = boxDir(p, msg.to);
	fs.mkdirSync(dir, { recursive: true });
	atomicWrite(path.join(dir, `${msg.id}.json`), JSON.stringify(msg));
	return msg.id;
}

export interface MailFile {
	file: string;
	msg: MeshMessage;
}

/** 按写入顺序(id 含时间戳,字典序即时序)读出全部未决信。损坏文件直接清除。 */
export function listMail(p: MeshPaths, sid: string): MailFile[] {
	const dir = boxDir(p, sid);
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: MailFile[] = [];
	for (const f of files.sort()) {
		if (!f.startsWith("m_") || !f.endsWith(".json")) continue;
		const full = path.join(dir, f);
		try {
			out.push({ file: full, msg: JSON.parse(fs.readFileSync(full, "utf8")) as MeshMessage });
		} catch {
			try {
				fs.unlinkSync(full);
			} catch {
				/* 竞争者已清 */
			}
		}
	}
	return out;
}

/** consume-on-inject:确认注入后清除。 */
export function consumeMail(files: string[]): void {
	for (const f of files) {
		try {
			fs.unlinkSync(f);
		} catch {
			/* 已清 */
		}
	}
}

export function pendingCount(p: MeshPaths, sid: string): number {
	try {
		return fs.readdirSync(boxDir(p, sid)).filter((f) => f.startsWith("m_") && f.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/** 全网扫描:有未决信的 sid → 数量(sweep 补投用)。 */
export function pendingBySid(p: MeshPaths): Map<string, number> {
	const out = new Map<string, number>();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(p.mailbox);
	} catch {
		return out;
	}
	for (const sid of dirs) {
		const n = pendingCount(p, sid);
		if (n > 0) out.set(sid, n);
	}
	return out;
}

/**
 * 监听某个收件箱。事件去抖 50ms 后回调(回调自行 listMail)。
 * 目录可能尚不存在 —— 先建再挂。返回关闭函数。
 */
export function watchMailbox(p: MeshPaths, sid: string, onChange: () => void): () => void {
	const dir = boxDir(p, sid);
	fs.mkdirSync(dir, { recursive: true });
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let watcher: fs.FSWatcher | undefined;
	try {
		watcher = fs.watch(dir, () => {
			if (closed || timer) return;
			timer = setTimeout(() => {
				timer = null;
				if (!closed) onChange();
			}, 50);
		});
	} catch {
		/* watch 不可用 → 只剩 sweep 轮询兜底,可接受 */
	}
	return () => {
		closed = true;
		if (timer) clearTimeout(timer);
		try {
			watcher?.close();
		} catch {
			/* 已关 */
		}
	};
}

// ---------------------------------------------------------------------------
// 投递计划(纯函数,零 IO):一次注入放多少、丢什么、留什么、先投谁
// ---------------------------------------------------------------------------

/**
 * 唯一允许丢弃的是被支配的旧体征 —— 同一 (fact, subject) 的 stalled/longrun,
 * 新的一封严格包含旧的全部信息(体征是当下快照,不是流水),丢弃零信息损失。
 * 其余 kind/fact 永不丢:超出预算的留箱下回合再批,而不是压缩成摘要 —— 只给信封摘要。
 */
export interface InjectionPlan {
	inject: MailFile[];
	drop: MailFile[];
	defer: MailFile[];
	/** 留箱部分的信封摘要(有留箱才有)。 */
	summary?: DeferSummary;
}

export interface DeferSummary {
	deferred: number;
	/** 发件人(别名或 sid8)→ 封数。 */
	by_sender: Record<string, number>;
	/** 前几封留箱信的 id(按优先级),可 sessions({id, unread_full}) 取全文。 */
	ids: string[];
}

export interface PlanOptions {
	/** 一批最多几封(缺省 INJECT_MAX_COUNT)。 */
	maxCount?: number;
	/** 一批最多多少字符(渲染后;缺省 INJECT_MAX_CHARS)。单封超预算仍至少投一封。 */
	maxChars?: number;
	now?: number;
	/** 留箱超过此时长的信升到最高优先级(缺省 INJECT_AGING_MS;0=不 aging)。 */
	agingMs?: number;
	/** 发件人是不是 human(人说的话与 blocker 同级);缺省无人。 */
	isHuman?: (sid: string) => boolean;
}

/**
 * 优先级(小者先),只有三档:
 * 0 紧急(blocker、人的话)/ aging 到期
 * 1 需要判断的事实与汇报(report、died/stopped/timebox/workspace 讣告)
 * 2 知悉级(notify、quiescent 讣告、stalled 体征)
 */
export function rankOf(m: MeshMessage, now: number, agingMs: number, isHuman?: (sid: string) => boolean): number {
	if (agingMs > 0 && now - m.at >= agingMs) return 0;
	if (m.kind === "message") {
		if (m.intent === "notify") return 2;
		if (isUrgentIntent(m.intent)) return 0;
		if (m.from !== "system" && isHuman?.(m.from)) return 0;
		return 1;
	}
	if (m.kind === "notice") return m.fact === "quiescent" || m.fact === "stalled" ? 2 : 1;
	return 1;
}

export function planInjection(mail: MailFile[], opts: number | PlanOptions = {}): InjectionPlan {
	const o: PlanOptions = typeof opts === "number" ? { maxCount: opts } : opts;
	const maxCount = o.maxCount ?? INJECT_MAX_COUNT;
	const maxChars = o.maxChars ?? INJECT_MAX_CHARS;
	const now = o.now ?? Date.now();
	const agingMs = o.agingMs ?? INJECT_AGING_MS;

	const vitalKey = (m: MailFile): string | undefined => {
		const f = m.msg.fact;
		if (f !== "stalled" && f !== "timebox") return undefined;
		const subject = m.msg.data?.subject;
		return subject ? `${f} ${subject}` : undefined;
	};
	// 每个 (fact, subject) 的最新一封(时序即列表序;at 相同取靠后的)。
	const newest = new Map<string, MailFile>();
	for (const m of mail) {
		const key = vitalKey(m);
		if (!key) continue;
		const prev = newest.get(key);
		if (!prev || m.msg.at >= prev.msg.at) newest.set(key, m);
	}
	const drop: MailFile[] = [];
	const keep: MailFile[] = [];
	for (const m of mail) {
		const key = vitalKey(m);
		if (key && newest.get(key) !== m) drop.push(m);
		else keep.push(m);
	}
	// 稳定排序:优先级,再时序(列表序即时序)。
	const ranked = keep.map((m, i) => ({ m, rank: rankOf(m.msg, now, agingMs, o.isHuman), i })).sort((a, b) => a.rank - b.rank || a.i - b.i);
	const inject: MailFile[] = [];
	const defer: MailFile[] = [];
	let chars = 0;
	for (const { m } of ranked) {
		const size = renderLine(m.msg, new Set()).length + 1;
		const fits = inject.length < maxCount && (chars + size <= maxChars || inject.length === 0);
		if (fits) {
			inject.push(m);
			chars += size;
		} else defer.push(m);
	}
	// 注入顺序按时序还原(优先级只决定"谁进这一批",阅读顺序仍按到达时间)。
	inject.sort((a, b) => mail.indexOf(a) - mail.indexOf(b));
	const plan: InjectionPlan = { inject, drop, defer };
	if (defer.length > 0) {
		const by: Record<string, number> = {};
		for (const m of defer) {
			const who = m.msg.from === "system" ? "system" : (m.msg.from_alias ?? sid8(m.msg.from));
			by[who] = (by[who] ?? 0) + 1;
		}
		plan.summary = { deferred: defer.length, by_sender: by, ids: defer.slice(0, 10).map((m) => m.msg.id) };
	}
	return plan;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderLine(m: MeshMessage, batchIds: Set<string>): string {
	// 讣告折叠(§13 #1):quiescent 与它指向的那封汇报同批 → 讣告只留一行事实,正文以汇报为准。
	const folded = m.kind === "notice" && m.fact === "quiescent" && m.data?.related_message_id && batchIds.has(m.data.related_message_id);
	const data = folded && m.data ? { ...m.data, last_output: undefined } : m.data;
	const cleanData = data ? Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) : undefined;
	return JSON.stringify({
		id: m.id,
		from: m.from === "system" ? "system" : `${m.from_alias ?? "?"}(${sid8(m.from)})`,
		kind: m.kind,
		...(m.intent && m.intent !== "report" ? { intent: m.intent } : {}),
		...(m.fact ? { fact: m.fact } : {}),
		...(cleanData && Object.keys(cleanData).length > 0 ? { data: cleanData } : {}),
		body: folded ? `${m.body.split(" —— ")[0]}(最后汇报见同批 ${m.data?.related_message_id})` : m.body,
	});
}

export interface RenderExtra {
	/** 动态舰队摘要只进 user 消息头,绝不拼进 systemPrompt。 */
	fleet?: string;
	/** 留箱摘要(planInjection.summary)。 */
	deferred?: DeferSummary;
	/** 取全文的提示(调用方知道自己的 id)。 */
	hint?: string;
}

/** 渲染注入块:一行一封,信封字段透明可见(含 id,去重靠它);末尾可附留箱摘要(只有信封,没有正文)。 */
export function renderMail(msgs: MeshMessage[], extra: RenderExtra = {}): string {
	const ids = new Set(msgs.map((m) => m.id));
	const lines = msgs.map((m) => renderLine(m, ids));
	if (extra.fleet) lines.unshift(extra.fleet);
	if (extra.deferred && extra.deferred.deferred > 0) {
		lines.push(
			JSON.stringify({
				deferred: extra.deferred.deferred,
				by_sender: extra.deferred.by_sender,
				ids: extra.deferred.ids,
				note: `另有 ${extra.deferred.deferred} 封留箱(按优先级下回合继续投, 不会丢)${extra.hint ? `; ${extra.hint}` : ""}`,
			}),
		);
	}
	return ["<mesh_messages>", ...lines, "</mesh_messages>"].join("\n");
}

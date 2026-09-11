/**
 * registry —— presence(谁存在)、names(别名寻址)。
 *
 * 全部基于文件系统原语,零依赖:
 * - presence 写入 = tmp + rename 原子替换;
 * - alias 唯一性 = O_EXCL(wx)创建即声明,天然免读改写竞态;
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MeshPaths, Presence, SessionState } from "./types.ts";
import { STALE_MS, normalizeStats, sid8 } from "./types.ts";

export function ensureDirs(p: MeshPaths): void {
	for (const d of [p.root, p.registry, p.mailbox, p.names]) {
		fs.mkdirSync(d, { recursive: true });
	}
}

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

let tmpSeq = 0;

export function atomicWrite(file: string, content: string): void {
	const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${++tmpSeq}`);
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

export function presenceFile(p: MeshPaths, sid: string): string {
	return path.join(p.registry, `${sid}.json`);
}

export function writePresence(p: MeshPaths, pres: Presence): void {
	atomicWrite(presenceFile(p, pres.sid), JSON.stringify(pres, null, 1));
}

export function readPresence(p: MeshPaths, sid: string): Presence | undefined {
	try {
		const pres = JSON.parse(fs.readFileSync(presenceFile(p, sid), "utf8")) as Presence;
		return { ...pres, stats: normalizeStats(pres.stats) };
	} catch {
		return undefined;
	}
}

/** 读-改-写(单字段 patch;registry 只有宿主进程写自己照看的行,竞态面极小)。 */
export function patchPresence(p: MeshPaths, sid: string, patch: Partial<Presence>): Presence | undefined {
	const cur = readPresence(p, sid);
	if (!cur) return undefined;
	const next = { ...cur, ...patch };
	writePresence(p, next);
	return next;
}

export function allPresence(p: MeshPaths): Presence[] {
	let files: string[];
	try {
		files = fs.readdirSync(p.registry);
	} catch {
		return [];
	}
	const out: Presence[] = [];
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const pres = JSON.parse(fs.readFileSync(path.join(p.registry, f), "utf8")) as Presence;
			out.push({ ...pres, stats: normalizeStats(pres.stats) });
		} catch {
			/* 半写状态/损坏行:跳过,原子写下会自愈 */
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// 存活派生
// ---------------------------------------------------------------------------

export function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function isLive(pres: Presence, now: number): boolean {
	return pidAlive(pres.host_pid) && now - pres.heartbeat_at < STALE_MS;
}

export function sessionState(pres: Presence, now: number): SessionState {
	if (!isLive(pres, now)) return "dormant";
	return pres.kind === "human" ? "attached" : "running";
}

// ---------------------------------------------------------------------------
// 作用域:向下包含(不对称)
// ---------------------------------------------------------------------------

/**
 * viewer(cwd=V)看得见 cwd=A 的会话,当且仅当 A === V 或 A 在 V 子树内。
 *
 * 不对称是刻意的:你能看见**你地盘里**的工人,上级地盘的工人不归你看。
 *
 * 例外:home 不是项目,是**项目的容器**——在 ~ 开的会话只看 cwd 恰为 ~ 的
 * agent,不伞形吞并所有项目(否则跨项目污染在最常用的目录里复活;
 * 全景本来就有去处:/mesh)。2026-08-12 实测修正,原"~=总控台"设计作废。
 */
export function sameProject(viewerCwd: string, cwd: string): boolean {
	const v = path.resolve(viewerCwd);
	const a = path.resolve(cwd);
	if (a === v) return true;
	if (v === os.homedir()) return false; // 容器的现场只有它自己
	return a.startsWith(v.endsWith(path.sep) ? v : v + path.sep);
}

/**
 * p 是否在 viewer 派出的子树里(含自己):沿 started_by 上溯 ≤16 跳。
 * 无参 sessions() 与 sweep 自动寄宿用它 —— 显式 cwd 在 /tmp 的工人仍归创建者。
 */
export function inCallerTree(p: MeshPaths, viewerSid: string, node: Presence, maxHops = 16): boolean {
	let cur: Presence | undefined = node;
	for (let hop = 0; hop < maxHops; hop++) {
		if (!cur) return false;
		if (cur.sid === viewerSid) return true;
		if (!cur.started_by) return false;
		cur = readPresence(p, cur.started_by);
	}
	return false;
}

// ---------------------------------------------------------------------------
// 谱系:深度与树根(形状约束的两个物理量)
// ---------------------------------------------------------------------------

/**
 * 沿 started_by 上溯到 human 的跳数:human=0,human 派的 agent=1,它派的=2……
 * 链断了(无 started_by 或 presence 已清)按到达处计 —— 孤儿 agent 至少算 1 层。
 */
export function depthOf(p: MeshPaths, pres: Presence, maxHops = 16): number {
	if (pres.kind === "human") return 0;
	let cur: Presence = pres;
	for (let hop = 1; hop <= maxHops; hop++) {
		const next: Presence | undefined = cur.started_by ? readPresence(p, cur.started_by) : undefined;
		if (!next || next.kind === "human") return hop;
		cur = next;
	}
	return maxHops;
}

/** 沿 started_by 上溯找 human root(自己就是 human 时是自己;整条链上没有人则 undefined)。 */
export function humanRootOf(p: MeshPaths, pres: Presence, maxHops = 16): string | undefined {
	if (pres.kind === "human") return pres.sid;
	let cur: Presence | undefined = pres;
	for (let hop = 0; hop < maxHops; hop++) {
		const next: Presence | undefined = cur?.started_by ? readPresence(p, cur.started_by) : undefined;
		if (!next) return undefined;
		if (next.kind === "human") return next.sid;
		cur = next;
	}
	return undefined;
}

/**
 * 树根 sid:human root 优先;链上没有人(或链断)时取最顶端可达祖先 ——
 * 孤儿树也要有一个稳定的键,否则树内计数会把每个节点算成自己的树。
 */
export function rootOf(p: MeshPaths, pres: Presence, maxHops = 16): string {
	let cur: Presence = pres;
	if (cur.kind === "human") return cur.sid;
	for (let hop = 0; hop < maxHops; hop++) {
		const next: Presence | undefined = cur.started_by ? readPresence(p, cur.started_by) : undefined;
		if (!next) return cur.sid;
		if (next.kind === "human") return next.sid;
		cur = next;
	}
	return cur.sid;
}

/**
 * 无参 sessions() / 注入舰队概况 / 状态栏计数的可见性:
 * **自己 + 自己派出的子树**(沿 started_by 上溯到 viewer),仅此而已。
 *
 * §12(2026-09-02,推翻 08-13 的项目作用域):一个 human 会话 = 一个独立方向。
 * 同一目录下常有多个 pi 会话(Nicole / Nicole-2 / Nicole-3…),按 cwd 归组会把
 * **别人方向的舰队塞进你的上下文**,还让模型把"创建者"的名字解析错人。
 * 别的 human 会话不是你的舰队成员 —— 无论它在不在线、cwd 是不是同一个。
 *
 * 定点深查(`sessions({id})`)与 send 寻址仍全域;全景仍在 `/mesh` 面板。
 */
export function inSessionList(p: MeshPaths, viewer: Presence, node: Presence, _now = Date.now()): boolean {
	if (node.sid === viewer.sid) return true;
	return inCallerTree(p, viewer.sid, node);
}

export function normalizeAlias(alias: string): string {
	return alias.replace(/[^\w.-]/g, "_");
}

function aliasFile(p: MeshPaths, alias: string): string {
	return path.join(p.names, normalizeAlias(alias));
}

/** 声明别名(O_EXCL)。成功=true;已被占用=false。 */
export function claimAlias(p: MeshPaths, alias: string, sid: string): boolean {
	try {
		fs.writeFileSync(aliasFile(p, alias), sid, { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

export function resolveAlias(p: MeshPaths, alias: string): string | undefined {
	try {
		return fs.readFileSync(aliasFile(p, alias), "utf8").trim();
	} catch {
		return undefined;
	}
}

/** 强制改绑(human 会话复用 basename 时:旧持有者已 dormant 才允许,调用方判断)。 */
export function rebindAlias(p: MeshPaths, alias: string, sid: string): void {
	atomicWrite(aliasFile(p, alias), sid);
}

/**
 * 自动别名:base、base-2、base-3… 逐个 wx 抢注,返回抢到的名字。
 * 若 base 的持有者已死(dormant),直接改绑复用 —— 名字跟着活人走,
 * 旧会话仍可用短 id(末 8 位)寻址。
 */
export function autoAlias(p: MeshPaths, base: string, sid: string, canSteal: (holderSid: string) => boolean): string {
	const b = normalizeAlias(base) || "s";
	for (let n = 1; n < 1000; n++) {
		const candidate = n === 1 ? b : `${b}-${n}`;
		if (claimAlias(p, candidate, sid)) return candidate;
		const holder = resolveAlias(p, candidate);
		if (holder === sid) return candidate; // 自己(重启同会话)
		if (holder && canSteal(holder)) {
			rebindAlias(p, candidate, sid);
			return candidate;
		}
	}
	// 千个同名?直接用 sid 当别名兜底。
	rebindAlias(p, sid, sid);
	return sid;
}

// ---------------------------------------------------------------------------
// 自注册(会话上线:pi 进程照看自己这一行)
// ---------------------------------------------------------------------------

export interface SelfInit {
	sid: string;
	cwd: string;
	pid: number;
	sessionFile?: string;
	model?: string;
}

/**
 * 把本会话写进 registry。三条纪律:
 * - **kind 出生即定**:沿用既有 kind(`pi --session` 接管 agent 会话时,它仍是 agent
 *   —— 被人碰过一次就永远不能被自动唤醒的 bug 在此修复);attended 与否由
 *   host_pid/heartbeat 派生,与 kind 无关。
 * - **别名**:沿用既有(名字文件还指向自己时);否则以旧名为基抢注,被占则自动后缀。
 */
export function registerSelf(p: MeshPaths, init: SelfInit): Presence {
	const now = Date.now();
	const existing = readPresence(p, init.sid);
	const alias =
		existing && resolveAlias(p, existing.alias) === init.sid
			? existing.alias
			: autoAlias(p, existing?.alias ?? (path.basename(init.cwd) || "home"), init.sid, (holderSid) => {
					const h = readPresence(p, holderSid);
					return !h || !isLive(h, now); // 只从死者手里接名字
				});
	const pres: Presence = {
		...existing,
		sid: init.sid,
		alias,
		kind: existing?.kind ?? "human",
		session_file: init.sessionFile ?? existing?.session_file,
		cwd: init.cwd,
		model: init.model,
		born_at: existing?.born_at ?? now,
		host_pid: init.pid,
		heartbeat_at: now,
		stats: existing?.stats ?? { tokens: 0, turns: 0 },
		clean_exit: false,
	};
	writePresence(p, pres);
	return pres;
}

// ---------------------------------------------------------------------------
// 会话文件的打开计划(m0 spike 的既有隐患修复)
// ---------------------------------------------------------------------------

/** SDK 的 sid 校验:不允许空/空格/斜杠/以 - 开头结尾。 */
export const SDK_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type SessionOpenPlan = { action: "open"; file: string } | { action: "create"; cwd: string; id?: string };

/**
 * 唤醒一个 agent 会话时该 open 还是 create。
 *
 * m0 spike 实证:`SessionManager.open()` 对**不存在的文件**会静默换一个新 sid
 * (文件名保留旧 sid,内容却是新的),于是 registry/mailbox/别名全部对不上号。
 * 而"派出去但第一轮就死/被 TUI 退出打断"的 worker 恰恰从没落过盘
 * (`create()` 不建文件,第一条 assistant 消息才 `openSync(wx)` 落盘)。
 * 所以:文件不在 → 以**指定 id** 新建(不要预写占位文件,首轮 flush 会 EEXIST)。
 */
export function planSessionOpen(pres: Presence, exists: (file: string) => boolean = fs.existsSync): SessionOpenPlan {
	if (pres.session_file && exists(pres.session_file)) return { action: "open", file: pres.session_file };
	return { action: "create", cwd: pres.cwd, ...(SDK_SESSION_ID_RE.test(pres.sid) ? { id: pres.sid } : {}) };
}

// ---------------------------------------------------------------------------
// 寻址(fail-fast:精确 alias > 精确 sid > 唯一短 id;歧义/未知一律报错列候选)
// ---------------------------------------------------------------------------

export type ResolveResult = { sid: string } | { error: string };

/**
 * 短 id 寻址(§12):**末 8 位为准**(`sid8` 显示的就是它),同时兼容前缀 ——
 * 旧记录里模型可能记住了前 8 位。两侧都唯一且指向同一个会话才算命中;
 * 命中不同会话则报歧义列候选(候选一律按 `sid8` 渲染,与显示口径一致)。
 */
export function resolveTarget(p: MeshPaths, target: string, shortMin: number): ResolveResult {
	const t = target.trim();
	const byAlias = resolveAlias(p, normalizeAlias(t));
	if (byAlias) return { sid: byAlias };
	const all = allPresence(p);
	const exact = all.find((x) => x.sid === t);
	if (exact) return { sid: exact.sid };
	if (t.length >= shortMin) {
		const norm = t.replace(/-/g, "").toLowerCase();
		const flat = (x: Presence) => x.sid.replace(/-/g, "").toLowerCase();
		const hits: Presence[] = [];
		for (const x of all) {
			const f = flat(x);
			if (f.endsWith(norm) || f.startsWith(norm)) hits.push(x);
		}
		if (hits.length === 1) return { sid: hits[0].sid };
		if (hits.length > 1)
			return { error: `"${t}" 命中 ${hits.length} 个会话: ${hits.map((h) => `${h.alias}(${sid8(h.sid)})`).join(", ")} —— 用别名或完整 sid` };
	}
	const known = all
		.slice(0, 20)
		.map((x) => x.alias)
		.join(", ");
	return { error: `未知会话 "${t}"。可用 alias: ${known || "(网络为空)"}; 或短 id(末 8 位, ≥${shortMin} 位, 见 sessions 输出); 要新建一个 agent 请用 agent 工具` };
}

// ---------------------------------------------------------------------------
// 并发分母:活着的 agent 会话数(host_pid 存活且心跳新鲜)。没有锁目录:宿主唯一,存活即在场。
// ---------------------------------------------------------------------------

export function runningCount(p: MeshPaths, now = Date.now()): number {
	return allPresence(p).filter((x) => x.kind === "agent" && isLive(x, now)).length;
}

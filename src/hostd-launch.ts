/**
 * hostd-launch —— "怎么找到 / 拉起 / 通知宿主守护进程"。
 *
 * TUI 进程与 hostd 本体共用这一份:指纹算法必须两边一致(否则每次调用都换代),
 * 解释器解析必须显式(m0 spike S3:pi-plus 是 bun 单文件二进制,
 * `process.execPath` 指向 pi 自己,盲用会再拉起一个 pi 而不是 hostd)。
 *
 * 纯函数(可单测,零 IO):computeFingerprint / resolveInterpreter / planHostd。
 * 其余是薄薄一层文件与进程操作。
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MeshPaths } from "./types.ts";
import { HOSTD_START_TIMEOUT_MS, HOSTD_TERM_WAIT_MS, STALE_MS } from "./types.ts";
import { atomicWrite, pidAlive } from "./registry.ts";

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

export interface HostdState {
	pid: number;
	started_at: number;
	heartbeat_at: number;
	/** 源码 mtime + 解释器:变了就该换代。 */
	fingerprint: string;
	exec: string;
}

export function readHostdState(p: MeshPaths): HostdState | undefined {
	try {
		const s = JSON.parse(fs.readFileSync(p.hostdState, "utf8")) as HostdState;
		return typeof s?.pid === "number" ? s : undefined;
	} catch {
		return undefined;
	}
}

export function writeHostdState(p: MeshPaths, s: HostdState): void {
	try {
		atomicWrite(p.hostdState, `${JSON.stringify(s, null, 1)}\n`);
	} catch {
		/* 根目录不可写:心跳丢失会被当成死宿主,可自愈 */
	}
}

export function clearHostdState(p: MeshPaths): void {
	try {
		fs.unlinkSync(p.hostdState);
	} catch {
		/* 已不在 */
	}
}

// ---------------------------------------------------------------------------
// 指纹(纯函数)
// ---------------------------------------------------------------------------

/** 源码最大 mtime + 文件数 + 解释器路径。解释器进指纹:node 拉起的与 bun 拉起的不该混用。 */
export function computeFingerprint(entries: Array<{ file: string; mtimeMs: number }>, exec: string): string {
	let max = 0;
	for (const e of entries) if (e.mtimeMs > max) max = e.mtimeMs;
	return `${Math.round(max)}-${entries.length}-${exec}`;
}

/** 参与指纹的源码:`index.ts` + `src/*.ts`(读不到的文件直接跳过,不让指纹算法崩)。 */
export function sourceEntries(
	extDir: string,
	readdir: (d: string) => string[] = (d) => fs.readdirSync(d),
	stat: (f: string) => { mtimeMs: number } = (f) => fs.statSync(f),
): Array<{ file: string; mtimeMs: number }> {
	const out: Array<{ file: string; mtimeMs: number }> = [];
	const push = (f: string) => {
		try {
			out.push({ file: f, mtimeMs: stat(f).mtimeMs });
		} catch {
			/* 文件不在:不参与指纹 */
		}
	};
	push(path.join(extDir, "index.ts"));
	let names: string[] = [];
	try {
		names = readdir(path.join(extDir, "src"));
	} catch {
		/* 没有 src/:只按 index.ts 算 */
	}
	for (const n of names.slice().sort()) if (n.endsWith(".ts")) push(path.join(extDir, "src", n));
	return out;
}

export function fingerprintOf(extDir: string, exec: string): string {
	return computeFingerprint(sourceEntries(extDir), exec);
}

// ---------------------------------------------------------------------------
// 解释器解析(纯函数;四级,m0 spike S3 结论)
// ---------------------------------------------------------------------------

/** node ≥23.6 默认擦除类型,flag 是给 node 22 的向下兼容,代价为零。bun 不认这个 flag。 */
export const NODE_FLAGS = ["--experimental-strip-types"];

export interface InterpreterProc {
	execPath: string;
	argv: string[];
	/** 当前运行时是不是 bun(`typeof Bun !== "undefined"`)。 */
	hasBun: boolean;
}

export type Interpreter = { exec: string; args: string[] } | { error: string };

function looksLikeNode(exec: string): boolean {
	return /(^|\/)node[0-9.]*$/.test(exec);
}

/**
 * ① `PI_MESH_HOSTD_EXEC` 覆盖 → ② 非 Bun 用 `process.execPath`(node,安全)
 * → ③ Bun 且 argv[1] 不以 `/$bunfs/` 开头(真 bun)用 execPath
 * → ④ 否则(bun 单文件二进制,如 pi-plus)`which bun` 兜 `which node`。
 */
export function resolveInterpreter(
	env: Record<string, string | undefined>,
	proc: InterpreterProc,
	which: (cmd: string) => string | undefined,
): Interpreter {
	const override = env.PI_MESH_HOSTD_EXEC?.trim();
	if (override) return { exec: override, args: looksLikeNode(override) ? [...NODE_FLAGS] : [] };
	if (!proc.hasBun) return { exec: proc.execPath, args: [...NODE_FLAGS] };
	if (!(proc.argv[1] ?? "").startsWith("/$bunfs/")) return { exec: proc.execPath, args: [] };
	const bun = which("bun");
	if (bun) return { exec: bun, args: [] };
	const node = which("node");
	if (node) return { exec: node, args: [...NODE_FLAGS] };
	return { error: "找不到可用解释器(bun/node 都不在 PATH): 请设 PI_MESH_HOSTD_EXEC=<node 或 bun 的绝对路径>" };
}

export function whichCmd(cmd: string): string | undefined {
	try {
		const out = execFileSync("/usr/bin/env", ["which", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out.split("\n")[0] || undefined;
	} catch {
		return undefined;
	}
}

export function currentInterpreter(): Interpreter {
	return resolveInterpreter(
		process.env,
		{ execPath: process.execPath, argv: process.argv, hasBun: typeof (globalThis as Record<string, unknown>).Bun !== "undefined" },
		whichCmd,
	);
}

// ---------------------------------------------------------------------------
// 该不该拉起(纯函数)
// ---------------------------------------------------------------------------

export type HostdPlan = { action: "ok" } | { action: "start"; why: string } | { action: "replace"; pid: number; why: string };

export function planHostd(a: { state?: HostdState; alive: boolean; now: number; fingerprint: string; staleMs?: number }): HostdPlan {
	const staleMs = a.staleMs ?? STALE_MS;
	if (!a.state) return { action: "start", why: "没有 hostd.json" };
	if (!a.alive) return { action: "start", why: `pid ${a.state.pid} 已不在` };
	if (a.now - a.state.heartbeat_at > staleMs) return { action: "replace", pid: a.state.pid, why: "心跳超期" };
	if (a.state.fingerprint !== a.fingerprint) return { action: "replace", pid: a.state.pid, why: "指纹不一致(源码或解释器已变)" };
	return { action: "ok" };
}

// ---------------------------------------------------------------------------
// 单例锁(与寄宿锁同构:O_EXCL 写 pid,死 pid 可破)
// ---------------------------------------------------------------------------

export function hostdLockHolder(p: MeshPaths): number | undefined {
	try {
		const n = Number(fs.readFileSync(p.hostdLock, "utf8").trim());
		return Number.isFinite(n) ? n : undefined;
	} catch {
		return undefined;
	}
}

export function acquireHostdLock(p: MeshPaths, pid: number): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(p.hostdLock, String(pid), { flag: "wx" });
			return true;
		} catch {
			const holder = hostdLockHolder(p);
			if (holder === pid) return true;
			if (holder !== undefined && pidAlive(holder)) return false;
			try {
				fs.unlinkSync(p.hostdLock);
			} catch {
				/* 竞争者先破 */
			}
		}
	}
	return false;
}

export function releaseHostdLock(p: MeshPaths, pid: number): void {
	if (hostdLockHolder(p) !== pid) return;
	try {
		fs.unlinkSync(p.hostdLock);
	} catch {
		/* 已不在 */
	}
}

// ---------------------------------------------------------------------------
// ensureHostd(拉起 / 换代 / 确认活着)
// ---------------------------------------------------------------------------

export interface EnsureResult {
	status: "alive" | "started" | "failed";
	pid?: number;
	error?: string;
}

export interface EnsureOptions {
	interpreter?: Interpreter;
	fingerprint?: string;
	now?: () => number;
	waitMs?: number;
	/** 注入点:测试用假启动器(不真 spawn 进程)。返回子进程 pid。 */
	launch?: (exec: string, args: string[], logFile: string) => number | undefined;
	/** 注入点:测试用假的"进程还在吗"。 */
	alive?: (pid: number) => boolean;
	kill?: (pid: number) => void;
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => {
		const t = setTimeout(r, ms);
		t.unref?.();
	});
}

function defaultLaunch(exec: string, args: string[], logFile: string): number | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(logFile, "a");
	} catch {
		fd = undefined;
	}
	try {
		const child = spawn(exec, args, {
			detached: true,
			stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
			env: { ...process.env, PI_MESH_HOSTD: "1" },
		});
		child.unref();
		return child.pid;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* 已关 */
			}
		}
	}
}

/** hostd 本体的路径(与指纹用的 extDir 同源)。 */
export function hostdEntry(extDir: string): string {
	return path.join(extDir, "src", "hostd.ts");
}

/**
 * 确保宿主守护进程活着且是当前这一代。
 * 不活/指纹不一致 → 先 SIGTERM 旧的(等 ≤3s),再 detached spawn,等 hostd.json 心跳 ≤5s。
 */
export async function ensureHostd(paths: MeshPaths, extDir: string, opts: EnsureOptions = {}): Promise<EnsureResult> {
	const interp = opts.interpreter ?? currentInterpreter();
	if ("error" in interp) return { status: "failed", error: interp.error };
	const now = opts.now ?? (() => Date.now());
	const alive = opts.alive ?? pidAlive;
	const fingerprint = opts.fingerprint ?? fingerprintOf(extDir, interp.exec);
	const state = readHostdState(paths);
	const plan = planHostd({ state, alive: alive(state?.pid ?? 0), now: now(), fingerprint });
	if (plan.action === "ok") return { status: "alive", pid: state?.pid };
	if (plan.action === "replace") {
		try {
			(opts.kill ?? ((pid: number) => process.kill(pid, "SIGTERM")))(plan.pid);
		} catch {
			/* 已退出 */
		}
		const deadline = Date.now() + HOSTD_TERM_WAIT_MS;
		while (Date.now() < deadline && alive(plan.pid)) await delay(50);
		clearHostdState(paths);
	}
	let pid: number | undefined;
	try {
		fs.mkdirSync(paths.root, { recursive: true });
		pid = (opts.launch ?? defaultLaunch)(interp.exec, [...interp.args, hostdEntry(extDir), paths.root], paths.hostdLog);
	} catch (err) {
		return { status: "failed", error: `拉起宿主失败: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!pid) return { status: "failed", error: "拉起宿主失败: spawn 未返回 pid" };
	const waitMs = opts.waitMs ?? HOSTD_START_TIMEOUT_MS;
	const deadline = Date.now() + waitMs;
	for (;;) {
		const s = readHostdState(paths);
		if (s && now() - s.heartbeat_at < waitMs && alive(s.pid)) return { status: "started", pid: s.pid };
		if (Date.now() >= deadline) {
			return { status: "failed", pid, error: `宿主进程 ${pid} 启动后 ${Math.round(waitMs / 1000)}s 内无心跳(日志: ${paths.hostdLog})` };
		}
		await delay(100);
	}
}

/** `/mesh` 文本总览末尾那一行。 */
export function hostdStatusLine(paths: MeshPaths, extDir: string, now = Date.now()): string {
	const interp = currentInterpreter();
	if ("error" in interp) return `hostd: 无法解析解释器 —— ${interp.error}`;
	const fp = fingerprintOf(extDir, interp.exec);
	const s = readHostdState(paths);
	if (!s) return "hostd: 未运行(下次 agent()/send 唤醒时自动拉起)";
	const live = pidAlive(s.pid);
	return `hostd: pid ${s.pid} ${live ? "在跑" : "已死(下次调用会重拉)"} · 心跳 ${Math.round((now - s.heartbeat_at) / 1000)}s 前 · 指纹${
		s.fingerprint === fp ? "一致" : "不一致(下次调用会换代)"
	} · ${s.exec}`;
}

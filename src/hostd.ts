/**
 * mesh-hostd —— 宿主守护进程(§4:宿主与终端解耦)。
 *
 * 为什么:数据回放里 122 例 stopped 有 89 例是"宿主进程退出" —— 人关一个终端,
 * 一整棵还在干活的树陪葬。宿主退出是物理,不该是判断者要处理的事件,
 * 更不该是工人的死因。所以宿主搬出终端,住进一个自己的进程。
 *
 * ## 启动
 * ```
 * node --experimental-strip-types src/hostd.ts [meshRoot]   # meshRoot 缺省 ~/.pi/agent/mesh
 * bun src/hostd.ts [meshRoot]                               # bun 同样直接跑 .ts
 * ```
 * 平时不用手动启动:任何 pi 进程在 `agent()` / `send` 到 dormant agent 时,
 * 由 `src/hostd-launch.ts` 的 `ensureHostd()` detached spawn 出来(解释器四级解析,
 * 见 m0 spike S3 —— pi-plus 是 bun 单文件二进制,`process.execPath` 不能盲用)。
 *
 * ## 文件
 * - 单例锁 `<meshRoot>/hostd.lock`(O_EXCL 写 pid,死 pid 可破)
 * - 状态   `<meshRoot>/hostd.json` `{pid, started_at, heartbeat_at, fingerprint, exec}`,15s 心跳
 * - 日志   `<meshRoot>/hostd.log`(append,一行一事件)
 *
 * ## 生命周期
 * - 循环:立即 sweep;`fs.watch(mailbox,{recursive:true})` 去抖 200ms;
 *   15s sweep 兜底;15s 心跳与 checkVitals。
 * - 自退:连续 10 分钟没有寄宿循环、也没有待投的 message → 释放锁、删状态、exit 0。
 * - 信号:SIGTERM/SIGINT → `host.shutdown({handover:true})`(**交接不是终局**:
 *   给每个工人自己的信箱留一封交接信,不发 stopped 讣告),然后退出。
 * - 未捕获异常:写日志后 exit 1;下一次 `ensureHostd` 会重拉,
 *   而破锁者的 sweep 会给工人投复活信(不发 died)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "./host.ts";
import type { SessionFactory } from "./host.ts";
import { listMail, pendingBySid } from "./mailbox.ts";
import { ensureDirs, readPresence } from "./registry.ts";
import {
	acquireHostdLock,
	clearHostdState,
	currentInterpreter,
	fingerprintOf,
	hostdLockHolder,
	releaseHostdLock,
	writeHostdState,
} from "./hostd-launch.ts";
import type { MeshPaths } from "./types.ts";
import {
	DEFAULT_MESH_ROOT,
	HEARTBEAT_MS,
	HOSTD_IDLE_EXIT_MS,
	HOSTD_WATCH_DEBOUNCE_MS,
	MAX_RUNNING,
	SWEEP_MS,
	isWakeWorthy,
	meshPaths,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 本体(库形态:测试用 FakeFactory 直接驱动 tick(),不真 spawn 进程)
// ---------------------------------------------------------------------------

export interface HostdDeps {
	paths: MeshPaths;
	factory: SessionFactory;
	pid: number;
	cap: number;
	fingerprint?: string;
	exec?: string;
	/** 时间注入(空闲自退的判定要能在测试里快进)。 */
	now?: () => number;
	idleExitMs?: number;
	/** 统一由 Host 合批,watcher、巡检与宿主内 send 不得各开一扇窗。 */
	wakeBatchMs?: number;
	log?: (line: string) => void;
}

export interface Hostd {
	host: Host;
	startedAt: number;
	/** 一次巡检:收敲门信号 → sweep → 体征 → 更新空闲计时。 */
	tick(): Promise<void>;
	/** 心跳:替寄宿会话续命 presence,并刷新 hostd.json。 */
	heartbeat(): void;
	/** 该自退了吗(连续空闲够久)。 */
	shouldExit(): boolean;
	/** 优雅退出:默认交接语义(不发 stopped 讣告),释放锁并清状态。 */
	stop(opts?: { handover?: boolean }): void;
}

export function createHostd(deps: HostdDeps): Hostd {
	const now = deps.now ?? (() => Date.now());
	const idleExitMs = deps.idleExitMs ?? HOSTD_IDLE_EXIT_MS;
	const log = deps.log ?? (() => {});
	const startedAt = now();
	const host = new Host({
		paths: deps.paths,
		factory: deps.factory,
		pid: deps.pid,
		cap: deps.cap,
		wakeBatchMs: deps.wakeBatchMs,
		// 崩溃复活的"宿主还在吗":我就是宿主。
		ensureHostd: async () => ({ ok: true }),
	});
	let idleSince: number | undefined = startedAt;

	/** 还有 agent 在等值得唤醒的信吗(human 信箱不算 —— 那是人回来才看的)。 */
	function pendingAgentMessages(): boolean {
		for (const [sid] of pendingBySid(deps.paths)) {
			if (readPresence(deps.paths, sid)?.kind !== "agent") continue;
			if (listMail(deps.paths, sid).some(({ msg }) => isWakeWorthy(msg))) return true;
		}
		return false;
	}

	async function tick(): Promise<void> {
		await host.sweep();
		host.checkVitals();
		const busy = host.hostedCount() > 0 || pendingAgentMessages();
		if (busy) idleSince = undefined;
		else if (idleSince === undefined) idleSince = now();
	}

	return {
		host,
		startedAt,
		tick,
		heartbeat(): void {
			host.heartbeat();
			writeHostdState(deps.paths, {
				pid: deps.pid,
				started_at: startedAt,
				heartbeat_at: now(),
				fingerprint: deps.fingerprint ?? "",
				exec: deps.exec ?? "",
			});
		},
		shouldExit(): boolean {
			return idleSince !== undefined && now() - idleSince >= idleExitMs;
		},
		stop(opts = {}): void {
			host.shutdown({ handover: opts.handover ?? true });
			releaseHostdLock(deps.paths, deps.pid);
			clearHostdState(deps.paths);
		},
	};
}

// ---------------------------------------------------------------------------
// 进程入口
// ---------------------------------------------------------------------------

function readPrompt(extDir: string, name: string): string {
	try {
		return fs.readFileSync(path.join(extDir, "prompts", name), "utf8");
	} catch {
		return "";
	}
}

async function main(): Promise<void> {
	const extDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
	const paths = meshPaths(process.argv[2] || DEFAULT_MESH_ROOT);
	ensureDirs(paths);
	const log = (line: string) => {
		try {
			fs.appendFileSync(paths.hostdLog, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
		} catch {
			/* 日志写不了也不该拖死宿主 */
		}
	};

	// 单例:第二个 hostd 拿不到锁就走(不是错误,是竞态的正常收场)。
	if (!acquireHostdLock(paths, process.pid)) {
		log(`另一个 hostd(pid ${hostdLockHolder(paths) ?? "?"})已在运行, 退出`);
		process.exit(0);
	}

	const interp = currentInterpreter();
	const exec = "error" in interp ? process.execPath : interp.exec;
	const fingerprint = fingerprintOf(extDir, exec);

	// 延迟到拿锁之后再加载 SDK:抢锁失败的那个进程不必付这份构造成本。
	const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { makeFactory, makeResolveModel } = await import("./factory.ts");
	const { createKernel } = await import("./kernel.ts");
	const { TOOL_DEFS } = await import("./tools.ts");

	const runtime = await ModelRuntime.create();
	const registry = new ModelRegistry(runtime);
	let kernel: ReturnType<typeof createKernel> | undefined;
	const factory = makeFactory({
		paths,
		registry: () => registry,
		agentFacts: readPrompt(extDir, "agent-facts.md"),
		kernel: () => kernel,
		toolDefs: TOOL_DEFS,
	});
	const hostd = createHostd({
		paths,
		factory,
		pid: process.pid,
		cap: MAX_RUNNING,
		fingerprint,
		exec,
		log,
	});
	// 寄宿在这里的 agent 用的内核就是"进程内寄宿"的那一支 —— 它自己就是宿主。
	kernel = createKernel({
		paths,
		host: hostd.host,
		cap: MAX_RUNNING,
		selfSid: () => undefined, // 守护进程没有 human 会话
		resolveModel: makeResolveModel(() => registry),
		nudgeSelf: () => {},
	});

	let exiting = false;
	const bye = (code: number, why: string) => {
		if (exiting) return;
		exiting = true;
		log(`退出(${why})`);
		try {
			hostd.stop({ handover: true });
		} catch (err) {
			log(`交接失败: ${err instanceof Error ? err.message : String(err)}`);
		}
		process.exit(code);
	};

	let ticking = false;
	let again = false;
	const safeTick = async (): Promise<void> => {
		if (ticking) {
			again = true;
			return;
		}
		ticking = true;
		try {
			do {
				again = false;
				await hostd.tick();
			} while (again);
		} catch (err) {
			log(`tick 异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
		} finally {
			ticking = false;
		}
	};

	// fs.watch 的事件粒度在 node/bun 之间不一致(m0 S3),回调只当"有动静"用。
	let debounce: ReturnType<typeof setTimeout> | null = null;
	const poke = () => {
		if (debounce) return;
		debounce = setTimeout(() => {
			debounce = null;
			void safeTick();
		}, HOSTD_WATCH_DEBOUNCE_MS);
		debounce.unref?.();
	};
	try {
		fs.watch(paths.mailbox, { recursive: true }, poke);
	} catch (err) {
		log(`watch ${paths.mailbox} 失败(只剩 ${SWEEP_MS}ms sweep 兜底): ${err instanceof Error ? err.message : String(err)}`);
	}

	setInterval(() => void safeTick(), SWEEP_MS).unref?.();
	setInterval(() => {
		hostd.heartbeat();
		if (hostd.shouldExit()) bye(0, `空闲 ${Math.round(HOSTD_IDLE_EXIT_MS / 60_000)} 分钟`);
	}, HEARTBEAT_MS);

	process.on("SIGTERM", () => bye(0, "SIGTERM"));
	process.on("SIGINT", () => bye(0, "SIGINT"));
	process.on("uncaughtException", (err) => {
		log(`未捕获异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
		bye(1, "未捕获异常");
	});
	process.on("unhandledRejection", (err) => {
		log(`未处理的 rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	});

	hostd.heartbeat(); // 拉起方等的就是这一下心跳
	log(`up pid=${process.pid} root=${paths.root} exec=${exec} fingerprint=${fingerprint}`);
	await safeTick();
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) void main();

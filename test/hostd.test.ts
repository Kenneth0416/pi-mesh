/**
 * §4 宿主守护进程的单测(零网络、零真进程)。
 *
 * hostd 本体以**库形态**驱动:`createHostd({factory: FakeFactory, now, …})` 返回
 * `{tick, heartbeat, shouldExit, stop}`,测试自己推时间与轮次 —— 不 spawn 真进程。
 * 拉起侧(解释器解析 / 指纹 / 该不该换代)是纯函数,直接算。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { FakeFactory, agentPresence, humanPresence, legacySpawn, tmpMesh, waitFor } from "./helpers.ts";
import { Host } from "../src/host.ts";
import { createHostd } from "../src/hostd.ts";
import {
	acquireHostdLock,
	computeFingerprint,
	ensureHostd,
	hostdLockHolder,
	planHostd,
	releaseHostdLock,
	resolveInterpreter,
	writeHostdState,
} from "../src/hostd-launch.ts";
import type { HostdState } from "../src/hostd-launch.ts";
import { createKernel } from "../src/kernel.ts";
import { consumeMail, listMail, newMessageId, pendingCount, sendMail } from "../src/mailbox.ts";
import { claimAlias, patchPresence, readPresence } from "../src/registry.ts";
import type { MeshPaths, MessageIntent, Presence } from "../src/types.ts";

function notices(p: MeshPaths, sid: string) {
	return listMail(p, sid).filter(({ msg }) => msg.kind === "notice");
}

function messages(p: MeshPaths, sid: string) {
	return listMail(p, sid).filter(({ msg }) => msg.kind === "message");
}

/** 按 alias 从 registry 里捞真身(返回值里的 session_id 是截断的展示用字段)。 */
function findWorker(p: MeshPaths, alias: string): Presence {
	const found = fs
		.readdirSync(p.registry)
		.filter((x) => x.endsWith(".json"))
		.map((x) => JSON.parse(fs.readFileSync(path.join(p.registry, x), "utf8")) as Presence)
		.find((x) => x.alias === alias);
	assert.ok(found, `registry 里没有 ${alias}`);
	return found;
}

// ---------------------------------------------------------------------------
// 拉起侧的纯函数
// ---------------------------------------------------------------------------

test("fingerprint: 最大 mtime + 文件数 + 解释器; 任何一项变了就是新一代", () => {
	const a = computeFingerprint(
		[
			{ file: "index.ts", mtimeMs: 100 },
			{ file: "src/host.ts", mtimeMs: 300 },
		],
		"/usr/bin/node",
	);
	// 顺序无关,取最大
	assert.equal(
		a,
		computeFingerprint(
			[
				{ file: "src/host.ts", mtimeMs: 300 },
				{ file: "index.ts", mtimeMs: 100 },
			],
			"/usr/bin/node",
		),
	);
	// 改了某个文件 → 变
	assert.notEqual(a, computeFingerprint([{ file: "index.ts", mtimeMs: 100 }, { file: "src/host.ts", mtimeMs: 301 }], "/usr/bin/node"));
	// 多了一个文件(mtime 不变)→ 变
	assert.notEqual(
		a,
		computeFingerprint(
			[
				{ file: "index.ts", mtimeMs: 100 },
				{ file: "src/host.ts", mtimeMs: 300 },
				{ file: "src/hostd.ts", mtimeMs: 200 },
			],
			"/usr/bin/node",
		),
	);
	// 换了解释器 → 变(node 拉起的与 bun 拉起的不该混用)
	assert.notEqual(a, computeFingerprint([{ file: "index.ts", mtimeMs: 100 }, { file: "src/host.ts", mtimeMs: 300 }], "/opt/homebrew/bin/bun"));
	assert.equal(computeFingerprint([], "/usr/bin/node"), "0-0-/usr/bin/node");
});

test("解释器四级解析: env 覆盖 > node execPath > 真 bun execPath > which(pi-plus 的单文件二进制)", () => {
	const which = (cmd: string) => (cmd === "bun" ? "/opt/homebrew/bin/bun" : cmd === "node" ? "/usr/local/bin/node" : undefined);
	// ① env 覆盖(node 样的路径带 strip-types flag)
	assert.deepEqual(resolveInterpreter({ PI_MESH_HOSTD_EXEC: "/x/node" }, { execPath: "/pi", argv: [], hasBun: true }, which), {
		exec: "/x/node",
		args: ["--experimental-strip-types"],
	});
	assert.deepEqual(resolveInterpreter({ PI_MESH_HOSTD_EXEC: "/x/bun" }, { execPath: "/pi", argv: [], hasBun: true }, which), {
		exec: "/x/bun",
		args: [],
	});
	// ② 非 Bun → execPath(node,安全)
	assert.deepEqual(resolveInterpreter({}, { execPath: "/usr/bin/node", argv: ["node", "/x/pi"], hasBun: false }, which), {
		exec: "/usr/bin/node",
		args: ["--experimental-strip-types"],
	});
	// ③ 真 bun(argv[1] 是真实路径)→ execPath,不加 node flag
	assert.deepEqual(resolveInterpreter({}, { execPath: "/opt/homebrew/bin/bun", argv: ["bun", "/x/run.ts"], hasBun: true }, which), {
		exec: "/opt/homebrew/bin/bun",
		args: [],
	});
	// ④ bun 单文件二进制(pi-plus):execPath 指向 pi 自己 → which bun
	assert.deepEqual(resolveInterpreter({}, { execPath: "/Users/me/.local/bin/pi-plus", argv: ["bun", "/$bunfs/root/pi-plus"], hasBun: true }, which), {
		exec: "/opt/homebrew/bin/bun",
		args: [],
	});
	// ④' 没有 bun 就退 node
	assert.deepEqual(
		resolveInterpreter({}, { execPath: "/x/pi-plus", argv: ["bun", "/$bunfs/root/pi-plus"], hasBun: true }, (c) =>
			c === "node" ? "/usr/local/bin/node" : undefined,
		),
		{ exec: "/usr/local/bin/node", args: ["--experimental-strip-types"] },
	);
	// ④'' 两个都没有 → 报错让人配 env
	const bad = resolveInterpreter({}, { execPath: "/x/pi-plus", argv: ["bun", "/$bunfs/root/pi-plus"], hasBun: true }, () => undefined);
	assert.ok("error" in bad && bad.error.includes("PI_MESH_HOSTD_EXEC"));
});

test("planHostd: 没有/死了 → start; 心跳超期或指纹不一致 → replace; 否则 ok", () => {
	const state: HostdState = { pid: 42, started_at: 0, heartbeat_at: 1_000, fingerprint: "fp", exec: "/usr/bin/node" };
	assert.equal(planHostd({ alive: false, now: 1_000, fingerprint: "fp" }).action, "start");
	assert.equal(planHostd({ state, alive: false, now: 1_000, fingerprint: "fp" }).action, "start");
	assert.equal(planHostd({ state, alive: true, now: 1_000, fingerprint: "fp" }).action, "ok");
	const stale = planHostd({ state, alive: true, now: 1_000_000, fingerprint: "fp" });
	assert.equal(stale.action, "replace");
	assert.equal((stale as { pid: number }).pid, 42);
	const gen = planHostd({ state, alive: true, now: 1_000, fingerprint: "fp2" });
	assert.equal(gen.action, "replace");
	assert.ok((gen as { why: string }).why.includes("指纹"));
});

test("单例锁: 第二个 hostd 拿不到锁; 死 pid 的锁可破; 释放后可再取", () => {
	const p = tmpMesh();
	assert.equal(acquireHostdLock(p, process.pid), true);
	assert.equal(hostdLockHolder(p), process.pid);
	// 另一个活着的进程(自己冒充别人)抢不到
	assert.equal(acquireHostdLock(p, process.pid + 1), false);
	// 自己再取仍是 true(幂等)
	assert.equal(acquireHostdLock(p, process.pid), true);
	releaseHostdLock(p, process.pid);
	assert.equal(hostdLockHolder(p), undefined);
	// 死 pid 留下的锁可破
	fs.writeFileSync(p.hostdLock, "999999999");
	assert.equal(acquireHostdLock(p, process.pid), true);
});

test("ensureHostd: 活着就不重拉; 指纹不一致先 SIGTERM 再拉; 拉起后没心跳 → failed", async () => {
	const p = tmpMesh();
	const interpreter = { exec: "/usr/bin/node", args: ["--experimental-strip-types"] };
	const launched: Array<{ exec: string; args: string[] }> = [];
	let alivePid = 0;
	const alive = (pid: number) => pid !== 0 && pid === alivePid;
	// 假启动器:写一份"刚拉起来"的状态文件,等价于真 hostd 的第一次心跳
	const launch = (exec: string, args: string[]) => {
		launched.push({ exec, args });
		alivePid = 4242;
		writeHostdState(p, { pid: 4242, started_at: Date.now(), heartbeat_at: Date.now(), fingerprint: "fp", exec });
		return 4242;
	};
	const base = { interpreter, fingerprint: "fp", alive, launch, waitMs: 500 };

	// 没有状态文件 → start
	const r1 = await ensureHostd(p, "/ext", base);
	assert.equal(r1.status, "started");
	assert.equal(launched.length, 1);
	assert.deepEqual(launched[0], { exec: "/usr/bin/node", args: ["--experimental-strip-types", "/ext/src/hostd.ts", p.root] });

	// 活着且指纹一致 → 不重拉
	const r2 = await ensureHostd(p, "/ext", base);
	assert.equal(r2.status, "alive");
	assert.equal(launched.length, 1);

	// 指纹不一致 → SIGTERM 旧的再拉(换代)
	const killed: number[] = [];
	const r3 = await ensureHostd(p, "/ext", { ...base, fingerprint: "fp2", kill: (pid) => killed.push(pid) });
	assert.equal(r3.status, "started");
	assert.deepEqual(killed, [4242]);
	assert.equal(launched.length, 2);

	// 拉起来了但没心跳 → failed(错误里指向日志)
	const dead = await ensureHostd(p, "/ext", {
		...base,
		alive: () => false,
		launch: () => 777,
		waitMs: 120,
	});
	assert.equal(dead.status, "failed");
	assert.ok(dead.error?.includes("无心跳"));
	assert.ok(dead.error?.includes("hostd.log"));
});

// ---------------------------------------------------------------------------
// TUI 侧:只留信 + 敲门
// ---------------------------------------------------------------------------

function tuiSetup() {
	const p = tmpMesh();
	const me = humanPresence(p, "ken", { live: true });
	claimAlias(p, "ken", me.sid);
	const f = new FakeFactory(); // TUI 没有 Host: 这个工厂必须一次都不被碰
	const ensured: number[] = [];
	const kernel = createKernel({
		paths: p,
		cap: 8,
		selfSid: () => me.sid,
		resolveModel: (ref) => ({ model: ref }),
		nudgeSelf: () => {},
		ensureHostd: async () => {
			ensured.push(Date.now());
			return { ok: true };
		},
	});
	return { p, f, kernel, me, ensured };
}

test("TUI spawn: 只写 presence + 出生信 + 确保宿主, 一行会话都不开", async () => {
	const { p, f, kernel, me, ensured } = tuiSetup();
	const r = (await kernel.agent(me.sid, {
		body: "去干活",
		model: "acme/m1",
		tools: ["read", "bash"],
	})) as Record<string, unknown>;
	assert.equal(r.delivered, "created");
	assert.equal(r.alias, "ken-a");
	// 工厂一次都没被碰过 —— 会话由 hostd 建
	assert.equal(f.specs.length, 0);
	assert.equal(f.created.length, 0);

	// 返回值里的 session_id 是截断的(展示用),按 alias 找真身
	const worker = findWorker(p, "ken-a");
	assert.equal(worker.kind, "agent");
	assert.equal(worker.session_file, undefined, "不预写占位会话文件(0 字节会被 SDK 换 sid)");
	assert.equal(worker.host_pid, undefined, "没有宿主 → dormant, 等 hostd 唤醒");
	assert.equal(worker.depth, 1);
	assert.deepEqual(worker.tools, ["bash", "read"]);
	assert.equal(worker.model, "acme/m1");
	assert.equal(worker.thinking_level, "medium", "无创建者等级 → medium, 指定模型不升档");
	assert.equal(worker.started_by, me.sid);
	// 出生信在它自己的信箱里
	const birth = messages(p, worker.sid);
	assert.equal(birth.length, 1);
	assert.equal(birth[0].msg.body, "去干活");
	// 确保过宿主
	assert.equal(ensured.length, 1);
});

test("TUI spawn: 宿主拉不起来时如实说明(消息不丢, 留箱等 sweep)", async () => {
	const p = tmpMesh();
	const me = humanPresence(p, "ken", { live: true });
	claimAlias(p, "ken", me.sid);
	const kernel = createKernel({
		paths: p,
		cap: 8,
		selfSid: () => me.sid,
		resolveModel: (ref) => ({ model: ref }),
		nudgeSelf: () => {},
		ensureHostd: async () => ({ ok: false, error: "找不到 node" }),
	});
	const r = (await kernel.agent(me.sid, { body: "活" })) as Record<string, unknown>;
	assert.equal(r.delivered, "created");
	assert.ok(String(r.note).includes("宿主未能启动"));
	assert.ok(String(r.note).includes("留箱"));
});

test("TUI send 到 dormant agent: nudge 而不是本进程唤醒", async () => {
	const { p, f, kernel, me } = tuiSetup();
	const w = agentPresence(p, "w", { startedBy: me.sid });
	claimAlias(p, "w", w.sid);
	const r = (await kernel.send(me.sid, { target: "w", body: "醒醒" })) as Record<string, unknown>;
	assert.equal(r.delivered, "nudged");
	assert.ok(String(r.note).includes("宿主"));
	assert.equal(f.opens.length, 0, "本进程绝不寄宿");
	assert.equal(pendingCount(p, w.sid), 1, "信落盘了");
});

test("TUI 进程没有宿主: 关掉它不动 hostd 里的工人, 不发讣告", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted());
	const hostd = new Host({ paths: p, factory: f, pid: process.pid, cap: 8 });
	const r = await legacySpawn(hostd, { alias: "w", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "活" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => hostd.isHosted(sid));
	// TUI 侧只有 kernel(无 Host):它退出时只更新自己的 presence
	patchPresence(p, ken.sid, { host_pid: undefined, clean_exit: true });
	assert.equal(hostd.isHosted(sid), true, "工人还在 hostd 里跑");
	assert.equal(notices(p, ken.sid).length, 0, "TUI 退出不发讣告");
	hostd.stopLocal(sid, "收尾");
	await waitFor(() => !hostd.isHosted(sid));
});

// ---------------------------------------------------------------------------
// hostd 循环本体
// ---------------------------------------------------------------------------

function hostdSetup(opts: { now?: () => number; idleExitMs?: number; wakeBatchMs?: number } = {}) {
	const p = tmpMesh();
	const f = new FakeFactory();
	const hostd = createHostd({ paths: p, factory: f, pid: process.pid, cap: 8, fingerprint: "fp", exec: "/usr/bin/node", ...opts });
	return { p, f, hostd };
}

/** 可唤醒信都由同一个入口落盘,不依赖真实 watcher 的调度速度。 */
function wakeMail(p: MeshPaths, to: string, from: string, body: string, intent: MessageIntent = "report"): string {
	const id = newMessageId();
	sendMail(p, { id, from, to, at: Date.now(), kind: "message", body, intent });
	return id;
}

test("hostd 合并窗: 两封 report 默认等 8s,只唤醒一次且同一 prompt 注入", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const { p, f, hostd } = hostdSetup();
	t.after(() => hostd.stop());
	const sender = agentPresence(p, "sender", { live: true });
	const worker = agentPresence(p, "worker");
	f.defaultScript = (_text, s) => s.untilAborted();
	const first = wakeMail(p, worker.sid, sender.sid, "第一封汇报");
	const second = wakeMail(p, worker.sid, sender.sid, "第二封汇报");
	await hostd.tick();
	assert.equal(f.opens.length, 0);
	assert.equal(pendingCount(p, worker.sid), 2, "开窗不消费邮件");
	assert.equal(readPresence(p, worker.sid)!.wake_log, undefined, "开窗不消耗唤醒预算");
	t.mock.timers.tick(7_999);
	await hostd.tick();
	assert.equal(f.opens.length, 0);
	t.mock.timers.tick(1);
	// 定时器自己唤醒,不依赖 15s 的下一轮巡检。
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(f.opens.length, 1);
	assert.equal(f.created[0].prompts.length, 1);
	assert.ok(f.created[0].prompts[0].includes(first));
	assert.ok(f.created[0].prompts[0].includes(second));
	assert.equal(pendingCount(p, worker.sid), 0);
	assert.equal(readPresence(p, worker.sid)!.wake_log?.length, 1);
	await hostd.tick();
	assert.equal(f.opens.length, 1);
});

test("hostd 合并窗: 窗口期间再来信合并,宿主内 send 不绕过或延长窗口", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const { p, f, hostd } = hostdSetup({ wakeBatchMs: 8_000 });
	t.after(() => hostd.stop());
	const sender = agentPresence(p, "sender", { live: true });
	const worker = agentPresence(p, "worker");
	claimAlias(p, "worker", worker.sid);
	f.defaultScript = (_text, s) => s.untilAborted();
	const kernel = createKernel({ paths: p, host: hostd.host, cap: 8, selfSid: () => undefined, resolveModel: (ref) => ({ model: ref }), nudgeSelf: () => {} });
	wakeMail(p, worker.sid, sender.sid, "首封");
	await hostd.tick();
	t.mock.timers.tick(4_000);
	const result = await kernel.send(sender.sid, { target: "worker", body: "窗口中追加" }) as Record<string, unknown>;
	assert.equal(result.delivered, "mailboxed");
	assert.match(String(result.note), /合批/);
	await hostd.tick();
	assert.equal(f.opens.length, 0);
	t.mock.timers.tick(4_000);
	await hostd.tick();
	assert.equal(f.opens.length, 1);
	assert.equal(f.created[0].prompts.length, 1);
	assert.match(f.created[0].prompts[0], /首封/);
	assert.match(f.created[0].prompts[0], /窗口中追加/);
});

test("hostd 合并窗: 不同收件人各自计时,不会互相延长或提前", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const { p, f, hostd } = hostdSetup({ wakeBatchMs: 8_000 });
	t.after(() => hostd.stop());
	const sender = agentPresence(p, "sender", { live: true });
	const first = agentPresence(p, "first");
	const second = agentPresence(p, "second");
	f.defaultScript = (_text, s) => s.untilAborted();
	wakeMail(p, first.sid, sender.sid, "先开窗");
	await hostd.tick();
	t.mock.timers.tick(4_000);
	wakeMail(p, second.sid, sender.sid, "后开窗");
	await hostd.tick();
	t.mock.timers.tick(4_000);
	await hostd.tick();
	assert.deepEqual(f.opens.map(({ sid }) => sid), [first.sid]);
	t.mock.timers.tick(4_000);
	await hostd.tick();
	assert.deepEqual(f.opens.map(({ sid }) => sid), [first.sid, second.sid]);
});

for (const urgent of ["blocker", "human"] as const) {
	test(`hostd 合并窗: ${urgent} 绕过窗口立即唤醒,带上积压且取消旧定时器`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const { p, f, hostd } = hostdSetup({ wakeBatchMs: 8_000 });
		t.after(() => hostd.stop());
		const sender = agentPresence(p, "sender", { live: true });
		const human = humanPresence(p, "human");
		const worker = agentPresence(p, "worker");
		f.defaultScript = (_text, s) => s.untilAborted();
		wakeMail(p, worker.sid, sender.sid, "待合并");
		await hostd.tick();
		assert.equal(f.opens.length, 0);
		t.mock.timers.tick(1_000);
		wakeMail(p, worker.sid, urgent === "human" ? human.sid : sender.sid, "立即处理", urgent === "blocker" ? "blocker" : "report");
		await hostd.tick();
		assert.equal(f.opens.length, 1);
		assert.match(f.created[0].prompts[0], /待合并/);
		assert.match(f.created[0].prompts[0], /立即处理/);
		t.mock.timers.tick(8_000);
		await hostd.tick();
		assert.equal(f.opens.length, 1, "旧窗到点也不能二次唤醒");
	});
}

test("hostd 合并窗: notify 不开窗;待唤醒信撤走或 stop 后定时器不能空唤醒", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const { p, f, hostd } = hostdSetup({ wakeBatchMs: 8_000 });
	t.after(() => hostd.stop());
	const human = humanPresence(p, "human");
	const sender = agentPresence(p, "sender", { live: true });
	const worker = agentPresence(p, "worker");
	wakeMail(p, worker.sid, human.sid, "仅知悉", "notify");
	await hostd.tick();
	t.mock.timers.tick(8_000);
	await hostd.tick();
	assert.equal(f.opens.length, 0);
	wakeMail(p, worker.sid, sender.sid, "会被撤走");
	await hostd.tick();
	consumeMail(listMail(p, worker.sid).filter(({ msg }) => msg.intent !== "notify").map(({ file }) => file));
	t.mock.timers.tick(8_000);
	await hostd.tick();
	assert.equal(f.opens.length, 0);
	wakeMail(p, worker.sid, sender.sid, "留给下一任宿主");
	await hostd.tick();
	hostd.stop();
	t.mock.timers.tick(8_000);
	await hostd.tick();
	assert.equal(f.opens.length, 0);
	assert.equal(pendingCount(p, worker.sid), 2);
});

test("hostd 唤醒锁: open 在途时重入巡检只开一次;开好后新信走 steer", async (t) => {
	const { p, f, hostd } = hostdSetup({ wakeBatchMs: 0 });
	t.after(() => hostd.stop());
	const sender = agentPresence(p, "sender", { live: true });
	const worker = agentPresence(p, "worker");
	f.defaultScript = (_text, s) => s.untilAborted();
	let release!: () => void;
	f.beforeOpen = () => new Promise<void>((resolve) => { release = resolve; });
	wakeMail(p, worker.sid, sender.sid, "开会话前");
	const opening = hostd.tick();
	assert.equal(f.opens.length, 1);
	wakeMail(p, worker.sid, sender.sid, "open 在途中");
	await hostd.tick();
	assert.equal(await hostd.host.wake(worker.sid), "already");
	assert.equal(f.opens.length, 1);
	release();
	await opening;
	assert.match(f.created[0].prompts[0], /open 在途中/);
	wakeMail(p, worker.sid, sender.sid, "运行中追加");
	await hostd.tick();
	await waitFor(() => f.created[0].steers.length === 1);
	assert.match(f.created[0].steers[0], /运行中追加/);
	assert.equal(f.opens.length, 1);
	assert.equal(f.created[0].prompts.length, 1);
});

test("hostd tick: TUI 留下的 presence(无 session_file)被 create({id}) 建起来, 路径回写, 出生信送达", async () => {
	const { p, f, hostd } = hostdSetup();
	const ken = humanPresence(p, "ken", { live: true });
	// 模拟 TUI 侧 spawn 的产物(TUI 没有 Host)
	const kernel = createKernel({
		paths: p,
		cap: 8,
		selfSid: () => ken.sid,
		resolveModel: (ref) => ({ model: ref }),
		nudgeSelf: () => {},
		ensureHostd: async () => ({ ok: true }),
	});
	f.defaultScript = () => "干完了";
	await kernel.agent(ken.sid, { body: "去干活" });
	const worker = findWorker(p, "ken-a");
	assert.equal(worker.session_file, undefined);

	await hostd.tick();
	assert.equal(f.opens.length, 1);
	assert.equal(f.opens[0].hadFile, false, "presence 没有落盘文件 → 工厂走 create({id: sid})");
	await waitFor(() => notices(p, ken.sid).some(({ msg }) => msg.fact === "quiescent"));
	// 会话文件被回写
	assert.equal(readPresence(p, worker.sid)!.session_file, `/fake/${worker.sid}.jsonl`);
	// 出生信真的被投出去了(prompt 里带任务书)
	assert.ok(f.created[0].prompts[0].includes("去干活"));
});

test("hostd 空闲自退: 连续 10 分钟没有循环也没有待投 message; 有信就不退", async () => {
	let clock = 1_000_000;
	const { p, hostd } = hostdSetup({ now: () => clock, idleExitMs: 600_000 });
	await hostd.tick();
	assert.equal(hostd.shouldExit(), false);
	clock += 599_000;
	assert.equal(hostd.shouldExit(), false);
	clock += 2_000;
	assert.equal(hostd.shouldExit(), true, "连续空闲够久 → 自退");

	// 来了一封给 agent 的 message:空闲计时重置
	const ken = humanPresence(p, "ken", { live: true });
	const w = agentPresence(p, "w", { startedBy: ken.sid });
	const { newMessageId, sendMail } = await import("../src/mailbox.ts");
	sendMail(p, { id: newMessageId(), from: ken.sid, to: w.sid, at: clock, kind: "message", body: "活" });
	// 这一 tick 会把它唤起来(hostd 是全域宿主), 因此不空闲
	await hostd.tick();
	assert.equal(hostd.shouldExit(), false);
	hostd.stop();
});

test("hostd heartbeat: hostd.json 落盘(pid/指纹/解释器), stop 后清除且释放锁", async () => {
	const { p, hostd } = hostdSetup();
	assert.equal(acquireHostdLock(p, process.pid), true);
	hostd.heartbeat();
	const s = JSON.parse(fs.readFileSync(p.hostdState, "utf8"));
	assert.equal(s.pid, process.pid);
	assert.equal(s.fingerprint, "fp");
	assert.equal(s.exec, "/usr/bin/node");
	assert.ok(s.heartbeat_at > 0);
	hostd.stop();
	assert.equal(fs.existsSync(p.hostdState), false);
	assert.equal(hostdLockHolder(p), undefined);
});

// ---------------------------------------------------------------------------
// 生命周期:崩溃复活 / 换代交接
// ---------------------------------------------------------------------------

test("宿主崩溃 → 复活(不是讣告): 交接信 + incidents+1, 同一轮 sweep 直接重新托管续跑; 创建者收不到 died", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const orphan = agentPresence(p, "orphan", { startedBy: ken.sid, live: false });
	patchPresence(p, orphan.sid, { host_pid: 999999999, clean_exit: false }); // 崩溃宿主留下的 presence
	const f = new FakeFactory();
	f.openScripts.set(orphan.sid, () => "接着干完了");
	const host = new Host({ paths: p, factory: f, pid: process.pid, cap: 8, wakeBatchMs: 0, ensureHostd: async () => ({ ok: true }) });
	await host.sweep();
	await waitFor(() => !host.isHosted(orphan.sid) && f.opens.length === 1, 5000);
	// 交接信作为唤醒 prompt 送达, 讣告只有正常收场的 quiescent, 绝没有 died
	assert.ok(f.created[0].prompts[0].includes("崩溃"));
	assert.ok(f.created[0].prompts[0].includes("先核实副作用"));
	assert.deepEqual(notices(p, ken.sid).map(({ msg }) => msg.fact), ["quiescent"]);
	assert.equal(readPresence(p, orphan.sid)!.incidents, 1);
	// 再崩一次 → incidents 累加
	patchPresence(p, orphan.sid, { host_pid: 999999999, clean_exit: false });
	f.openScripts.set(orphan.sid, () => "又干完了");
	await host.sweep();
	await waitFor(() => f.opens.length === 2 && !host.isHosted(orphan.sid), 5000);
	assert.equal(readPresence(p, orphan.sid)!.incidents, 2);
	assert.equal(notices(p, ken.sid).filter(({ msg }) => msg.fact === "died").length, 0);
});
test("宿主崩溃且重拉失败 → 才是 died; 终局讣告带 incidents", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const orphan = agentPresence(p, "orphan", { startedBy: ken.sid, live: false });
	patchPresence(p, orphan.sid, { host_pid: 999999999, clean_exit: false });
	const host = new Host({ paths: p, factory: new FakeFactory(), pid: process.pid, cap: 8, ensureHostd: async () => ({ ok: false, error: "找不到 node" }) });
	await host.sweep();
	const ns = notices(p, ken.sid);
	assert.equal(ns.length, 1);
	assert.equal(ns[0].msg.fact, "died");
	assert.ok(ns[0].msg.data?.reason?.includes("崩溃"));
	assert.equal(ns[0].msg.data?.incidents, 1);
	assert.equal(readPresence(p, orphan.sid)!.last_fact, "died");
	assert.equal(messages(p, orphan.sid).length, 0, "没复活就不该有交接信");
});

test("handover shutdown(宿主换代): 交接信投给工人自己, 不发 stopped 讣告", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted());
	const host = new Host({ paths: p, factory: f, pid: process.pid, cap: 8 });
	const r = await legacySpawn(host, { alias: "w", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "活" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => host.isHosted(sid));

	host.shutdown({ handover: true });
	// 同步即可观察:交接信在工人自己信箱, 锁已释放
	const letters = messages(p, sid);
	assert.equal(letters.length, 1);
	assert.ok(letters[0].msg.body.includes("宿主换代"));
	assert.ok(letters[0].msg.body.includes("先核实副作用"));

	await waitFor(() => !host.isHosted(sid));
	assert.equal(notices(p, ken.sid).length, 0, "换代不是终局: 既不发 stopped 也不发 quiescent");
	assert.equal(readPresence(p, sid)!.last_fact, undefined, "last_fact 留给下一任宿主写");
	assert.equal(readPresence(p, sid)!.host_pid, undefined);
});

test("换代之后下一任 hostd 的 sweep 见 message 就把它接回来续跑", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f1 = new FakeFactory();
	f1.scripts.push((_t, s) => s.untilAborted());
	const gen1 = new Host({ paths: p, factory: f1, pid: process.pid, cap: 8 });
	const r = await legacySpawn(gen1, { alias: "w", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "活" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => gen1.isHosted(sid));
	gen1.shutdown({ handover: true });
	await waitFor(() => !gen1.isHosted(sid));

	const f2 = new FakeFactory();
	f2.defaultScript = () => "接着干完了";
	const gen2 = createHostd({ paths: p, factory: f2, pid: process.pid, cap: 8, wakeBatchMs: 0 });
	await gen2.tick();
	await waitFor(() => notices(p, ken.sid).some(({ msg }) => msg.fact === "quiescent"));
	// 接手时读到的就是那封交接信
	assert.ok(f2.created[0].prompts[0].includes("宿主换代"));
});

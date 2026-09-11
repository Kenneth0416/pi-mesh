import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FakeFactory, agentPresence, humanPresence, tmpMesh, waitFor } from "./helpers.ts";
import { Host } from "../src/host.ts";
import type { HostOptions } from "../src/host.ts";
import { createKernel, readLastAssistantText, verbsForDepth } from "../src/kernel.ts";
import type { Kernel } from "../src/kernel.ts";
import { claimAlias, patchPresence, readPresence, resolveAlias } from "../src/registry.ts";
import { listMail, pendingCount } from "../src/mailbox.ts";
import { isToolError, MAX_DEPTH, PI_NATIVE_TOOLS, TREE_MAX_LIVE } from "../src/types.ts";
import type { MeshPaths, Presence } from "../src/types.ts";

function setup(
	cap = 8,
	hostOpts: Partial<HostOptions> = {},
): { p: MeshPaths; f: FakeFactory; host: Host; kernel: Kernel; me: Presence; nudges: () => number } {
	const p = tmpMesh();
	const me = humanPresence(p, "ken", { live: true });
	claimAlias(p, "ken", me.sid);
	const f = new FakeFactory();
	const host = new Host({ paths: p, factory: f, pid: process.pid, cap, wakeBatchMs: 0, ...hostOpts });
	let nudged = 0;
	const kernel = createKernel({
		paths: p,
		host,
		cap,
		selfSid: () => me.sid,
		resolveModel: (ref) => (ref.startsWith("bad/") ? { error: `未知模型 "${ref}"` } : { model: ref }),
		nudgeSelf: () => nudged++,
	});
	return { p, f, host, kernel, me, nudges: () => nudged };
}

test("agent() = 派活: 出生→干活→quiescent 讣告回到我信箱; alias 自动生成并绑定真身", async () => {
	const { p, f, kernel, me } = setup();
	f.scripts.push(() => "done!");
	const r = (await kernel.agent(me.sid, { body: "干活" })) as Record<string, unknown>;
	assert.equal(r.delivered, "created");
	assert.equal(r.alias, "ken-a");
	await waitFor(() => listMail(p, me.sid).some(({ msg }) => msg.fact === "quiescent"));
	// alias 绑定到真 sid
	const deep = kernel.sessions(me.sid, { id: "ken-a" }) as Record<string, unknown>;
	assert.equal(deep.alias, "ken-a");
	assert.equal(deep.started_by, "ken");
});

test("形状约束: depth 1 的子代可再派一层, depth 2 被拒; 委派仍不得提权", async () => {
	const { p, f, kernel, me } = setup();
	// human(0) → planner(1) → worker(2)
	const planner = agentPresence(p, "planner", { startedBy: me.sid, tools: ["read"], live: true });
	claimAlias(p, "planner", planner.sid);
	f.scripts.push(() => "ok");
	const r1 = (await kernel.agent(planner.sid, { body: "查点东西" })) as Record<string, unknown>;
	assert.equal(r1.delivered, "created"); // 撤销了"只有 human 能派"
	assert.equal(f.specs.at(-1)!.depth, 2); // 子会话自己的深度随 spec 下传(工厂据此决定动词集)

	const worker = agentPresence(p, "worker", { startedBy: planner.sid, tools: ["read"], live: true });
	claimAlias(p, "worker", worker.sid);
	const r2 = await kernel.agent(worker.sid, { body: "x" });
	assert.ok(isToolError(r2) && r2.error.code === "refuse");
	assert.ok(r2.error.message.includes(`深度已达 ${MAX_DEPTH}`));
	assert.ok(r2.error.message.includes("send"));

	// 提权照旧拒绝(护栏律 2 与形状约束正交)
	const r3 = await kernel.agent(planner.sid, { body: "x", tools: ["bash"] });
	assert.ok(isToolError(r3) && r3.error.code === "escalation");

	const r4 = (await kernel.agent(me.sid, { body: "x", tools: ["rm_rf"] })) as unknown;
	assert.ok(isToolError(r4) && r4.error.code === "unknown_tool");
	f.scripts.push(() => "ok");
	const r5 = (await kernel.agent(me.sid, { body: "x" })) as Record<string, unknown>;
	assert.equal(r5.delivered, "created");
	assert.deepEqual(r5.tools, [...PI_NATIVE_TOOLS].sort());
	assert.equal(f.specs.at(-1)!.depth, 1);
});

test("形状约束: 同一树内活跃 agent 达上限即拒绝(别的树不受牵连)", async () => {
	const { p, f, kernel, me } = setup(100); // 全局并发放开, 只测树内宽度
	for (let i = 0; i < TREE_MAX_LIVE; i++) agentPresence(p, `w${i}`, { startedBy: me.sid, live: true });
	const r = await kernel.agent(me.sid, { body: "再来一个" });
	assert.ok(isToolError(r) && r.error.code === "tree_full");
	assert.ok(r.error.message.includes(`${TREE_MAX_LIVE}/${TREE_MAX_LIVE}`));
	assert.equal(f.created.length, 0);
	// 别人的树:活跃计数按 human root 分开
	const other = humanPresence(p, "other", { live: true });
	f.scripts.push(() => "ok");
	const r2 = (await kernel.agent(other.sid, { body: "x" })) as Record<string, unknown>;
	assert.equal(r2.delivered, "created");
});

test("能力即先验: 子会话动词集按自己的深度含/不含 agent", () => {
	assert.deepEqual(verbsForDepth(0), ["agent", "send", "sessions", "stop"]);
	assert.deepEqual(verbsForDepth(MAX_DEPTH - 1), ["agent", "send", "sessions", "stop"]);
	assert.deepEqual(verbsForDepth(MAX_DEPTH), ["send", "sessions", "stop"]);
	assert.deepEqual(verbsForDepth(MAX_DEPTH + 1), ["send", "sessions", "stop"]);
});

test("send 路由: 给自己=queued+nudge; 给 dormant human=留信; 给 dormant agent=唤醒", async () => {
	const { p, f, kernel, me, nudges } = setup();
	// 给自己
	const self = (await kernel.send(me.sid, { target: "ken", body: "备忘" })) as Record<string, unknown>;
	assert.equal(self.delivered, "queued");
	assert.equal(nudges(), 1);
	assert.equal(pendingCount(p, me.sid), 1);
	// 给 dormant human: 只留信
	const bob = humanPresence(p, "bob", { live: false });
	claimAlias(p, "bob", bob.sid);
	const r2 = (await kernel.send(me.sid, { target: "bob", body: "hi bob" })) as Record<string, unknown>;
	assert.equal(r2.delivered, "mailboxed");
	assert.ok(String(r2.note).includes("human"));
	// 给 dormant agent: 唤醒
	const w = agentPresence(p, "sleepy", { startedBy: me.sid });
	claimAlias(p, "sleepy", w.sid);
	f.openScripts.set(w.sid, () => "被唤醒并干完");
	const r3 = (await kernel.send(me.sid, { target: "sleepy", body: "续跑" })) as Record<string, unknown>;
	assert.equal(r3.delivered, "woken");
	await waitFor(() => listMail(p, me.sid).some(({ msg }) => msg.fact === "quiescent"));
	assert.ok(f.created[0].prompts[0].includes("续跑"));
});

test("寻址防呆: 未知 to 列候选; message 空拒绝; agent 的 model fail-fast 与 alias 冲突", async () => {
	const { kernel, me, f } = setup();
	const r1 = await kernel.send(me.sid, { target: "ghost", body: "x" });
	assert.ok(isToolError(r1) && r1.error.message.includes("ken"));
	assert.ok(isToolError(r1) && r1.error.message.includes("agent 工具")); // 候选里指路到 agent
	const r2 = await kernel.send(me.sid, { target: "ken", body: "  " });
	assert.ok(isToolError(r2) && r2.error.code === "invalid_params");
	const r3 = await kernel.agent(me.sid, { body: "x", model: "bad/model" });
	assert.ok(isToolError(r3) && r3.error.code === "unknown_model");
	const r0 = await kernel.agent(me.sid, { body: "   " });
	assert.ok(isToolError(r0) && r0.error.code === "invalid_params"); // task 空
	f.scripts.push(() => "a");
	await kernel.agent(me.sid, { body: "x", alias: "dup" });
	const r4 = await kernel.agent(me.sid, { body: "x", alias: "dup" });
	assert.ok(isToolError(r4) && r4.error.code === "alias_taken");
});

test("spawn 失败回收 alias 占位(创建会话炸了不留死名字)", async () => {
	const { f, kernel, me } = setup();
	f.failCreate = "模型 auth 失效";
	const r = await kernel.agent(me.sid, { body: "x", alias: "doomed" });
	assert.ok(isToolError(r) && r.error.code === "spawn_failed");
	f.failCreate = undefined;
	f.scripts.push(() => "ok");
	// 名字可复用
	const r2 = (await kernel.agent(me.sid, { body: "x", alias: "doomed" })) as Record<string, unknown>;
	assert.equal(r2.delivered, "created");
});

test("sessions 列表与深查: state/unread/last_note/子会话", async () => {
	const { p, f, kernel, me } = setup();
	f.scripts.push((_t, s) => s.untilAborted());
	const r = (await kernel.agent(me.sid, { body: "跑着", alias: "runner" })) as Record<string, unknown>;
	assert.equal(r.delivered, "created");
	const list = kernel.sessions(me.sid, {}) as { sessions: Array<Record<string, unknown>> };
	const rows = list.sessions;
	assert.ok(rows.some((x) => x.alias === "ken" && x.self === true && x.state === "attached"));
	const runner = rows.find((x) => x.alias === "runner");
	assert.ok(runner && runner.state === "running" && runner.started_by === "ken");
	const deep = kernel.sessions(me.sid, { id: "runner" }) as Record<string, unknown>;
	assert.equal(deep.state, "running");
	assert.ok(String(deep.hint).includes("send"));
	// 停掉收尾
	const st = kernel.stop(me.sid, { target: "runner" }) as Record<string, unknown>;
	assert.equal(st.stopped, "runner");
	await waitFor(() => (kernel.sessions(me.sid, { id: "runner" }) as Record<string, unknown>).state === "dormant");
});

test("stop 语义: human 拒绝; 自己拒绝; dormant no-op; 跨进程发 control", async () => {
	const { p, kernel, me } = setup();
	const bob = humanPresence(p, "bob", { live: true });
	claimAlias(p, "bob", bob.sid);
	const r1 = kernel.stop(me.sid, { target: "bob" });
	assert.ok(isToolError(r1) && r1.error.code === "refuse");
	const r2 = kernel.stop(me.sid, { target: "ken" });
	assert.ok(isToolError(r2) && r2.error.code === "refuse");
	const zzz = agentPresence(p, "zzz", { live: false });
	claimAlias(p, "zzz", zzz.sid);
	const r3 = kernel.stop(me.sid, { target: "zzz" }) as Record<string, unknown>;
	assert.equal(r3.noop, "zzz");
	// "别的进程在运行"(live 但非本 host 寄宿)→ control 信
	const remote = agentPresence(p, "remote", { live: true });
	claimAlias(p, "remote", remote.sid);
	const r4 = kernel.stop(me.sid, { target: "remote", reason: "打住" }) as Record<string, unknown>;
	assert.equal(r4.control_sent, "remote");
	const ctl = listMail(p, remote.sid).find(({ msg }) => msg.kind === "control");
	assert.ok(ctl && ctl.msg.body === "stop" && ctl.msg.data?.reason === "打住");
});

test("send(to=\"new\") 不留兼容路径, 返回指向 agent 工具的教学错误", async () => {
	const { f, kernel, me } = setup();
	const r = await kernel.send(me.sid, { target: "new", body: "帮我查点东西" });
	assert.ok(isToolError(r));
	assert.equal(r.error.code, "use_agent_tool");
	assert.ok(r.error.message.includes("agent"));
	assert.equal(f.created.length, 0); // 没有偷偷替它创建
});

test("agent(): cwd 缺省继承调用者, 显式不存在拒绝, 显式存在则生效", async () => {
	const { p, f, kernel, me } = setup();
	patchPresence(p, me.sid, { cwd: os.tmpdir() });
	// 缺省=继承
	f.scripts.push(() => "ok");
	const r1 = (await kernel.agent(me.sid, { body: "x", alias: "inherit-cwd" })) as Record<string, unknown>;
	assert.equal(r1.delivered, "created");
	await waitFor(() => f.created.length === 1);
	assert.equal(readPresence(p, resolveAlias(p, "inherit-cwd")!)!.cwd, os.tmpdir());
	// 显式但不存在 → 拒绝(fail-fast, 不留半个会话)
	const bad = path.join(os.tmpdir(), "mesh-no-such-dir-xyz");
	const r2 = await kernel.agent(me.sid, { body: "x", cwd: bad });
	assert.ok(isToolError(r2) && r2.error.code === "bad_cwd");
	assert.equal(f.created.length, 1);
	// 显式且存在 → 生效
	const sub = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cwd-"));
	f.scripts.push(() => "ok");
	const r3 = (await kernel.agent(me.sid, { body: "x", alias: "explicit-cwd", cwd: sub })) as Record<string, unknown>;
	assert.equal(r3.delivered, "created");
	await waitFor(() => f.created.length === 2);
	assert.equal(readPresence(p, resolveAlias(p, "explicit-cwd")!)!.cwd, sub);
});

test("execute 四动词分派: agent 派活 / send 只对已有 / sessions 看 / stop 停", async () => {
	const { p, f, kernel, me, host } = setup();
	f.scripts.push((_t, s) => s.untilAborted());
	// agent
	const a = (await kernel.execute("agent", me.sid, { body: "跑着", alias: "quad" })) as Record<string, unknown>;
	assert.equal(a.delivered, "created");
	const sid = resolveAlias(p, "quad")!;
	await waitFor(() => host.isHosted(sid));
	// send(已有会话):落盘 → watcher steer 进去 → 观察到即 consume
	const s = (await kernel.execute("send", me.sid, { target: "quad", body: "补充要求" })) as Record<string, unknown>;
	assert.equal(s.delivered, "steered");
	await waitFor(() => pendingCount(p, sid) === 0); // 等它真被投递(否则 stop 后 sweep 会补投再唤醒)
	assert.ok(f.created[0].steers[0].includes("补充要求"));
	// sessions
	const list = (await kernel.execute("sessions", me.sid, {})) as { sessions: Array<Record<string, unknown>> };
	assert.ok(list.sessions.some((r) => r.alias === "quad" && r.state === "running"));
	// stop
	const st = (await kernel.execute("stop", me.sid, { target: "quad", reason: "收工" })) as Record<string, unknown>;
	assert.equal(st.stopped, "quad");
	await waitFor(() => !host.isHosted(sid));
	assert.equal(readPresence(p, sid)!.last_fact, "stopped");
});

test("sessions 列表作用域(§12): 只有自己 + 自己派出的子树; 同目录别的方向不可见; 深查仍全域", async () => {
	const { p, kernel, me } = setup(); // me: ken, cwd=/tmp
	humanPresence(p, "bob", { live: true, cwd: "/elsewhere" }); // 别项目活人:不进无参列表
	agentPresence(p, "far-runner", { live: true, cwd: "/elsewhere" }); // 别项目 running:不进无参列表
	const mine = agentPresence(p, "mine", { startedBy: me.sid, cwd: "/tmp/sub" }); // 我派的
	const cloned = agentPresence(p, "cloned", { startedBy: me.sid, cwd: "/elsewhere/clone" }); // cwd 在外,但是我派的
	agentPresence(p, "grand", { startedBy: mine.sid, cwd: "/elsewhere" }); // 子代的子代
	const foreign = agentPresence(p, "foreign", { cwd: "/elsewhere" }); // 别项目休眠
	agentPresence(p, "upstream", { cwd: "/" }); // 上级地盘
	humanPresence(p, "yesterday", { live: false, cwd: "/tmp" }); // 休眠 human
	const peer = humanPresence(p, "peer", { live: true, cwd: "/tmp" }); // 同目录的另一个方向
	agentPresence(p, "peer-a", { startedBy: peer.sid, live: true, cwd: "/tmp" }); // 它的工人:也不该进我的列表
	patchPresence(p, mine.sid, { last_fact: "died" });

	const list = kernel.sessions(me.sid, {}) as { sessions: Array<Record<string, unknown>>; scope?: string; scope_mode?: string };
	const aliases = list.sessions.map((r) => r.alias);
	assert.deepEqual([...aliases].sort(), ["cloned", "grand", "ken", "mine"]);
	assert.ok(!aliases.includes("peer")); // 同目录的人会话是别的方向
	assert.ok(!aliases.includes("peer-a"));
	assert.ok(!aliases.includes("bob"));
	assert.ok(!aliases.includes("far-runner"));
	assert.ok(!aliases.includes("foreign"));
	assert.ok(!aliases.includes("upstream"));
	assert.ok(!aliases.includes("yesterday"));
	assert.equal(list.scope, "ken"); // 作用域是"我这棵树", 不再是 cwd
	assert.equal(list.scope_mode, "subtree");
	assert.equal(list.sessions.find((r) => r.alias === "mine")!.last_fact, "✗ died");

	claimAlias(p, "foreign", foreign.sid);
	const deep = kernel.sessions(me.sid, { id: "foreign" }) as Record<string, unknown>;
	assert.equal(deep.alias, "foreign");
	assert.equal(deep.state, "dormant");
	assert.equal(cloned.alias, "cloned");
});

test('保留地址 creator(§12): 解析到 started_by 而非别名; human 用它报 no_creator; 深子代也能寻到直接创建者', async () => {
	const { p, kernel, me } = setup(); // me: ken(human, cwd=/tmp)
	// 同目录第二个方向,别名恰好是模型最容易写错的那个前缀
	const peer = humanPresence(p, "ken-2", { live: true, cwd: "/tmp" });
	claimAlias(p, "ken-2", peer.sid);
	const planner = agentPresence(p, "planner", { startedBy: me.sid, live: true, tools: ["read"] });
	const worker = agentPresence(p, "worker", { startedBy: planner.sid, live: true, tools: ["read"] });

	// depth1 → creator 落到 ken 的信箱(不是同目录的 ken-2)
	const r1 = (await kernel.send(planner.sid, { target: "creator", body: "进展一行" })) as Record<string, unknown>;
	assert.ok(!isToolError(r1), JSON.stringify(r1));
	assert.equal((r1.to as { alias: string }).alias, "ken");
	assert.equal(pendingCount(p, me.sid), 1);
	assert.equal(pendingCount(p, peer.sid), 0);

	// depth2 的工人 → creator 是它的**直接**创建者 planner(不是 root human)
	const r2 = (await kernel.send(worker.sid, { target: "starter", body: "问一句" })) as Record<string, unknown>;
	assert.equal((r2.to as { alias: string }).alias, "planner");
	assert.equal(pendingCount(p, planner.sid), 1);

	// human 没有创建者
	const r3 = (await kernel.send(me.sid, { target: "creator", body: "?" })) as Record<string, unknown>;
	assert.ok(isToolError(r3));
	assert.equal((r3 as { error: { code: string } }).error.code, "no_creator");
	// 大小写不敏感, 且别名里恰好有人叫 creator 也不影响(保留字优先)
	claimAlias(p, "creator", peer.sid);
	const r4 = (await kernel.send(planner.sid, { target: "Creator", body: "再一行" })) as Record<string, unknown>;
	assert.equal((r4.to as { alias: string }).alias, "ken");
	assert.equal(pendingCount(p, peer.sid), 0);
});

test("foreign_human(§12): agent 不能给别的方向的人会话写信; 本树 root human 放行; human 之间不受限", async () => {
	const { p, kernel, me } = setup(); // me: ken
	const peer = humanPresence(p, "ken-2", { live: true, cwd: "/tmp" });
	claimAlias(p, "ken-2", peer.sid);
	const planner = agentPresence(p, "planner", { startedBy: me.sid, live: true, tools: ["read"] });
	const worker = agentPresence(p, "worker", { startedBy: planner.sid, live: true, tools: ["read"] });
	const theirs = agentPresence(p, "theirs", { startedBy: peer.sid, live: true, tools: ["read"] });
	claimAlias(p, "planner", planner.sid);
	claimAlias(p, "theirs", theirs.sid);

	// 外树 human:拒
	const bad = (await kernel.send(planner.sid, { target: "ken-2", body: "串门" })) as Record<string, unknown>;
	assert.ok(isToolError(bad));
	assert.equal((bad as { error: { code: string; message: string } }).error.code, "foreign_human");
	assert.ok((bad as { error: { message: string } }).error.message.includes("creator"));
	assert.equal(pendingCount(p, peer.sid), 0);

	// 本树 root human(非直接创建者):放行 —— depth2 的工人给 ken 写信
	claimAlias(p, "ken", me.sid);
	const ok = (await kernel.send(worker.sid, { target: "ken", body: "越级汇报" })) as Record<string, unknown>;
	assert.ok(!isToolError(ok), JSON.stringify(ok));
	assert.equal(pendingCount(p, me.sid), 1);

	// agent → 外树 agent 不受限(跨树协作靠任务书约定)
	const cross = (await kernel.send(planner.sid, { target: "theirs", body: "协作" })) as Record<string, unknown>;
	assert.ok(!isToolError(cross), JSON.stringify(cross));

	// human → 别的 human 不受限(人可以跨终端互发)
	const h2h = (await kernel.send(me.sid, { target: "ken-2", body: "在忙什么" })) as Record<string, unknown>;
	assert.ok(!isToolError(h2h), JSON.stringify(h2h));
	assert.equal(pendingCount(p, peer.sid), 1);
});

test("send 到被限频的会话: 话术准确(限频 ≠ 并发已满)", async () => {
	const { p, f, host, kernel, me } = setup();
	const boss = agentPresence(p, "boss", { live: true, startedBy: me.sid, tools: ["read"] });
	claimAlias(p, "boss", boss.sid);
	const w = agentPresence(p, "sleepy2", { startedBy: boss.sid });
	claimAlias(p, "sleepy2", w.sid);
	f.openScripts.set(w.sid, () => "ok");

	for (let i = 0; i < 6; i++) {
		const r1 = (await kernel.send(boss.sid, { target: "sleepy2", body: `第 ${i} 次` })) as Record<string, unknown>;
		assert.equal(r1.delivered, "woken");
		await waitFor(() => !host.isHosted(w.sid));
	}
	const r2 = (await kernel.send(boss.sid, { target: "sleepy2", body: "第七次" })) as Record<string, unknown>;
	assert.equal(r2.delivered, "mailboxed");
	assert.ok(String(r2.note).includes("限频"));
	assert.ok(!String(r2.note).includes("并发已满"));
	assert.equal(pendingCount(p, w.sid), 1); // 消息不丢
});

test("readLastAssistantText: 从落盘会话文件尾部解析(跳过 thinking, 容忍截断)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sess-"));
	const file = path.join(dir, "s.jsonl");
	const lines = [
		JSON.stringify({ type: "session", id: "x" }),
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "思考中" }, { type: "text", text: "最终答复在此" }] } }),
		'{"type":"message","mess', // 模拟写一半崩溃
	];
	fs.writeFileSync(file, lines.join("\n"));
	assert.equal(readLastAssistantText(file), "最终答复在此");
	assert.equal(readLastAssistantText(path.join(dir, "nope.jsonl")), undefined);
});

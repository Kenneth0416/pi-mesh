/** v4:意图路由、timebox(声明才有)、workspace 观测、推理等级、TUI 侧 spawn。 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { FakeFactory, agentPresence, humanPresence, sleep, tmpMesh, waitFor } from "./helpers.ts";
import { Host } from "../src/host.ts";
import type { HostOptions } from "../src/host.ts";
import { createKernel } from "../src/kernel.ts";
import type { Kernel } from "../src/kernel.ts";
import { observeWorkspace } from "../src/git.ts";
import { listMail, pendingCount } from "../src/mailbox.ts";
import { claimAlias, patchPresence, readPresence, resolveAlias } from "../src/registry.ts";
import { isToolError, THINKING_LEVELS, thinkingForSpawn } from "../src/types.ts";
import type { MeshPaths, Presence } from "../src/types.ts";

function setup(hostOpts: Partial<HostOptions> = {}): { p: MeshPaths; f: FakeFactory; host: Host; kernel: Kernel; me: Presence } {
	const p = tmpMesh();
	const me = humanPresence(p, "ken", { live: true });
	claimAlias(p, "ken", me.sid);
	const f = new FakeFactory();
	const host = new Host({ paths: p, factory: f, pid: process.pid, cap: 8, wakeBatchMs: 0, ...hostOpts });
	const kernel = createKernel({ paths: p, host, cap: 8, selfSid: () => me.sid, resolveModel: (ref) => ({ model: ref }), nudgeSelf: () => {} });
	return { p, f, host, kernel, me };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function repo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-repo-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t");
	git(dir, "config", "user.name", "t");
	fs.mkdirSync(path.join(dir, "lib"));
	fs.writeFileSync(path.join(dir, "lib/core.ts"), "export const c = 1\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return dir;
}

const notices = (p: MeshPaths, sid: string) => listMail(p, sid).filter(({ msg }) => msg.kind === "notice");
const sidOf = (kernel: Kernel, me: Presence, alias: string) => (kernel.sessions(me.sid, { id: alias }) as { sid: string }).sid;

test("send intent: 未知值拒绝; notify 给 dormant agent 不唤醒(sweep 也不唤), 下次唤醒一并送达", async () => {
	const { p, f, host, kernel, me } = setup();
	const w = agentPresence(p, "w", { startedBy: me.sid });
	claimAlias(p, "w", w.sid);
	patchPresence(p, w.sid, { heartbeat_at: Date.now() });
	f.openScripts.set(w.sid, () => "不该醒");
	const bad = await kernel.send(me.sid, { target: "w", body: "x", intent: "freeze" });
	assert.ok(isToolError(bad) && bad.error.code === "invalid_params", "freeze 已不存在");
	const bad2 = await kernel.send(me.sid, { target: "w", body: "x", intent: "interrupt" });
	assert.ok(isToolError(bad2) && bad2.error.code === "invalid_params", "interrupt 已不存在");
	const r = (await kernel.send(me.sid, { target: "w", body: "收到, 无需回复", intent: "notify" })) as Record<string, unknown>;
	assert.equal(r.delivered, "mailboxed");
	assert.ok(String(r.note).includes("不唤醒"));
	await host.sweep();
	assert.equal(f.created.length, 0);
	f.openScripts.set(w.sid, () => "醒了");
	const r2 = (await kernel.send(me.sid, { target: "w", body: "继续" })) as Record<string, unknown>;
	assert.equal(r2.delivered, "woken");
	await waitFor(() => !host.isHosted(w.sid));
	assert.ok(f.created[0].prompts[0].includes("收到, 无需回复"));
	// blocker 立即, 不限额(预算只管 wake)
	for (let i = 0; i < 5; i++) {
		const b = (await kernel.send(me.sid, { target: "w", body: "?", intent: "blocker" })) as Record<string, unknown>;
		assert.equal(b.intent, "blocker");
	}
});

test("agent(): timebox 只有声明才有; base_oid 自动记录; 老参数(scope/role/fallback)被忽略不落 presence; 非法拒绝", async () => {
	const { p, f, kernel, me } = setup();
	const dir = repo();
	f.scripts.push(() => "ok");
	const r = (await kernel.agent(me.sid, { body: "改 core", alias: "worker", cwd: dir, timebox_min: 12 })) as Record<string, unknown>;
	assert.equal(r.delivered, "created");
	assert.equal(r.timebox_min, 12);
	assert.ok(String(r.note).includes("本树活跃"));
	const pres = readPresence(p, sidOf(kernel, me, "worker"))!;
	assert.equal(pres.timebox_ms, 12 * 60_000);
	assert.ok(pres.task_started_at! > 0);
	assert.equal(pres.base_oid, git(dir, "rev-parse", "HEAD"));
	f.scripts.push(() => "ok");
	const r2 = (await kernel.agent(me.sid, { body: "x", alias: "plain", cwd: dir, scope: { owned: ["x"] }, role: "review", fallback: ["a/b"] })) as Record<string, unknown>;
	assert.equal(r2.timebox_min, undefined, "不声明就没有时限");
	const pr = readPresence(p, sidOf(kernel, me, "plain")) as unknown as Record<string, unknown>;
	assert.equal(pr.timebox_ms, undefined);
	assert.equal(pr.scope, undefined);
	assert.equal(pr.role, undefined);
	assert.equal(pr.fallback, undefined);
	const bad = await kernel.agent(me.sid, { body: "x", timebox_min: -1 });
	assert.ok(isToolError(bad) && bad.error.code === "invalid_params");
	// 无 timebox 的工人 checkVitals 不发 timebox 信
	const list = kernel.sessions(me.sid, {}) as { sessions: Array<Record<string, unknown>> };
	assert.equal(list.sessions.find((s) => s.alias === "plain")!.timebox_left_s, undefined);
});

test("WAKE_BATCH_MS: 默认 8s,环境变量覆盖与非法值回落", () => {
	for (const [value, expected] of [["", 8_000], ["25", 25], ["invalid", 8_000]] as const) {
		const output = execFileSync(process.execPath, [
			"--input-type=module", "-e",
			`import { WAKE_BATCH_MS } from ${JSON.stringify(new URL("../src/types.ts", import.meta.url).href)}; console.log(WAKE_BATCH_MS);`,
		], { encoding: "utf8", env: { ...process.env, PI_MESH_WAKE_BATCH_MS: value } });
		assert.equal(Number(output.trim()), expected);
	}
});

test("推理等级: 纯函数规则", () => {
	for (const modelExplicit of [false, true]) {
		for (const callerLevel of THINKING_LEVELS) {
			assert.equal(thinkingForSpawn({ modelExplicit, callerLevel }), callerLevel);
			assert.equal(thinkingForSpawn({ explicit: "xhigh", modelExplicit, callerLevel }), "xhigh");
			assert.equal(thinkingForSpawn({ explicit: "off", modelExplicit, callerLevel }), "off");
		}
	}
});

test("agent(): 缺省与指定模型均继承等级; thinking 覆盖; 唤醒与二级分身沿用", async () => {
	const { p, f, host, kernel, me } = setup();
	patchPresence(p, me.sid, { model: "acme/big", thinking_level: "high" });
	f.scripts.push(() => "ok");
	const r1 = (await kernel.agent(me.sid, { body: "切片实现", alias: "t1" })) as Record<string, unknown>;
	assert.equal(r1.thinking, "high");
	assert.equal(f.specs.at(-1)!.thinkingLevel, "high");
	f.scripts.push(() => "ok");
	const r2 = (await kernel.agent(me.sid, { body: "审查", alias: "t2", model: "other/strong" })) as Record<string, unknown>;
	assert.equal(r2.thinking, "high");
	f.scripts.push(() => "ok");
	const r3 = (await kernel.agent(me.sid, { body: "x", alias: "t3", thinking: "xhigh" })) as Record<string, unknown>;
	assert.equal(r3.thinking, "xhigh");
	const bad = await kernel.agent(me.sid, { body: "x", thinking: "ultra" });
	assert.ok(isToolError(bad) && bad.error.code === "invalid_params");
	const sid1 = sidOf(kernel, me, "t1");
	await waitFor(() => !host.isHosted(sid1));
	f.openScripts.set(sid1, () => "again");
	await kernel.send(me.sid, { target: "t1", body: "再来" });
	await waitFor(() => !host.isHosted(sid1));
	assert.equal(f.opens.at(-1)!.thinking, "high");
	patchPresence(p, sid1, { host_pid: process.pid, heartbeat_at: Date.now() });
	f.scripts.push(() => "ok");
	const r4 = (await kernel.agent(sid1, { body: "更小的片", alias: "t1-child" })) as Record<string, unknown>;
	assert.equal(r4.thinking, "high");
});

test("agent(): 显式同模型不升档", async () => {
	const { p, f, kernel, me } = setup();
	patchPresence(p, me.sid, { model: "acme/big", thinking_level: "low" });
	const result = await kernel.agent(me.sid, { body: "同型", model: "acme/big" }) as Record<string, unknown>;
	assert.equal(result.thinking, "low");
	assert.equal(f.specs[0].thinkingLevel, "low");
	assert.equal(f.specs[0].model, "acme/big");
});

test("agent(): 无创建者等级回落 medium", async () => {
	const { f, kernel, me } = setup();
	for (const modelExplicit of [false, true]) {
		assert.equal(thinkingForSpawn({ modelExplicit }), "medium");
		const result = await kernel.agent(me.sid, { body: "缺等级", ...(modelExplicit ? { model: "acme/big" } : {}) }) as Record<string, unknown>;
		assert.equal(result.thinking, "medium");
		assert.equal(f.specs.at(-1)!.thinkingLevel, "medium");
	}
});

test("git: observeWorkspace 报 head/base/commits/changed/dirty; 非仓库 undefined; 不再有所有权/钉子", () => {
	const dir = repo();
	const base = git(dir, "rev-parse", "HEAD");
	fs.writeFileSync(path.join(dir, "lib/core.ts"), "export const c = 2\n");
	fs.writeFileSync(path.join(dir, "lib/other.ts"), "export const o = 1\n");
	git(dir, "add", "lib/core.ts");
	git(dir, "commit", "-qm", "core work");
	fs.writeFileSync(path.join(dir, "README.md"), "dirty\n");
	const ws = observeWorkspace(dir, base)!;
	assert.equal(ws.base, base);
	assert.equal(ws.head, git(dir, "rev-parse", "HEAD"));
	assert.equal(ws.commits?.length, 1);
	assert.deepEqual(ws.changed, ["lib/core.ts"]);
	assert.equal(ws.dirty, 2);
	assert.equal((ws as Record<string, unknown>).outside_owned, undefined);
	assert.equal(observeWorkspace(os.tmpdir(), undefined), undefined);
});

test("quiescent 讣告: related_message_id + data.workspace(commits/changed/dirty)", async () => {
	const { p, f, kernel, me } = setup();
	const dir = repo();
	f.scripts.push(async () => {
		fs.writeFileSync(path.join(dir, "lib/core.ts"), "export const c = 42\n");
		git(dir, "commit", "-qam", "feat: core");
		fs.writeFileSync(path.join(dir, "lib/sneaky.ts"), "x\n");
		await waitFor(() => !(resolveAlias(p, "w-git") ?? "pending-").startsWith("pending-"));
		await kernel.send(resolveAlias(p, "w-git")!, { target: "creator", body: "已提交 core, 1 test" });
		return "已提交 core, 1 test";
	});
	await kernel.agent(me.sid, { body: "改 core", alias: "w-git", cwd: dir });
	await waitFor(() => notices(p, me.sid).some(({ msg }) => msg.fact === "quiescent"), 5000);
	const q = notices(p, me.sid).find(({ msg }) => msg.fact === "quiescent")!.msg;
	const report = listMail(p, me.sid).find(({ msg }) => msg.kind === "message")!.msg;
	assert.equal(q.data?.related_message_id, report.id);
	assert.equal(q.data?.last_output, undefined, "重复正文在讣告生成时就省略");
	const ws = q.data?.workspace!;
	assert.equal(ws.commits?.length, 1);
	assert.deepEqual(ws.changed, ["lib/core.ts"]);
	assert.equal(ws.dirty, 1);
});

test("timebox: 到点自检信(不停不 commit); 1.5× 再提醒并通报创建者; 同级不重发; 重设后重新计; 未声明的工人永不收到", async () => {
	const { p, f, host, kernel, me } = setup();
	f.scripts.push((_t, s) => s.untilAborted());
	f.scripts.push((_t, s) => s.untilAborted());
	await kernel.agent(me.sid, { body: "长活", alias: "tb", timebox_min: 0.003 });
	await kernel.agent(me.sid, { body: "无时限", alias: "free" });
	const sid = sidOf(kernel, me, "tb");
	const freeSid = sidOf(kernel, me, "free");
	await waitFor(() => f.created.length > 1 && f.created[0].prompts.length > 0 && f.created[1].prompts.length > 0);
	const s = f.created[0];
	assert.ok(s.prompts[0].includes("timebox"));
	assert.ok(!f.created[1].prompts[0].includes("timebox"));
	await sleep(200);
	host.checkVitals();
	host.checkVitals();
	await waitFor(() => s.steers.length >= 1);
	assert.ok(s.steers[0].includes("停止扩展"), s.steers[0]);
	assert.ok(s.steers[0].includes("报告后结束回合") || s.steers[0].includes("报告(做了什么/剩什么/未验证的假设)后结束回合"));
	assert.ok(s.steers[0].includes("不必再 send creator 同一份内容"));
	assert.ok(s.steers[0].includes("最后一条消息作为讣告"));
	assert.equal(s.steers.length, 1);
	assert.equal(f.created[1].steers.length, 0, "无时限的工人不收自检信");
	assert.equal(notices(p, me.sid).filter(({ msg }) => msg.fact === "timebox").length, 0);
	await sleep(120);
	host.checkVitals();
	await waitFor(() => s.steers.length >= 2);
	assert.ok(s.steers[1].includes("1.5 倍"));
	assert.ok(s.steers[1].includes("不必再 send creator 同一份内容"));
	assert.ok(s.steers[1].includes("报告后结束回合"));
	const tb = notices(p, me.sid).filter(({ msg }) => msg.fact === "timebox");
	assert.equal(tb.length, 1);
	assert.equal(tb[0].msg.data?.subject, sid);
	await kernel.send(me.sid, { target: "tb", body: "再给 1 分钟", timebox_min: 1 });
	assert.equal(readPresence(p, sid)!.timebox_level, 0);
	host.checkVitals();
	assert.equal(s.steers.length, 2);
	// 只有创建者/人能设时限
	const peer = agentPresence(p, "peer", { startedBy: me.sid, live: true });
	claimAlias(p, "peer", peer.sid);
	const no = await kernel.send(peer.sid, { target: "tb", body: "x", timebox_min: 5 });
	assert.ok(isToolError(no) && no.error.code === "refuse");
	host.stopLocal(sid, "clean");
	host.stopLocal(freeSid, "clean");
	await waitFor(() => !host.isHosted(sid) && !host.isHosted(freeSid));
});

test("出生仪式头: 有时限才写 timebox; 有 git 基线才写署名 trailer", async () => {
	const { f, kernel, me } = setup();
	const dir = repo();
	f.scripts.push(() => "ok");
	f.scripts.push(() => "ok");
	await kernel.agent(me.sid, { body: "干活", alias: "hdr", cwd: dir, timebox_min: 10 });
	await kernel.agent(me.sid, { body: "干活", alias: "bare", cwd: os.tmpdir() });
	await waitFor(() => f.created.length > 1 && f.created[0].prompts.length > 0 && f.created[1].prompts.length > 0);
	const head = f.created[0].prompts[0];
	assert.ok(head.includes("timebox 10 分钟"), head);
	assert.ok(head.includes("Mesh-Agent: hdr/"));
	assert.ok(head.includes("干活"));
	assert.ok(!f.created[1].prompts[0].includes("[mesh] 事实"), "无时限无仓库: 只有身份行");
});

test("TUI 侧(无 Host)的 agent(): presence 带 thinking/base_oid, 工厂不被碰, 出生信留箱", async () => {
	const p = tmpMesh();
	const me = humanPresence(p, "ken", { live: true });
	claimAlias(p, "ken", me.sid);
	patchPresence(p, me.sid, { thinking_level: "medium" });
	const f = new FakeFactory();
	const kernel = createKernel({ paths: p, cap: 8, selfSid: () => me.sid, resolveModel: (ref) => ({ model: ref }), nudgeSelf: () => {}, ensureHostd: async () => ({ ok: true }) });
	const r = (await kernel.agent(me.sid, { body: "活", alias: "tui-w", timebox_min: 7 })) as Record<string, unknown>;
	assert.equal(r.delivered, "created");
	assert.equal(r.thinking, "medium");
	assert.equal(f.created.length, 0);
	const pres = readPresence(p, resolveAlias(p, "tui-w")!)!;
	assert.equal(pres.host_pid, undefined);
	assert.equal(pres.session_file, undefined);
	assert.equal(pres.timebox_ms, 7 * 60_000);
	assert.equal(pres.thinking_level, "medium");
	assert.equal(pendingCount(p, pres.sid), 1);
});

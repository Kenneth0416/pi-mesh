import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { FakeFactory, FakeSession, agentPresence, humanPresence, legacySpawn, sleep, tmpMesh, waitFor } from "./helpers.ts";
import type { Script } from "./helpers.ts";
import { Host } from "../src/host.ts";
import type { HostOptions } from "../src/host.ts";
import { createKernel } from "../src/kernel.ts";
import { consumeMail, listMail, newMessageId, pendingCount, renderMail, sendMail } from "../src/mailbox.ts";
import { claimAlias, patchPresence, readPresence, resolveAlias } from "../src/registry.ts";
import type { MeshMessage, MeshPaths } from "../src/types.ts";

type LegacyHostOpts = Partial<HostOptions> & { cwd?: string; selfSid?: string; longrunMs?: number };

function makeHost(p: MeshPaths, factory: FakeFactory, cap = 8, stallMs?: number, extra: LegacyHostOpts = {}): Host {
	const { cwd: _cwd, selfSid: _s, longrunMs: _l, ...rest } = extra;
	return new Host({ paths: p, factory, pid: process.pid, cap, stallMs, wakeBatchMs: 0, ...rest });
}

function mailTo(p: MeshPaths, to: string, body: string, from = "tester", fromAlias = "tester"): string {
	const m: MeshMessage = { id: newMessageId(), from, from_alias: fromAlias, to, at: Date.now(), kind: "message", body };
	sendMail(p, m);
	return m.id;
}

function notices(p: MeshPaths, sid: string) {
	return listMail(p, sid).filter(({ msg }) => msg.kind === "notice");
}

// ---------------------------------------------------------------------------

test("spawn → 出生信送达 → 归于安静 → quiescent 讣告(附最后输出)", async () => {
	const p = tmpMesh();
	const starter = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(() => "工作完成, 产物在 /tmp/out.md");
	const host = makeHost(p, f);
	const r = await legacySpawn(host, { alias: "w1", cwd: "/tmp", tools: ["read"], startedBy: starter.sid, startedByAlias: "ken", body: "去干活" });
	assert.ok(!("error" in r));
	await waitFor(() => notices(p, starter.sid).length > 0);
	const n = notices(p, starter.sid)[0].msg;
	assert.equal(n.fact, "quiescent");
	assert.equal(n.from, "system");
	assert.ok(n.data?.last_output?.includes("产物在 /tmp/out.md"));
	// 出生信被 consume(观察到 id); presence 收场
	const sid = (r as { sid: string }).sid;
	assert.equal(pendingCount(p, sid), 0);
	const pres = readPresence(p, sid)!;
	assert.equal(pres.host_pid, undefined);
	assert.equal(pres.clean_exit, true);
	assert.ok(pres.stats.turns >= 1);
	// 出生 prompt 含身份行与任务书
	assert.ok(f.created[0].prompts[0].includes("你是 w1"));
	assert.ok(f.created[0].prompts[0].includes("去干活"));
});

for (const scenario of [
	{ name: "相同正文", report: "检查通过,剩余部署", output: "检查通过,剩余部署", duplicate: true },
	{ name: "只差空白", report: "检查 通过,\n剩余\t部署", output: "检查通过,剩余部署", duplicate: true },
	{ name: "前 200 字符一致", report: "验".repeat(200) + "汇报尾", output: "验".repeat(200) + "输出尾", duplicate: true },
	{ name: "不同正文", report: "第一阶段通过", output: "最终检查失败,仍需修复", duplicate: false },
	{ name: "创建者已读走", report: "checkpoint: 检查通过", output: "checkpoint: 检查通过", duplicate: true, consumed: true },
	{ name: "只比较最后一封 send", report: "尚未验证", output: "已经验证", duplicate: false, earlier: "已经验证" },
]) {
	test(`quiescent 汇报去重: ${scenario.name}`, async (t) => {
		const p = tmpMesh();
		const creator = humanPresence(p, "creator", { live: true });
		const worker = agentPresence(p, "worker", { startedBy: creator.sid, cwd: p.root });
		const f = new FakeFactory();
		const host = makeHost(p, f);
		t.after(() => host.shutdown());
		const kernel = createKernel({ paths: p, host, cap: 8, selfSid: () => creator.sid, resolveModel: (ref) => ({ model: ref }), nudgeSelf: () => {} });
		let reportId = "";
		f.openScripts.set(worker.sid, async () => {
			if (scenario.earlier) await kernel.send(worker.sid, { target: "creator", body: scenario.earlier });
			await kernel.send(worker.sid, { target: "creator", body: scenario.report });
			const report = listMail(p, creator.sid).find(({ msg }) => msg.body === scenario.report)!;
			reportId = report.msg.id;
			if (scenario.consumed) consumeMail([report.file]);
			return scenario.output;
		});
		mailTo(p, worker.sid, "干活", creator.sid);
		await host.wake(worker.sid);
		await waitFor(() => notices(p, creator.sid).some(({ msg }) => msg.fact === "quiescent"));
		const notice = notices(p, creator.sid)[0].msg;
		assert.equal(notice.data?.subject, worker.sid);
		if (scenario.duplicate) {
			assert.equal(notice.data?.related_message_id, reportId);
			assert.equal(notice.data?.last_output, undefined);
			assert.ok(!renderMail([notice]).includes(scenario.output), "单独投讣告也不重复正文");
		} else {
			assert.equal(notice.data?.related_message_id, undefined, "不同正文不能被同批折叠掉");
			assert.equal(notice.data?.last_output, scenario.output);
			assert.ok(renderMail(listMail(p, creator.sid).map(({ msg }) => msg)).includes(scenario.output));
		}
	});
}

test("wake: open 在途时 shutdown 不再启动循环,信留箱供交接", async () => {
	const p = tmpMesh();
	const worker = agentPresence(p, "worker");
	const f = new FakeFactory();
	const host = makeHost(p, f);
	let release!: () => void;
	f.beforeOpen = () => new Promise<void>((resolve) => { release = resolve; });
	mailTo(p, worker.sid, "留箱");
	const opening = host.wake(worker.sid);
	host.shutdown({ handover: true });
	release();
	assert.equal(await opening, "defer_shutdown");
	assert.equal(f.created[0].disposed, true);
	assert.equal(f.created[0].prompts.length, 0);
	assert.equal(host.isHosted(worker.sid), false);
	assert.equal(pendingCount(p, worker.sid), 1);
});

test("provider error → died 讣告(绝不伪装成安静的成功)", async () => {
	const p = tmpMesh();
	const starter = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => {
		s.stopReason = "error";
		s.errorMessage = "403 quota exhausted";
		return "";
	});
	const host = makeHost(p, f);
	await legacySpawn(host, { alias: "w2", cwd: "/tmp", tools: [], startedBy: starter.sid, startedByAlias: "ken", body: "x" });
	await waitFor(() => notices(p, starter.sid).length > 0);
	const n = notices(p, starter.sid)[0].msg;
	assert.equal(n.fact, "died");
	assert.ok(n.data?.reason?.includes("403"));
});

test("空输出 → died(v7 教训: 会话结束但无任何输出)", async () => {
	const p = tmpMesh();
	const starter = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(() => "");
	const host = makeHost(p, f);
	await legacySpawn(host, { alias: "w3", cwd: "/tmp", tools: [], startedBy: starter.sid, startedByAlias: "ken", body: "x" });
	await waitFor(() => notices(p, starter.sid).length > 0);
	assert.equal(notices(p, starter.sid)[0].msg.fact, "died");
});

test("运行中收信 → steer 下一边界注入 → consume-on-observe, 单轮完成", async () => {
	const p = tmpMesh();
	const starter = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(async (_t, s) => {
		await waitFor(() => s.steers.length > 0, 8000); // 干活中途等一条追加指令
		return "吸收了追加指令, 完成";
	});
	const host = makeHost(p, f);
	const r = await legacySpawn(host, { alias: "w4", cwd: "/tmp", tools: [], startedBy: starter.sid, startedByAlias: "ken", body: "开工" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => f.created.length > 0 && f.created[0].prompts.length > 0);
	const mid = mailTo(p, sid, "改一下需求");
	await waitFor(() => notices(p, starter.sid).length > 0);
	// steer 送达即观察即 consume; 不应触发第二轮 prompt
	assert.equal(f.created[0].prompts.length, 1);
	assert.ok(f.created[0].steers[0].includes("改一下需求"));
	assert.equal(pendingCount(p, sid), 0);
	assert.ok(f.created[0].steers[0].includes(mid));
});

test("settle 竞态: steer 被吞 → 复查轮以 prompt 补投, 不丢消息", async () => {
	const p = tmpMesh();
	const starter = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(async (_t, s) => {
		s.steerDelivers = false; // 模拟 steer 排队但循环已收尾
		await waitFor(() => s.steers.length > 0, 8000);
		return "第一轮结束(没看到 steer)";
	});
	const host = makeHost(p, f);
	const r = await legacySpawn(host, { alias: "w5", cwd: "/tmp", tools: [], startedBy: starter.sid, startedByAlias: "ken", body: "开工" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => f.created.length > 0 && f.created[0].prompts.length > 0);
	mailTo(p, sid, "竞态期的消息");
	await waitFor(() => notices(p, starter.sid).length > 0);
	const s = f.created[0];
	assert.equal(s.prompts.length, 2); // 复查轮补投
	assert.ok(s.prompts[1].includes("竞态期的消息"));
	assert.equal(pendingCount(p, sid), 0);
});

test("stopLocal → abort → stopped 讣告; 文件与 presence 保留可再唤醒", async () => {
	const p = tmpMesh();
	const starter = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted());
	const host = makeHost(p, f);
	const r = await legacySpawn(host, { alias: "w6", cwd: "/tmp", tools: [], startedBy: starter.sid, startedByAlias: "ken", body: "跑长活" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => host.isHosted(sid));
	assert.equal(host.stopLocal(sid, "试验性终止"), true);
	await waitFor(() => notices(p, starter.sid).length > 0);
	const n = notices(p, starter.sid)[0].msg;
	assert.equal(n.fact, "stopped");
	assert.ok(n.data?.reason?.includes("试验性终止"));
	assert.ok(readPresence(p, sid));
});

test("control 信 stop 运行中的会话(跨进程 stop 的宿主侧)", async () => {
	const p = tmpMesh();
	const starter = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted());
	const host = makeHost(p, f);
	const r = await legacySpawn(host, { alias: "w7", cwd: "/tmp", tools: [], startedBy: starter.sid, startedByAlias: "ken", body: "跑" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => host.isHosted(sid));
	sendMail(p, { id: newMessageId(), from: starter.sid, to: sid, at: Date.now(), kind: "control", body: "stop", data: { reason: "远程停止" } });
	await waitFor(() => notices(p, starter.sid).length > 0);
	assert.equal(notices(p, starter.sid)[0].msg.fact, "stopped");
});

test("wake: dormant agent 收信被唤醒, drain 全部积压; 子代 quiescent 讣告会唤醒 dormant 父代(派完结束回合的约定); stopped 讣告不唤", async () => {
	const p = tmpMesh();
	// 链条: human ken → agent boss(dormant) → agent leaf(dormant)
	const ken = humanPresence(p, "ken", { live: true });
	const boss = agentPresence(p, "boss", { startedBy: ken.sid });
	const leaf = agentPresence(p, "leaf", { startedBy: boss.sid });
	const f = new FakeFactory();
	f.openScripts.set(leaf.sid, () => "leaf 干完了");
	f.openScripts.set(boss.sid, () => "收到 leaf 的讣告, 汇总完成");
	const host = makeHost(p, f);
	mailTo(p, leaf.sid, "去吧");
	mailTo(p, leaf.sid, "补充: 记得写文件");
	const w = await host.wake(leaf.sid);
	assert.equal(w, "woken");
	// leaf 收场 → quiescent 讣告进 boss 信箱 → finalize 顺手 sweep 把 dormant 的 boss 叫起来(讣告即输入)→ boss 收场 → ken 收到第二层讣告。
	// 快到测试看不见 boss 信箱里的那封信, 所以只看终态。
	await waitFor(() => notices(p, ken.sid).some(({ msg }) => msg.fact === "quiescent"), 5000);
	const leafSession = f.created[0];
	assert.ok(leafSession.prompts[0].includes("去吧"));
	assert.ok(leafSession.prompts[0].includes("记得写文件"));
	assert.equal(f.created.length, 2);
	assert.ok(f.created[1].prompts[0].includes("leaf"), f.created[1].prompts[0]);
	assert.ok(f.created[1].prompts[0].includes("quiescent"));
	assert.equal(pendingCount(p, boss.sid), 0, "讣告被 boss 消费");
	// stopped 讣告不唤(人停整棵树时不得把父代拉起来继续派活)
	sendMail(p, { id: newMessageId(), from: "system", to: boss.sid, at: Date.now(), kind: "notice", fact: "stopped", body: "leaf 被停止", data: { subject: leaf.sid } });
	await host.sweep();
	assert.equal(f.created.length, 2);
	assert.equal(host.isHosted(boss.sid), false);
});
test("并发护栏: cap 满时 spawn 拒绝、wake defer; 槽位释放后 sweep 补投", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted()); // 占住唯一槽位
	const host = makeHost(p, f, 1);
	const r1 = await legacySpawn(host, { alias: "hog", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "占坑" });
	const hogSid = (r1 as { sid: string }).sid;
	await waitFor(() => host.isHosted(hogSid));
	// spawn 拒绝
	const r2 = await legacySpawn(host, { alias: "later", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "x" });
	assert.ok("error" in r2 && r2.error.includes("并发已满"));
	// wake defer
	const dormant = agentPresence(p, "sleepy", { startedBy: ken.sid });
	f.openScripts.set(dormant.sid, () => "醒来干完");
	mailTo(p, dormant.sid, "醒醒");
	assert.equal(await host.wake(dormant.sid), "defer_cap"); // 全局条件, 与限频区分
	// 释放槽位 → finalize 自动 sweep 补投
	host.stopLocal(hogSid, "让位");
	await waitFor(() => notices(p, ken.sid).some(({ msg }) => msg.fact === "quiescent"), 5000);
	assert.ok(f.created[1].prompts[0].includes("醒醒"));
});

test("last_fact: 终局转录进 presence, 再次唤醒时清除", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(() => "干完了");
	const host = makeHost(p, f);
	const r = await legacySpawn(host, { alias: "w", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "活" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => notices(p, ken.sid).length > 0);
	assert.equal(readPresence(p, sid)!.last_fact, "quiescent");

	// 再唤醒 → 清除(它只描述"上一次运行的终局")
	f.openScripts.set(sid, (_t, s) => s.untilAborted());
	mailTo(p, sid, "再干一轮", ken.sid, "ken");
	await host.wake(sid);
	await waitFor(() => host.isHosted(sid));
	assert.equal(readPresence(p, sid)!.last_fact, undefined);

	// 这一次的终局是 stopped
	host.stopLocal(sid, "算了");
	await waitFor(() => !host.isHosted(sid));
	assert.equal(readPresence(p, sid)!.last_fact, "stopped");
});

test("停滞检测: 只报告不处置, 逐级翻倍", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted());
	const host = makeHost(p, f, 8, 50); // stallMs=50
	const r = await legacySpawn(host, { alias: "slow", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "慢" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => host.isHosted(sid));
	await sleep(150);
	host.checkVitals();
	host.checkVitals(); // 第二次立即调用不应重复(阈值已翻倍)
	const stalls = notices(p, ken.sid).filter(({ msg }) => msg.fact === "stalled");
	assert.equal(stalls.length, 1);
	assert.ok(host.isHosted(sid)); // 仍在运行 —— 只报告
	await sleep(300); // 充分超过 50*2 的翻倍阈值
	host.checkVitals();
	assert.equal(notices(p, ken.sid).filter(({ msg }) => msg.fact === "stalled").length, 2);
	host.stopLocal(sid, "clean");
	await waitFor(() => !host.isHosted(sid));
});

test("shutdown: 同步落盘 stopped 讣告 + 锁释放, 讣告不重复", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted());
	const host = makeHost(p, f);
	const r = await legacySpawn(host, { alias: "w9", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "x" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => host.isHosted(sid));
	host.shutdown();
	// 同步即有讣告(不等异步 finalize)
	const ns = notices(p, ken.sid).filter(({ msg }) => msg.fact === "stopped");
	assert.equal(ns.length, 1);
	assert.ok(ns[0].msg.data?.reason?.includes("宿主进程退出"));
	await sleep(50); // 异步 finalize 跑完也不该重复
	assert.equal(notices(p, ken.sid).filter(({ msg }) => msg.fact === "stopped").length, 1);
});

// --- 唤醒频率上限(护栏律的频率维度)---------------------------------------

/** 放行 = 没被限频("already" 表示 sweep 抢先唤醒了,同样算放行)。 */
function assertPassed(r: Awaited<ReturnType<Host["wake"]>>, note: string): void {
	assert.ok(r === "woken" || r === "already", `${note}: 期望放行, 实际 ${JSON.stringify(r)}`);
}

test("体征巡检: 同一轮两者都触发时只发 stalled(更具体), 且 stalled 也附体征", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => s.untilAborted());
	const host = makeHost(p, f, 8, 50, { longrunMs: 50 });
	const r = await legacySpawn(host, { alias: "frozen", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "卡住" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => host.isHosted(sid));
	await sleep(70);
	host.checkVitals();
	const ns = notices(p, ken.sid);
	assert.equal(ns.length, 1);
	assert.equal(ns[0].msg.fact, "stalled");
	assert.equal(ns[0].msg.data?.subject, sid);
	assert.equal(typeof ns[0].msg.data?.elapsed_s, "number");
	assert.equal(ns[0].msg.data?.turns, 0);
	host.stopLocal(sid, "clean");
	await waitFor(() => !host.isHosted(sid));
});

test("隔夜投递: 讣告躺在 human 信箱, 不被 sweep 唤醒(human 只留信)", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: false }); // 人不在
	const f = new FakeFactory();
	f.scripts.push(() => "夜班干完了");
	const host = makeHost(p, f);
	await legacySpawn(host, { alias: "night", cwd: "/tmp", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "夜班" });
	await waitFor(() => notices(p, ken.sid).length > 0);
	await host.sweep();
	// 讣告还在信箱(human 不被唤醒), 等人上线 drain
	assert.equal(notices(p, ken.sid).length, 1);
	assert.equal(notices(p, ken.sid)[0].msg.data?.last_output, "夜班干完了");
});

test("sweep 自动寄宿本会话子树(即使 cwd 在外)且要求有 message; 纯讣告不唤", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true, cwd: "/proj" });
	const child = agentPresence(p, "child", { startedBy: ken.sid, cwd: "/tmp/clone" });
	patchPresence(p, child.sid, { heartbeat_at: Date.now() });
	const f = new FakeFactory();
	f.openScripts.set(child.sid, () => "本树工人, 可寄宿");
	const host = makeHost(p, f, 8, undefined, { cwd: "/proj", selfSid: ken.sid });
	sendMail(p, {
		id: newMessageId(),
		from: "system",
		to: child.sid,
		at: Date.now(),
		kind: "notice",
		fact: "stopped",
		body: "孙子被停了",
		data: { subject: "grand" },
	});
	await host.sweep();
	assert.equal(f.created.length, 0); // 纯讣告不唤
	assert.ok(readPresence(p, child.sid));
	mailTo(p, child.sid, "人让你继续", ken.sid, "ken");
	await host.sweep();
	await waitFor(() => f.created.length === 1);
	assert.ok(f.created[0].prompts[0].includes("人让你继续"));
});

// ---------------------------------------------------------------------------
// interrupt(紧急打断: 撕掉当前 turn 立即注入; 限频超限降级为边界注入)
// ---------------------------------------------------------------------------

/** 每轮 prompt 都以容量错误收场(带真 pi 的 agent_end willRetry=false)。 */
function alwaysRateLimited(message = "429 rate limit exceeded"): Script {
	return (_t, s) => {
		s.autoAgentEnd = true;
		s.willRetry = false;
		s.stopReason = "error";
		s.errorMessage = message;
		return "";
	};
}

function capacityHost(p: MeshPaths, f: FakeFactory, extra: Partial<HostOptions> = {}): Host {
	return makeHost(p, f, 8, undefined, { capacityBackoffMs: [10, 10, 10], ...extra });
}

test("429 阶梯: 退避内恢复 → 不换模型, presence 不留 model_history", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	let round = 0;
	f.scripts.push((_t, s) => {
		s.autoAgentEnd = true;
		s.willRetry = false;
		if (++round <= 2) {
			s.stopReason = "error";
			s.errorMessage = "429 rate limit exceeded";
			return "";
		}
		s.stopReason = "stop";
		s.errorMessage = undefined;
		return "限速过去了, 活干完了";
	});
	const host = capacityHost(p, f);
	const r = await legacySpawn(host, {
		alias: "flaky",
		cwd: "/tmp",
		model: "acme/small",
		tools: [],
		startedBy: ken.sid,
		startedByAlias: "ken",
		body: "干活",
	});
	const sid = (r as { sid: string }).sid;
	await waitFor(() => notices(p, ken.sid).length > 0, 5000);
	const ns = notices(p, ken.sid);
	assert.equal(ns.length, 1, "换模型/退避期间创建者信箱零讣告");
	assert.equal(ns[0].msg.fact, "quiescent");
	assert.equal(f.opens.length, 0, "不换模型就不该重开会话");
	assert.equal(readPresence(p, sid)!.model, "acme/small");
	// 出生 prompt + 2 次退避重试
	assert.equal(f.created[0].prompts.length, 3);
	assert.ok(f.created[0].prompts[1].includes("限速中断(第 1 次重试)"));
	assert.ok(f.created[0].prompts[1].includes("先核实副作用"));
	assert.ok(f.created[0].prompts[2].includes("第 2 次重试"));
});

test("429 阶梯: 三次退避仍失败 → died, reason 附完整尝试记录; 不换模型", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(alwaysRateLimited("Weekly usage limit reached; limit will reset in 3 hours"));
	const host = capacityHost(p, f);
	await legacySpawn(host, { alias: "doomed", cwd: "/tmp", model: "acme/small", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "干活" });
	await waitFor(() => notices(p, ken.sid).length > 0, 5000);
	const ns = notices(p, ken.sid);
	assert.equal(ns.length, 1, "阶梯期间不发中间讣告");
	const n = ns[0].msg;
	assert.equal(n.fact, "died");
	assert.ok(n.data?.reason?.includes("Weekly usage limit"), n.data?.reason);
	assert.ok(n.data?.reason?.includes("尝试记录"));
	assert.ok(n.data?.reason?.includes("退避"));
	assert.ok(n.data?.reason?.includes("不自动换模型"));
	assert.ok((n.data?.reason?.length ?? 0) <= 600);
	assert.equal(f.created[0].prompts.length, 4); // 出生 + 三次退避
});

test("429 阶梯: 非容量错误(401)直接 died, 不退避不换模型", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(alwaysRateLimited("401 unauthorized: invalid api key"));
	const host = capacityHost(p, f);
	await legacySpawn(host, {
		alias: "badkey",
		cwd: "/tmp",
		model: "acme/small",
		tools: [],
		startedBy: ken.sid,
		startedByAlias: "ken",
		body: "干活",
	});
	await waitFor(() => notices(p, ken.sid).length > 0, 5000);
	const n = notices(p, ken.sid)[0].msg;
	assert.equal(n.fact, "died");
	assert.ok(n.data?.reason?.includes("401"));
	assert.ok(!n.data?.reason?.includes("尝试记录"));
	assert.equal(f.created[0].prompts.length, 1);
	assert.equal(f.opens.length, 0);
});

test("429 阶梯: pi 内层重试(多条 error 后 agent_end willRetry=true)不触发外层阶梯", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push((_t, s) => {
		// m0 实证: 一次 429 在会话里是 4 条 error 消息, 中间的 agent_end 都是 willRetry=true
		s.emitAssistantError("429 rate limit exceeded");
		s.emitAgentEnd(true);
		s.emitAssistantError("429 rate limit exceeded");
		s.emitAgentEnd(true);
		s.autoAgentEnd = true;
		s.willRetry = false;
		return "内层退避之后自己成功了";
	});
	const host = capacityHost(p, f);
	await legacySpawn(host, {
		alias: "inner",
		cwd: "/tmp",
		model: "acme/small",
		tools: [],
		startedBy: ken.sid,
		startedByAlias: "ken",
		body: "干活",
	});
	await waitFor(() => notices(p, ken.sid).length > 0, 5000);
	assert.equal(notices(p, ken.sid)[0].msg.fact, "quiescent");
	assert.equal(f.created[0].prompts.length, 1, "外层一次退避都不该做");
	assert.equal(f.opens.length, 0);
});

test("429 阶梯: stop 打断退避等待, 终局是 stopped 不是 died", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const f = new FakeFactory();
	f.scripts.push(alwaysRateLimited());
	const host = capacityHost(p, f, { capacityBackoffMs: [30_000, 30_000, 30_000] });
	const r = await legacySpawn(host, { alias: "waiter", cwd: "/tmp", model: "acme/small", tools: [], startedBy: ken.sid, startedByAlias: "ken", body: "干活" });
	const sid = (r as { sid: string }).sid;
	await waitFor(() => f.created.length > 0 && f.created[0].prompts.length === 1);
	await sleep(60); // 进入 30s 退避等待
	const t0 = Date.now();
	assert.equal(host.stopLocal(sid, "别等了"), true);
	await waitFor(() => notices(p, ken.sid).length > 0, 3000);
	assert.ok(Date.now() - t0 < 2_000, "stop 必须立刻打断退避等待");
	const n = notices(p, ken.sid)[0].msg;
	assert.equal(n.fact, "stopped");
	assert.ok(n.data?.reason?.includes("别等了"));
});


// --- 频次预算(唯一的限频原语)---------------------------------------------

test("wake 预算: agent 互发连唤 6 次后第 7 次 defer(消息不丢); 讣告不计; 人的消息放行且清窗", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const boss = agentPresence(p, "boss", { startedBy: ken.sid, live: true });
	const worker = agentPresence(p, "worker", { startedBy: boss.sid });
	const f = new FakeFactory();
	f.openScripts.set(worker.sid, () => "ok");
	const host = makeHost(p, f);
	for (let i = 0; i < 6; i++) {
		mailTo(p, worker.sid, `agent 第 ${i} 条`, boss.sid, "boss");
		const r = await host.wake(worker.sid);
		assert.ok(r === "woken" || r === "already", `第 ${i + 1} 次: ${JSON.stringify(r)}`);
		await waitFor(() => !host.isHosted(worker.sid));
	}
	mailTo(p, worker.sid, "第 7 条", boss.sid, "boss");
	assert.equal(await host.wake(worker.sid), "defer_throttle");
	assert.equal(pendingCount(p, worker.sid), 1);
	assert.equal(notices(p, ken.sid).filter(({ msg }) => msg.fact !== "quiescent").length, 0, "没有 throttled 讣告这种东西了");
	// 讣告不计频
	sendMail(p, { id: newMessageId(), from: "system", to: worker.sid, at: Date.now(), kind: "notice", fact: "quiescent", body: "child 归于安静", data: { subject: "child" } });
	// 人插一句 → 放行 + 清窗
	mailTo(p, worker.sid, "人来问一句", ken.sid, "ken");
	const r = await host.wake(worker.sid);
	assert.ok(r === "woken" || r === "already");
	await waitFor(() => !host.isHosted(worker.sid));
	assert.equal((readPresence(p, worker.sid)!.wake_log ?? []).length, 0);
	assert.equal(pendingCount(p, worker.sid), 0);
});

test("sweep 是全域的: 任何 cwd 的 dormant agent 有工作消息就唤醒; 纯讣告 / notify 不唤", async () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true, cwd: "/proj" });
	const foreign = agentPresence(p, "foreign", { startedBy: ken.sid, cwd: "/elsewhere" });
	patchPresence(p, foreign.sid, { heartbeat_at: Date.now() });
	const f = new FakeFactory();
	f.openScripts.set(foreign.sid, () => "全域宿主, 照样跑");
	const host = makeHost(p, f);
	sendMail(p, { id: newMessageId(), from: "system", to: foreign.sid, at: Date.now(), kind: "notice", fact: "stopped", body: "孙子被停了", data: { subject: "grand" } });
	sendMail(p, { id: newMessageId(), from: ken.sid, from_alias: "ken", to: foreign.sid, at: Date.now(), kind: "message", body: "收到", intent: "notify" });
	await host.sweep();
	assert.equal(f.created.length, 0, "讣告与 notify 都不唤");
	mailTo(p, foreign.sid, "续跑", ken.sid, "ken");
	await host.sweep();
	await waitFor(() => f.created.length === 1);
	assert.ok(f.created[0].prompts[0].includes("续跑"));
	assert.ok(f.created[0].prompts[0].includes("收到"), "notify 信在唤醒时一并送达");
});

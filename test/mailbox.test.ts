import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tmpMesh, waitFor } from "./helpers.ts";
import { consumeMail, listMail, newMessageId, pendingBySid, pendingCount, planInjection, renderMail, sendMail, watchMailbox } from "../src/mailbox.ts";
import type { MailFile } from "../src/mailbox.ts";
import type { MeshMessage, NoticeFact } from "../src/types.ts";

function msg(to: string, body: string, extra: Partial<MeshMessage> = {}): MeshMessage {
	return { id: newMessageId(), from: "s1", from_alias: "one", to, at: Date.now(), kind: "message", body, ...extra };
}

test("sendMail/listMail: 原子落盘, 字典序即时序", async () => {
	const p = tmpMesh();
	const a = msg("box1", "first");
	await new Promise((r) => setTimeout(r, 5));
	const b = msg("box1", "second");
	sendMail(p, a);
	sendMail(p, b);
	const got = listMail(p, "box1");
	assert.equal(got.length, 2);
	assert.equal(got[0].msg.body, "first");
	assert.equal(got[1].msg.body, "second");
	assert.equal(pendingCount(p, "box1"), 2);
	assert.deepEqual([...pendingBySid(p).keys()], ["box1"]);
});

test("consumeMail 幂等; 损坏文件被清理", () => {
	const p = tmpMesh();
	sendMail(p, msg("box2", "x"));
	fs.writeFileSync(path.join(p.mailbox, "box2", "m_zz_corrupt.json"), "{broken");
	const got = listMail(p, "box2");
	assert.equal(got.length, 1); // 损坏的被清
	consumeMail(got.map((g) => g.file));
	consumeMail(got.map((g) => g.file)); // 幂等
	assert.equal(pendingCount(p, "box2"), 0);
});

test("watchMailbox: rename-in 触发(spike 实证路径)", async () => {
	const p = tmpMesh();
	let fired = 0;
	const close = watchMailbox(p, "box3", () => fired++);
	sendMail(p, msg("box3", "ping"));
	// FSEvents 高负载下偶发丢单个事件(内核靠轮询兜底);测试容忍一次丢失:
	// 补写第二封仍不触发才算 watch 真坏了。
	try {
		await waitFor(() => fired > 0, 1500);
	} catch {
		sendMail(p, msg("box3", "ping-retry"));
		await waitFor(() => fired > 0, 3000);
	}
	close();
	const before = fired;
	sendMail(p, msg("box3", "after-close"));
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(fired, before); // 关闭后不再触发
});

// --- planInjection(投递有界:纯函数,零 IO)---------------------------------

function mf(msg: MeshMessage): MailFile {
	return { file: `/fake/${msg.id}.json`, msg };
}

function vital(fact: NoticeFact, subject: string, at: number, body = `${fact} ${subject} @${at}`): MailFile {
	return mf({ id: newMessageId(), from: "system", to: "me", at, kind: "notice", fact, body, data: { subject } });
}

test("planInjection: 旧体征被支配即丢弃, 前 10 封按时序注入, 其余留箱", () => {
	const mail: MailFile[] = [];
	let at = 1_000_000;
	// 3 个 subject 各 4 条 stalled(12 封), 每轮夹一封普通消息(4 封)
	for (let round = 0; round < 4; round++) {
		for (const s of ["a", "b", "c"]) mail.push(vital("stalled", s, at++, `${s} 静默 r${round}`));
		mail.push(mf({ id: newMessageId(), from: "peer", from_alias: "peer", to: "me", at: at++, kind: "message", body: `chat ${round}` }));
	}
	// 9 封不同 subject 的 quiescent(体征之外的 fact 永不丢)
	for (const s of ["d", "e", "f", "g", "h", "i", "j", "k", "l"]) mail.push(vital("quiescent", s, at++));
	assert.equal(mail.length, 25);

	// 测试用的 at 是假时间戳(远古), 关掉 aging 才看得到优先级本身
	const plan = planInjection(mail, { maxCount: 10, agingMs: 0 });
	assert.equal(planInjection(mail, 10).inject.length, 10); // 数字第二参 = maxCount(兼容老调用)
	// 丢弃的恰是 3 个 subject 各自被支配的前 3 条 stalled
	assert.equal(plan.drop.length, 9);
	assert.ok(plan.drop.every(({ msg }) => msg.fact === "stalled"));
	for (const s of ["a", "b", "c"]) {
		const kept = [...plan.inject, ...plan.defer].filter(({ msg }) => msg.fact === "stalled" && msg.data?.subject === s);
		assert.equal(kept.length, 1);
		assert.ok(kept[0].msg.body.includes("r3")); // 留下的是最新那条
	}
	// 有界:10 封注入, 其余留箱下回合再批, 一封不丢; 留箱的有信封摘要
	assert.equal(plan.inject.length, 10);
	assert.equal(plan.defer.length, 6);
	assert.equal(plan.inject.length + plan.defer.length + plan.drop.length, mail.length);
	const ats = plan.inject.map(({ msg }) => msg.at);
	assert.deepEqual(ats, [...ats].sort((x, y) => x - y)); // 批内按时序
	// 优先级三档: 汇报(peer 的 message)是第 1 档全进; stalled 体征与 quiescent 同为第 2 档按时序补位
	assert.equal(plan.inject.filter(({ msg }) => msg.kind === "message").length, 4);
	assert.equal(plan.inject.filter(({ msg }) => msg.fact === "stalled").length, 3);
	assert.equal(plan.inject.filter(({ msg }) => msg.fact === "quiescent").length, 3);
	assert.ok(plan.defer.every(({ msg }) => msg.fact === "quiescent"));
	assert.equal(plan.summary?.deferred, 6);
	assert.equal(plan.summary?.by_sender.system, 6);
	assert.equal(plan.drop.filter(({ msg }) => msg.kind !== "notice" || msg.fact === "quiescent").length, 0);
});

test("planInjection: 小批量全部注入, 不丢不留", () => {
	const mail = [
		mf({ id: newMessageId(), from: "peer", to: "me", at: 1, kind: "message", body: "hi" }),
		vital("quiescent", "x", 2),
		vital("died", "y", 3),
	];
	const plan = planInjection(mail);
	assert.equal(plan.inject.length, 3);
	assert.equal(plan.drop.length, 0);
	assert.equal(plan.defer.length, 0);
});

test("planInjection: 分组键是 (fact, subject) —— stalled 与 timebox 互不支配", () => {
	const s1 = vital("stalled", "sid-a", 100);
	const l1 = vital("timebox", "sid-a", 101);
	const s2 = vital("stalled", "sid-a", 102);
	const other = vital("stalled", "sid-b", 103);
	const plan = planInjection([s1, l1, s2, other]);
	assert.deepEqual(plan.drop.map(({ msg }) => msg.at), [100]); // 只有被同组新体征支配的那条
	assert.deepEqual(plan.inject.map(({ msg }) => msg.at), [101, 102, 103]);
	assert.equal(plan.defer.length, 0);
});

test("renderMail: 信封透明, 含 id 与 from 别名, system 通知带 fact", () => {
	const m1 = msg("x", "hello");
	const m2: MeshMessage = { id: newMessageId(), from: "system", to: "x", at: Date.now(), kind: "notice", fact: "quiescent", body: "done", data: { last_output: "final words" } };
	const text = renderMail([m1, m2]);
	assert.ok(text.startsWith("<mesh_messages>"));
	assert.ok(text.includes(m1.id));
	assert.ok(text.includes("one("));
	assert.ok(text.includes('"fact":"quiescent"'));
	assert.ok(text.includes("final words"));
});

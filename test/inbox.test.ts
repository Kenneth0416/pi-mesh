/** §13 收件箱物理:意图路由、注入预算、优先级/aging、讣告折叠、冻结令 superseded(全部纯函数或仅信箱 IO)。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { newMessageId, planInjection, rankOf, renderMail } from "../src/mailbox.ts";
import type { MailFile } from "../src/mailbox.ts";
import { planInjectGate } from "../src/inject-gate.ts";
import { route } from "../src/deliver.ts";
import type { MeshMessage, Presence } from "../src/types.ts";
import { INJECT_MAX_CHARS, isUrgentIntent, isWorkIntent } from "../src/types.ts";

function m(over: Partial<MeshMessage> & { at: number }): MeshMessage {
	return { id: newMessageId(), from: "peer", from_alias: "peer", to: "me", kind: "message", body: "x", ...over };
}
function mf(msg: MeshMessage): MailFile {
	return { file: `/dev/null/${msg.id}`, msg };
}

test("intent 语义: blocker 紧急; notify 不算工作", () => {
	assert.equal(isUrgentIntent("blocker"), true);
	assert.equal(isUrgentIntent("report"), false);
	assert.equal(isUrgentIntent(undefined), false);
	assert.equal(isWorkIntent("notify"), false);
	assert.equal(isWorkIntent("report"), true);
	assert.equal(isWorkIntent(undefined), true);
});

test("路由: notify 给 dormant agent 只留信不唤醒(hostd 与 inproc 都是); 其余意图照旧", () => {
	const agent: Presence = { sid: "a", alias: "a", kind: "agent", cwd: "/", born_at: 0, heartbeat_at: 0, stats: { tokens: 0, turns: 0 } };
	const base = { target: agent, hostedHere: false, live: false, running: 0, cap: 8 };
	assert.equal(route({ ...base, canHost: false, intent: "notify" }).action, "mailbox");
	assert.equal(route({ ...base, canHost: true, intent: "notify" }).action, "mailbox");
	assert.equal(route({ ...base, canHost: false, intent: "report" }).action, "nudge");
	assert.equal(route({ ...base, canHost: true }).action, "wake");
	assert.equal(route({ ...base, canHost: true, intent: "blocker" }).action, "wake");
});

test("闸门: report 汇报走合批(不再立即注入); blocker/人的话立即", () => {
	const now = 1_000_000;
	const st = {};
	// 一封普通汇报 → 等
	const r1 = planInjectGate({ now, letters: [{ kind: "message", at: now, urgent: false }], state: st });
	assert.equal(r1.action, "wait");
	// 兼容: 没标 urgent 的 message 仍按紧急(老调用)
	assert.equal(planInjectGate({ now, letters: [{ kind: "message", at: now }], state: st }).action, "inject");
	// 一封紧急 → 整批立即
	const r2 = planInjectGate({ now, letters: [{ kind: "message", at: now, urgent: false }, { kind: "notice", at: now }, { kind: "message", at: now, urgent: true }], state: st });
	assert.equal(r2.action, "inject");
	// 纯汇报持有 30s 强制注入
	assert.equal(planInjectGate({ now: now + 30_000, letters: [{ kind: "message", at: now, urgent: false }], state: { firstHeldAt: now, lastArrivalAt: now } }).action, "inject");
});

test("优先级三档: 紧急/人的话=0; 事实与汇报=1; notify/quiescent/stalled=2; aging 升顶", () => {
	const now = 10_000_000;
	const isHuman = (sid: string) => sid === "ken";
	assert.equal(rankOf(m({ at: now, intent: "blocker" }), now, 0, isHuman), 0);
	assert.equal(rankOf(m({ at: now, from: "ken" }), now, 0, isHuman), 0);
	assert.equal(rankOf(m({ at: now }), now, 0, isHuman), 1);
	assert.equal(rankOf(m({ at: now, from: "system", kind: "notice", fact: "died" }), now, 0, isHuman), 1);
	assert.equal(rankOf(m({ at: now, from: "system", kind: "notice", fact: "workspace" }), now, 0, isHuman), 1);
	assert.equal(rankOf(m({ at: now, from: "system", kind: "notice", fact: "timebox" }), now, 0, isHuman), 1);
	assert.equal(rankOf(m({ at: now, from: "system", kind: "notice", fact: "quiescent" }), now, 0, isHuman), 2);
	assert.equal(rankOf(m({ at: now, from: "system", kind: "notice", fact: "stalled" }), now, 0, isHuman), 2);
	assert.equal(rankOf(m({ at: now, intent: "notify" }), now, 0, isHuman), 2);
	assert.equal(rankOf(m({ at: now - 200_000, intent: "notify" }), now, 180_000, isHuman), 0);
});
test("planInjection: 按字符预算选批; 单封超预算仍至少投一封; 留箱摘要按发件人计数", () => {
	const now = 5_000_000;
	const big = "很长".repeat(INJECT_MAX_CHARS); // 远超预算
	const mail = [
		mf(m({ at: now - 30, body: big, from_alias: "fat" })),
		mf(m({ at: now - 20, body: "report 1", from_alias: "w1" })),
		mf(m({ at: now - 10, body: "report 2", from_alias: "w2" })),
		mf(m({ at: now - 5, body: "急", intent: "blocker", from: "ken", from_alias: "ken" })),
	];
	// 预算只够小信(一行信封约 80-120 字符):大信被留箱, 三封小信进; 批内按时序
	const plan = planInjection(mail, { now, maxChars: 500, agingMs: 0 });
	assert.deepEqual(
		plan.inject.map(({ msg }) => msg.body),
		["report 1", "report 2", "急"],
	);
	assert.equal(plan.defer.length, 1);
	assert.equal(plan.summary?.deferred, 1);
	assert.deepEqual(plan.summary?.by_sender, { fat: 1 });
	// 只有一封大信时: 仍投(不饿死)
	const only = planInjection([mail[0]], { now, maxChars: 500, agingMs: 0 });
	assert.equal(only.inject.length, 1);
	assert.equal(only.defer.length, 0);
	// aging: 大信留箱够久就升顶, 挤掉别人
	const aged = planInjection(mail, { now: now + 400_000, maxChars: 500, agingMs: 180_000 });
	assert.ok(aged.inject.some(({ msg }) => msg.body === big));
});

test("renderMail: quiescent 折叠; 留箱摘要附在末尾", () => {
	const report = m({ at: 1, body: "已提交 abc123, 12 tests 绿", from_alias: "w1" });
	const quiet: MeshMessage = {
		id: newMessageId(),
		from: "system",
		to: "me",
		at: 2,
		kind: "notice",
		fact: "quiescent",
		body: "w1 归于安静 —— 这只是停止说话的物理事实",
		data: { subject: "w1sid", last_output: "已提交 abc123, 12 tests 绿", related_message_id: report.id },
	};
	const text = renderMail([report, quiet], { deferred: { deferred: 3, by_sender: { w2: 3 }, ids: ["m_a"] }, hint: "用 sessions 看" });
	const lines = text.split("\n");
	assert.equal(lines.length, 5); // 头 + 2 封 + 摘要 + 尾
	const q = JSON.parse(lines[2]);
	assert.equal(q.fact, "quiescent");
	assert.equal(q.data.last_output, undefined, "折叠后不重复正文");
	assert.equal(q.data.related_message_id, report.id);
	assert.ok(q.body.includes(report.id));
	const s = JSON.parse(lines[3]);
	assert.equal(s.deferred, 3);
	assert.ok(s.note.includes("用 sessions 看"));
	// 汇报不在同批 → 讣告保留 last_output(文件本来就各自独立)
	const alone = JSON.parse(renderMail([quiet]).split("\n")[1]);
	assert.equal(alone.data.last_output, "已提交 abc123, 12 tests 绿");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { planInjectGate } from "../src/inject-gate.ts";
import type { GateLetter, HoldState } from "../src/inject-gate.ts";
import { NOTICE_HOLD_MAX_MS, NOTICE_HOLD_MIN_MS, NOTICE_QUIET_MS } from "../src/types.ts";

const T0 = 1_700_000_000_000;

function notices(...ats: number[]): GateLetter[] {
	return ats.map((at) => ({ kind: "notice", at }));
}

test("合批: 三封 notice 间隔 2s → 只注入一次, 且不早于首封后 10s", () => {
	let state: HoldState = {};
	const step = (now: number, letters: GateLetter[]) => {
		const r = planInjectGate({ now, letters, state });
		state = r.state;
		return r;
	};
	// 每封信到达后 300ms 都会被叫醒一次(watcher → scheduleInject)
	assert.equal(step(T0 + 300, notices(T0)).action, "wait");
	assert.equal(step(T0 + 2_300, notices(T0, T0 + 2_000)).action, "wait");
	assert.equal(step(T0 + 4_300, notices(T0, T0 + 2_000, T0 + 4_000)).action, "wait");
	// 距最后一封已静默 5s, 但距首封不足 10s → 继续等到 10s 那一刻
	const held = step(T0 + 9_000, notices(T0, T0 + 2_000, T0 + 4_000));
	assert.equal(held.action, "wait");
	assert.equal(held.action === "wait" ? held.waitMs : 0, 1_000);
	// 10s:静默窗与最短持有都满足 → 整批一次注入
	const out = step(T0 + NOTICE_HOLD_MIN_MS, notices(T0, T0 + 2_000, T0 + 4_000));
	assert.equal(out.action, "inject");
	assert.deepEqual(out.state, {}); // 注入即清零持有状态
});

test("合批: 单封 notice 在第 10s 注入(静默 5s 但要满最短持有)", () => {
	let state: HoldState = {};
	const at = (now: number) => {
		const r = planInjectGate({ now, letters: notices(T0), state });
		state = r.state;
		return r;
	};
	const early = at(T0 + NOTICE_QUIET_MS);
	assert.equal(early.action, "wait"); // 静默够了, 持有不够
	assert.equal(early.action === "wait" ? early.waitMs : 0, NOTICE_HOLD_MIN_MS - NOTICE_QUIET_MS);
	assert.equal(at(T0 + NOTICE_HOLD_MIN_MS - 1).action, "wait");
	assert.equal(at(T0 + NOTICE_HOLD_MIN_MS).action, "inject");
});

test("合批: 讣告持续到达也要在 30s 强制注入(等待时长永不越过强制点)", () => {
	let state: HoldState = {};
	let letters: GateLetter[] = [];
	let last = 0;
	for (let t = 0; t < NOTICE_HOLD_MAX_MS; t += 2_000) {
		letters = [...letters, ...notices(T0 + t)];
		const r = planInjectGate({ now: T0 + t + 300, letters, state });
		state = r.state;
		assert.equal(r.action, "wait", `t=${t} 不该注入`);
		last = r.action === "wait" ? r.waitMs : 0;
		assert.ok(T0 + t + 300 + last <= T0 + NOTICE_HOLD_MAX_MS, "等待不得越过强制注入点");
	}
	const forced = planInjectGate({ now: T0 + NOTICE_HOLD_MAX_MS, letters: [...letters, ...notices(T0 + NOTICE_HOLD_MAX_MS)], state });
	assert.equal(forced.action, "inject"); // 一直有新讣告(静默窗从未满足), 靠强制上限收口
});

test("合批: 一封 message 到达 → 整批(含攒着的讣告)立即注入; 空箱清零", () => {
	const state: HoldState = { firstHeldAt: T0, lastArrivalAt: T0 + 1_000 };
	const r = planInjectGate({
		now: T0 + 1_100,
		letters: [...notices(T0, T0 + 500), { kind: "message", at: T0 + 1_000 }],
		state,
	});
	assert.equal(r.action, "inject");
	assert.deepEqual(r.state, {});
	assert.deepEqual(planInjectGate({ now: T0, letters: [], state }).state, {});
});

test("合批: 隔夜信一上线就整批注入(持有已久, 不再干等)", () => {
	const r = planInjectGate({ now: T0, letters: notices(T0 - 8 * 3_600_000, T0 - 7 * 3_600_000), state: {} });
	assert.equal(r.action, "inject");
});

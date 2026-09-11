import assert from "node:assert/strict";
import { test } from "node:test";
import { route } from "../src/deliver.ts";
import type { Presence } from "../src/types.ts";

const agent: Presence = { sid: "a", alias: "a", kind: "agent", cwd: "/", born_at: 0, heartbeat_at: 0, stats: { tokens: 0, turns: 0 } };
const human: Presence = { ...agent, sid: "h", alias: "h", kind: "human" };

test("投递律路由矩阵(hostd 是宿主 canHost=true)", () => {
	const base = { running: 0, cap: 8, canHost: true };
	assert.equal(route({ ...base, target: agent, hostedHere: true, live: true }).action, "steer_local");
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: true }).action, "mailbox");
	assert.equal(route({ ...base, target: human, hostedHere: false, live: false }).action, "mailbox");
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: false }).action, "wake");
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: false, intent: "blocker" }).action, "wake");
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: false, intent: "notify" }).action, "mailbox");
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: false, running: 8 }).action, "defer");
});

test("TUI 不寄宿(canHost=false): dormant agent 只留信 + 敲 hostd", () => {
	const base = { running: 0, cap: 8, canHost: false };
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: false }).action, "nudge");
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: false, intent: "notify" }).action, "mailbox");
	assert.equal(route({ ...base, target: agent, hostedHere: false, live: true }).action, "mailbox");
	assert.equal(route({ ...base, target: human, hostedHere: true, live: true }).action, "steer_local");
});

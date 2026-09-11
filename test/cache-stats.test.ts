/** 用量仪表:从 message_end 到 presence、sessions 的端到端口径。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { Host } from "../src/host.ts";
import { createKernel } from "../src/kernel.ts";
import { newMessageId, sendMail } from "../src/mailbox.ts";
import { allPresence, patchPresence, readPresence } from "../src/registry.ts";
import { addUsage, cacheHitPct, cacheLabel, normalizeStats } from "../src/types.ts";
import type { SessionStats, SessionUsage } from "../src/types.ts";
import { FakeFactory, humanPresence, legacySpawn, tmpMesh, waitFor } from "./helpers.ts";

test("host message_end: 累计用量/成本与最近命中率,缺 cacheRead 不污染分母,唤醒后续加", async (t) => {
	const paths = tmpMesh();
	const me = humanPresence(paths, "creator", { live: true, cwd: paths.root });
	const factory = new FakeFactory();
	factory.defaultScript = (_text, session) => session.untilAborted();
	const host = new Host({ paths, factory, pid: process.pid, cap: 10 });
	t.after(async () => {
		host.shutdown();
		await waitFor(() => host.hostedCount() === 0);
		fs.rmSync(paths.root, { recursive: true, force: true });
	});
	const r = await legacySpawn(host, { alias: "worker", cwd: paths.root, tools: ["read"], startedBy: me.sid, startedByAlias: me.alias, body: "测试" });
	assert.ok(!("error" in r));
	const sid = r.sid;
	const emit = (usage?: SessionUsage) => {
		factory.created.at(-1)!.emit({ type: "message_end", message: { role: "assistant", usage } });
		host.heartbeat();
		return readPresence(paths, sid)!.stats;
	};
	let stats = emit({ input: 50_000, cacheRead: 150_000, cacheWrite: 1000, output: 200, reasoning: 100, totalTokens: 201_200, cost: { total: 0.125 } });
	assert.equal(stats.last_hit_pct, 75);
	stats = emit({ input: 160_000, cacheRead: 0, cacheWrite: 2000, output: 300, totalTokens: 162_300, cost: { total: 0.25 } });
	assert.deepEqual(stats, { tokens: 363_500, turns: 2, input: 210_000, cache_read: 150_000, cache_write: 3000, output: 500, cost_usd: 0.375, last_hit_pct: 0 });
	assert.equal(cacheHitPct(stats), 100 * 150_000 / 360_000);
	stats = emit({ input: 900_000, cacheWrite: 4000, output: 400, totalTokens: 904_400, cost: { total: 0.5 } });
	assert.equal(stats.input, 210_000);
	assert.equal(stats.cache_read, 150_000);
	assert.equal(stats.cache_write, 7000);
	assert.equal(stats.output, 900);
	assert.equal(stats.cost_usd, 0.875);
	assert.equal(stats.last_hit_pct, undefined);
	assert.equal(cacheLabel(stats, true), "⚠cache 42%");
	stats = emit();
	assert.equal(stats.turns, 4);
	assert.equal(stats.tokens, 1_267_900);
	assert.equal(stats.last_hit_pct, undefined);
	// user/toolResult 即使附 usage 也不是助手推理回合。
	for (const role of ["user", "toolResult"]) factory.created[0].emit({ type: "message_end", message: { role, usage: { input: 1_000_000, cacheRead: 0 } } });
	host.heartbeat();
	assert.deepEqual(readPresence(paths, sid)!.stats, stats);
	host.stopLocal(sid, "测试休眠");
	await waitFor(() => !host.isHosted(sid));
	assert.deepEqual(readPresence(paths, sid)!.stats, stats);
	sendMail(paths, { id: newMessageId(), from: me.sid, to: sid, at: Date.now(), kind: "message", body: "继续" });
	assert.equal(await host.wake(sid), "woken");
	stats = emit({ input: 10_000, cacheRead: 30_000, output: 100, totalTokens: 40_100 });
	assert.equal(stats.input, 220_000);
	assert.equal(stats.cache_read, 180_000);
	assert.equal(stats.output, 1000);
	assert.equal(stats.tokens, 1_308_000);
	assert.equal(stats.turns, 5);
	assert.equal(stats.last_hit_pct, 75);
	assert.equal(cacheHitPct(stats), 45);

	const kernel = createKernel({ paths, host, cap: 10, selfSid: () => me.sid, resolveModel: (model) => ({ model }), nudgeSelf: () => {} });
	const list = kernel.sessions(me.sid, {}) as { sessions: Array<{ sid: string; cache_pct?: number; cache?: string }> };
	assert.equal(list.sessions.find((p) => p.cache_pct !== undefined)?.cache, "⚠cache 45%");
	const deep = kernel.sessions(me.sid, { id: sid }) as { stats: SessionStats; cache_pct: number; cache: string };
	assert.deepEqual(deep.stats, stats);
	assert.equal(deep.cache_pct, 45);
	assert.equal(deep.cache, "⚠cache 45%");
	const self = kernel.sessions(me.sid, { id: me.sid }) as Record<string, unknown>;
	assert.equal("cache_pct" in self, false);
	assert.equal("cache" in self, false);
});

test("旧 presence: 单读与列表均补缺省,零分母不显示;真实 0% 与缺失分开", () => {
	const paths = tmpMesh();
	try {
		const me = humanPresence(paths, "old", { cwd: paths.root });
		patchPresence(paths, me.sid, { stats: { tokens: 10, turns: 1 } });
		const expected = normalizeStats({ tokens: 10, turns: 1 });
		assert.deepEqual(readPresence(paths, me.sid)!.stats, expected);
		assert.deepEqual(allPresence(paths)[0].stats, expected);
		assert.equal(cacheHitPct(expected), undefined);
		assert.equal(cacheLabel(expected, true), "");
		const unknown = addUsage(expected, { input: 300_000, output: 1 });
		assert.equal(cacheHitPct(unknown), undefined);
		assert.equal(unknown.input, 0);
		const zero = addUsage(unknown, { input: 300_000, cacheRead: 0 });
		assert.equal(zero.last_hit_pct, 0);
		assert.equal(cacheLabel(zero, true), "⚠cache 0%");
		const empty = addUsage(zero, { input: 0, cacheRead: 0 });
		assert.equal(empty.last_hit_pct, undefined);
		assert.equal(cacheHitPct(empty), 0);
		assert.equal(cacheLabel({ tokens: 0, turns: 0, input: 200_000, cache_read: 0 }, true), "cache 0%");
		assert.equal(cacheLabel({ tokens: 0, turns: 0, input: 200_001, cache_read: 0 }, true), "⚠cache 0%");
		assert.equal(cacheLabel({ tokens: 0, turns: 0, input: 200_000, cache_read: 200_000 }, true), "cache 50%");
	} finally {
		fs.rmSync(paths.root, { recursive: true, force: true });
	}
});

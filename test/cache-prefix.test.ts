/** 缓存前缀回归:真实扩展钩子 + 临时目录,不启动守护进程或请求模型。 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupMesh } from "../index.ts";
import { planFactoryTools } from "../src/factory.ts";
import { createKernel } from "../src/kernel.ts";
import { newMessageId, pendingCount, sendMail } from "../src/mailbox.ts";
import { allPresence, patchPresence, readPresence } from "../src/registry.ts";
import { TOOL_DEFS } from "../src/tools.ts";
import { MAX_DEPTH, sid8 } from "../src/types.ts";
import { agentPresence, humanPresence, tmpMesh } from "./helpers.ts";

function setup(t: TestContext) {
	const paths = tmpMesh();
	const me = humanPresence(paths, "viewer", { live: true, cwd: paths.root });
	const hooks = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const sent: string[] = [];
	let lines: string[] = [];
	let failures = 0;
	const ctx = {
		cwd: paths.root,
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getSessionId: () => me.sid, getSessionFile: () => undefined },
		ui: { setWidget: (_key: string, value?: string[]) => { lines = value ?? []; }, setStatus: () => {} },
	} as unknown as ExtensionContext;
	setupMesh({
		registerTool: () => {},
		registerCommand: () => {},
		on: (name: string, cb: (event: any, ctx: ExtensionContext) => any) => hooks.set(name, cb),
		sendUserMessage: (text: string) => {
			if (failures > 0) { failures--; throw new Error("模拟投递失败"); }
			sent.push(text);
		},
	} as unknown as ExtensionAPI, paths);
	const fire = (name: string, event = {}) => hooks.get(name)!(event, ctx);
	t.after(() => { fire("session_shutdown"); fs.rmSync(paths.root, { recursive: true, force: true }); });
	fire("session_start");
	const mail = () => sendMail(paths, { id: newMessageId(), from: me.sid, to: me.sid, kind: "message", body: "更新", at: Date.now() });
	return { paths, me, fire, mail, sent, lines: () => lines, fail: (n: number) => { failures = n; } };
}

test("before_agent_start: 舰队与未读变化不改变 systemPrompt 的任何字节", (t) => {
	const { paths, me, fire, mail } = setup(t);
	const prompt = () => fire("before_agent_start", { systemPrompt: "原始系统提示\n" }).systemPrompt as string;
	const before = prompt();
	const worker = agentPresence(paths, "worker", { live: true, startedBy: me.sid, cwd: paths.root });
	mail();
	assert.deepEqual(Buffer.from(prompt()), Buffer.from(before));
	patchPresence(paths, worker.sid, { host_pid: undefined, last_fact: "died" });
	assert.deepEqual(Buffer.from(prompt()), Buffer.from(before));
	assert.match(before, new RegExp(`你的 mesh 身份: .*\\(${sid8(me.sid)}\\)`));
	assert.doesNotMatch(before, /你的舰队|running|dormant|未读/);
});

test("flushInject: 首次及状态变化带舰队头,不变省略,仅比较上次注入快照", (t) => {
	const { paths, me, fire, mail, sent } = setup(t);
	const inject = () => { mail(); fire("agent_settled"); return sent.at(-1)!; };
	assert.match(inject(), /^<mesh_messages>\n你的舰队: 0 running \/ 0 dormant \/ 0 未读。\n/); // 正在注入的这批不算未读
	assert.doesNotMatch(inject(), /你的舰队/);
	const worker = agentPresence(paths, "worker", { live: true, startedBy: me.sid, cwd: paths.root });
	assert.match(inject(), /你的舰队: 1 running \/ 0 dormant/);
	assert.doesNotMatch(inject(), /你的舰队/);
	patchPresence(paths, worker.sid, { host_pid: undefined });
	assert.match(inject(), /0 running \/ 1 dormant\(worker\)/);
	assert.doesNotMatch(inject(), /你的舰队/);
	mail();
	mail();
	assert.doesNotMatch(inject(), /你的舰队/); // 两封同批注入,未读仍为 0,舰队无变化不带头
	assert.equal(pendingCount(paths, me.sid), 0);
});

test("flushInject: 投递双失败不推进基线,followUp 成功才推进", (t) => {
	const { paths, me, fire, mail, sent, fail } = setup(t);
	mail();
	fail(2);
	fire("agent_settled");
	assert.equal(sent.length, 0);
	assert.equal(pendingCount(paths, me.sid), 1);
	fail(1);
	fire("agent_settled");
	assert.match(sent[0], /你的舰队/);
	mail();
	fire("agent_settled");
	assert.doesNotMatch(sent[1], /你的舰队/);
});

test("widget 与 human 统计: cache 仅在有可观测分母时显示", (t) => {
	const { paths, me, fire, lines } = setup(t);
	const worker = agentPresence(paths, "worker", { live: true, startedBy: me.sid, cwd: paths.root });
	fire("agent_settled");
	assert.doesNotMatch(lines().join("\n"), /cache/);
	patchPresence(paths, worker.sid, { stats: { tokens: 300_000, turns: 2, input: 210_000, cache_read: 90_000 } });
	fire("agent_settled");
	assert.match(lines().join("\n"), /worker.*cache 30%/);
	patchPresence(paths, worker.sid, { host_pid: undefined, last_fact: "died" });
	fire("agent_settled");
	assert.match(lines().join("\n"), /died.*cache 30%/);
	fire("message_end", { message: { role: "assistant", usage: { input: 100, cacheRead: 300, output: 20, cost: { total: 0.01 } } } });
	fire("message_end", { message: { role: "assistant", usage: { input: 9000, output: 10 } } });
	const stats = readPresence(paths, me.sid)!.stats;
	assert.equal(stats.input, 100);
	assert.equal(stats.cache_read, 300);
	assert.equal(stats.output, 30);
	assert.equal(stats.cost_usd, 0.01);
	assert.equal(stats.last_hit_pct, undefined);
});

test("factory: 兄弟工具集合的顺序与重复不影响最终 tools/customTools 前缀", () => {
	for (const depth of [1, MAX_DEPTH]) {
		const first = planFactoryTools({ cwd: ".", depth, tools: ["read", "bash", "read", "send"] }, [...TOOL_DEFS, TOOL_DEFS[0]]);
		const second = planFactoryTools({ cwd: ".", depth, tools: ["send", "bash", "read"] }, [...TOOL_DEFS].reverse());
		assert.deepEqual(first, second);
		assert.deepEqual(first.tools, [...new Set(first.tools)].sort());
		const names = first.childVerbs.map((d) => d.verb);
		assert.deepEqual(names, [...new Set(names)].sort());
		assert.equal(names.includes("agent"), depth < MAX_DEPTH);
	}
});

test("kernel: 显式与继承工具在 presence 里规范化,唤醒计划与出生计划相同", async () => {
	const paths = tmpMesh();
	try {
		const me = humanPresence(paths, "creator", { live: true, cwd: paths.root });
		const kernel = createKernel({ paths, cap: 10, selfSid: () => me.sid, resolveModel: (model) => ({ model }), nudgeSelf: () => {}, ensureHostd: async () => ({ ok: true }) });
		for (const tools of [["read", "bash", "read"], ["bash", "read"]]) {
			const result = await kernel.agent(me.sid, { body: "测试", tools }) as { tools: string[] };
			assert.deepEqual(result.tools, ["bash", "read"]);
		}
		const workers = allPresence(paths).filter((p) => p.kind === "agent");
		for (const p of workers) assert.deepEqual(p.tools, ["bash", "read"]);
		const inherited = await kernel.agent(workers[0].sid, { body: "继承" }) as { tools: string[] };
		assert.deepEqual(inherited.tools, ["bash", "read"]);
		const spec = { cwd: paths.root, depth: 1, tools: ["read", "bash", "read"] };
		assert.deepEqual(planFactoryTools(spec, TOOL_DEFS), planFactoryTools({ ...spec, tools: workers[0].tools! }, TOOL_DEFS));
	} finally {
		fs.rmSync(paths.root, { recursive: true, force: true });
	}
});

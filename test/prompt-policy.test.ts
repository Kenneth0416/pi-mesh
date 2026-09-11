/** P0 prompt-surface contracts, not model-behavior or efficiency benchmarks.
 * Register the real extension against an inert API; never start a session/hostd.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import meshExtension from "../index.ts";
import { AGENT_PARAMS, TOOL_DEFS } from "../src/tools.ts";

function registeredTools(): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	meshExtension({
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: () => {},
		on: () => {}, // Do not fire lifecycle callbacks: no registry, timers or daemon.
	} as unknown as ExtensionAPI);
	return tools;
}

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const childFacts = readFileSync(new URL("../prompts/agent-facts.md", import.meta.url), "utf8");

function humanFacts(): string {
	const match = source.match(/\bconst humanFacts = ("(?:\\.|[^"\\])*");/);
	assert.ok(match, "the actual before_agent_start facts must remain inspectable");
	return JSON.parse(match[1]) as string;
}

test("P0: real tool registration preserves the four verbs and agent parameter contract", () => {
	const tools = registeredTools();
	assert.deepEqual(tools.map((tool) => tool.name), ["agent", "send", "sessions", "stop"]);
	assert.deepEqual(AGENT_PARAMS.required, ["task"]);
	assert.deepEqual(Object.keys(AGENT_PARAMS.properties).sort(), ["alias", "cwd", "model", "task", "thinking", "timebox_min", "tools"]);
	for (const definition of TOOL_DEFS) {
		const registered = tools.find((tool) => tool.name === definition.verb)!;
		assert.equal(registered.parameters, definition.params);
		assert.equal(registered.description, definition.description);
	}
});

test("P0: thinking 缺省继承创建者,显式选模型不是升档理由", () => {
	const model = (AGENT_PARAMS.properties.model as unknown as { description: string }).description;
	const thinking = (AGENT_PARAMS.properties.thinking as unknown as { description: string }).description;
	for (const text of [model, thinking, childFacts]) {
		assert.match(text, /继承创建者等级/);
		assert.match(text, /未知时.*medium/);
		assert.match(text, /不同模型对同一等级的实际开销不等价/);
		assert.doesNotMatch(text, /低一级|默认 high|换模型=high/);
	}
	assert.match(thinking, /更深思考或更省时.*显式给 thinking/);
	assert.match(thinking, /显式优先/);
});

test("P0: timebox checkpoint 交由 harness 转发,不要求重复 send", () => {
	const timebox = childFacts.split("\n").find((line) => line.startsWith("- **timebox**"))!;
	assert.match(timebox, /checkpoint 报告后结束回合即可/);
	assert.match(timebox, /最后一条消息.*讣告/);
	assert.match(timebox, /不必再 `send creator` 同一份内容/);
	assert.match((AGENT_PARAMS.properties.timebox_min as unknown as { description: string }).description, /不必再 send creator 同一份内容/);
});

test("P0: agent description explains independent async context and the three benefits, not task-label routing", () => {
	const description = registeredTools().find((tool) => tool.name === "agent")!.description;
	for (const text of ["独立上下文", "异步 pi 会话", "并行推进", "隔离大量探索", "另一种判断", "可靠交付收益", "task 要自包含", "执行记录可追溯"]) {
		assert.ok(description.includes(text), `missing capability/benefit: ${text}`);
	}
	assert.doesNotMatch(description, /每部分派一个|调研\/审查\/大改动|派完就结束回合/);
});

test("P0: actual parent guidelines favor reliable delivery and useful parallel work, not a fixed workflow", () => {
	const guidelines = registeredTools().find((tool) => tool.name === "agent")!.promptGuidelines!;
	assert.equal(guidelines.length, 3);
	assert.ok(guidelines.every((line) => line.includes("agent")), "flat pi guidelines must name their tool");
	const text = guidelines.join("\n");
	assert.match(text, /额外 token 换成更快的可靠交付/);
	assert.match(text, /多个步骤也不等于多个独立工作面/);
	assert.match(text, /独立工作应同批派出/);
	assert.match(text, /可继续其他独立工作/);
	assert.match(text, /不重复已委派的范围/);
	assert.match(text, /没有可推进的工作时结束回合/);
	assert.match(text, /不轮询/);
	assert.doesNotMatch(text, /每部分 agent\(\) 一个|优先 agent\(\) 委派|派发后直接结束回合/);
});

test("P0: acceptance stays evidence/risk based and preserves required checks", () => {
	const text = registeredTools().find((tool) => tool.name === "agent")!.promptGuidelines!.join("\n");
	assert.match(text, /自述不是执行证据/);
	assert.match(text, /按风险和证据缺口验收/);
	assert.match(text, /不因使用了 agent 就默认追加验收会话/);
	assert.match(text, /用户或项目明确要求的检查仍须执行/);
});

test("P0: parent startup facts do not reintroduce unconditional post-spawn yielding", () => {
	const text = humanFacts();
	assert.match(text, /结果与异常会自动通知创建者/);
	assert.match(text, /无需轮询/);
	assert.match(text, /creator/);
	assert.doesNotMatch(text, /派完就结束回合|派发后直接结束回合/);
});

test("P0: child progress is not a stop instruction; blocking questions still yield", () => {
	assert.match(childFacts, /只有需要答复才能继续时/);
	assert.match(childFacts, /intent:"blocker"/);
	assert.match(childFacts, /结束回合等待自动唤醒/);
	assert.match(childFacts, /进度汇报不意味着停工/);
	assert.match(childFacts, /能继续就继续/);
	assert.match(childFacts, /只在信息会影响创建者决策时中途汇报/);
	assert.doesNotMatch(childFacts, /求助或汇报进展:.*然后/);
});

test("P0: child result guidance avoids duplicate reports and is honest about notify", () => {
	assert.match(childFacts, /最终成果写在最后回复中/);
	assert.match(childFacts, /无需再用 `send` 重复发送同一份结果/);
	assert.match(childFacts, /声明,不是执行证据/);
	assert.match(childFacts, /保留实际命令、输出和对应版本/);
	assert.match(childFacts, /notify` 不唤醒休眠 agent,但对主会话仍会合批投递/);
	assert.match(childFacts, /不是零唤醒成本/);
	assert.match(childFacts, /委派可用来并行推进、隔离上下文或改善判断,不是固定流程/);
});

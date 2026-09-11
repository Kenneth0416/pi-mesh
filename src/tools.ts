/**
 * tools —— 四动词的工具面(Typebox schema + 描述 + 参数名映射)。TUI 与 hostd 共用同一份。
 * 描述首句是 WHEN 不是 WHAT。不 import 任何 TUI/扩展运行时。
 */

import { Type } from "typebox";
import { MESSAGE_INTENTS, PI_NATIVE_TOOLS } from "./types.ts";
import type { Verb } from "./kernel.ts";

export const AGENT_PARAMS = Type.Object({
	task: Type.String({ description: "任务书。对方看不到你的上下文, 写自包含; 想要什么交付、什么算完成, 直接写清楚。共享规则放文件, 任务书只写差异" }),
	alias: Type.Optional(Type.String({ description: "名字(全网唯一), 之后 send(名字, …) 可继续指挥; 缺省自动生成" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: `工具白名单, 必须是你自己工具集的子集。可选: ${PI_NATIVE_TOOLS.join(", ")}。缺省=继承你的全部` })),
	model: Type.Optional(Type.String({ description: "执行模型 provider/id; 缺省=继承创建者当前模型。无论是否指定 model, thinking 缺省继承创建者等级(未知时 medium); 不同模型对同一等级的实际开销不等价。要独立视角就换 provider。撞配额不会自动换模型: 它会 died 附原因, 由你重派" })),
	thinking: Type.Optional(
		Type.Union(["minimal", "low", "medium", "high", "xhigh"].map((l) => Type.Literal(l)), {
			description: "推理等级, 显式优先; 缺省继承创建者等级(未知时 medium), 与是否指定 model 无关。需要更深思考或更省时就显式给 thinking; 不同模型对同一等级的实际开销不等价",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "工作目录; 缺省=你的工作目录。多人改同一仓库: 一个 agent 一个 git worktree, 所有权由 git 保证" })),
	timebox_min: Type.Optional(
		Type.Number({
			description: "时限(分钟, 墙钟; 不给=无时限)。到点它收到自检信: 停止扩展→最小可提交片→checkpoint 报告后结束回合(harness 转发最后回复, 不必再 send creator 同一份内容); 1.5× 再提醒并给你一封 timebox 通报。不强停; 改时限用 send(timebox_min)",
		}),
	),
});

export const SEND_PARAMS = Type.Object({
	to: Type.String({ description: '收件人: 名字、短 id(末 8 位), 或 "creator"(你的创建者; 不要用它的名字寻址)' }),
	message: Type.String({ description: "消息正文" }),
	intent: Type.Optional(
		Type.Union(
			MESSAGE_INTENTS.map((i) => Type.Literal(i)),
			{
				description: "缺省 report=汇报/追加指令(human 收件人合批, 不打断它推理; 休眠 agent 短窗合批唤醒)。blocker=不回答你就停工(立即注入)。notify=仅供知悉(绝不唤醒收工的 agent)",
			},
		),
	),
	timebox_min: Type.Optional(Type.Number({ description: "从现在起重设收件人时限(分钟; 仅创建者/人)。工人不能自己续期" })),
});

export const SESSIONS_PARAMS = Type.Object({
	id: Type.Optional(Type.String({ description: '省略=列出你派出的子树; 给名字、短 id 或 "creator"=深查(含最后输出全文、子会话、未读信、会话文件)' })),
	unread_full: Type.Optional(Type.Boolean({ description: "深查时未读信正文全文(最多 30 封)" })),
});

export const STOP_PARAMS = Type.Object({
	target: Type.String({ description: "要终止的 agent(名字或短 id)。会话文件保留, 之后 send 一条消息可再唤醒" }),
	reason: Type.Optional(Type.String({ description: "原因, 写进讣告" })),
});

export interface ToolDef {
	verb: Verb;
	label: string;
	description: string;
	params: ReturnType<typeof Type.Object>;
}

export const TOOL_DEFS: ToolDef[] = [
	{
		verb: "agent",
		label: "Agent",
		description:
			"启动一个独立上下文的异步 pi 会话, 处理一块可独立交付的工作。可用于并行推进、隔离大量探索或取得另一种判断; 是否委派取决于可靠交付收益, 不取决于任务名称或步骤数量。agent 看不到当前对话, task 要自包含; 多人改同一仓库时给每个 agent 自己的 worktree(cwd)。结果与异常会自动通知创建者, 执行记录可追溯, 讣告附 harness 观测的 git 事实; 无需轮询等待。",
		params: AGENT_PARAMS,
	},
	{
		verb: "send",
		label: "Send",
		description:
			"给已有会话发消息: 追加指令、续跑休眠的 agent、回复求助、跟别的终端对话(人的会话只留信)。选对 intent: 汇报 report, 卡住 blocker, 知会 notify。agent 给创建者写信用 to=creator。新 agent 用 agent 工具。",
		params: SEND_PARAMS,
	},
	{
		verb: "sessions",
		label: "Sessions",
		description: "看你派出的子树(✓安静=停止输出待验收 ✗死亡 ⏹被停 ⏸休眠可续跑)、谁在跑、tokens、剩余时限。只列自己这棵树。带 id 深查单个(全域)。",
		params: SESSIONS_PARAMS,
	},
	{
		verb: "stop",
		label: "Stop",
		description: "强停一个失控的 agent(唯一强制手段)。会话文件保留, send 一条消息可再唤醒。不能停人的会话。",
		params: STOP_PARAMS,
	},
];

/** 工具面用 task/to/message,内核说 body/target —— 映射只在这条边界上。 */
export function toKernelArgs(verb: Verb, params: Record<string, unknown>): Record<string, unknown> {
	if (verb === "agent") {
		const { task, ...rest } = params;
		return { ...rest, body: task };
	}
	if (verb === "send") {
		const { to, message, ...rest } = params;
		return { ...rest, target: to, body: message };
	}
	return params;
}

/** 测试基建:tmp mesh 根、FakeSession/FakeFactory(引擎接口的内存实现)、waitFor。 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MeshPaths, Presence, SessionUsage } from "../src/types.ts";
import { meshPaths } from "../src/types.ts";
import { ensureDirs, writePresence } from "../src/registry.ts";
import type { Host, SessionEvent, SessionFactory, SessionHandle, SpawnSpec } from "../src/host.ts";
import { newMessageId } from "../src/mailbox.ts";
import { uuidv7 } from "../src/types.ts";

export function tmpMesh(): MeshPaths {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
	const p = meshPaths(root);
	ensureDirs(p);
	return p;
}

export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------

export type Script = (text: string, s: FakeSession) => Promise<string> | string;

export class FakeSession implements SessionHandle {
	prompts: string[] = [];
	steers: string[] = [];
	disposed = false;
	aborted = false;
	stopReason = "stop";
	errorMessage: string | undefined;
	/** 每轮助手消息带的用量(汇率仪表的原料;测试可改)。 */
	usage: SessionUsage = { totalTokens: 100 };
	/** true=steer 立即以 user message 送达(正常);false=吞掉(模拟 settle 竞态)。 */
	steerDelivers = true;
	/** true=每轮 prompt 收尾时自动发 agent_end(与真 pi 对齐;默认关,老用例不受影响)。 */
	autoAgentEnd = false;
	/** autoAgentEnd 发出的 willRetry(pi 内层还要重试时为 true)。 */
	willRetry = false;
	/** getContextUsage 的桩(真 pi 空会话返回 {tokens:0,…} 而不是 undefined)。 */
	usageCtx: { tokens: number | null; contextWindow: number } | undefined = { tokens: 0, contextWindow: 200_000 };
	/** compact 的桩:抛这个错(模拟 "Nothing to compact")。 */
	compactThrows: string | undefined;
	/** compact 成功时的副作用(测试用来把 usageCtx 改小)。 */
	compactHook: ((s: FakeSession) => void) | undefined;
	compacts = 0;
	private subs = new Set<(e: SessionEvent) => void>();
	private lastText: string | undefined;
	private abortWaiters: Array<() => void> = [];
	private script: Script;

	constructor(script: Script) {
		this.script = script;
	}

	/** 允许测试直接喂 pi 事件,不需要真实模型请求。 */
	emit(e: SessionEvent): void {
		for (const s of [...this.subs]) s(e);
	}

	emitUser(text: string): void {
		this.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
	}

	/** 假的工具执行事件(字段名按 pi 的 toolName;宿主侧另有 name 兜底)。 */
	emitToolStart(name: string): void {
		this.emit({ type: "tool_execution_start", toolName: name } as SessionEvent);
	}

	emitToolEnd(name: string): void {
		this.emit({ type: "tool_execution_end", toolName: name } as SessionEvent);
	}

	/** 一轮推理的收尾信号(真 pi 的判据:willRetry=false 才是"这轮真的失败了")。 */
	emitAgentEnd(willRetry: boolean): void {
		this.emit({ type: "agent_end", willRetry });
	}

	/** 内层退避的现场:一次 429 在会话里是多条 error 消息,只有最后一条后面跟 willRetry=false。 */
	emitAssistantError(message: string): void {
		this.emit({ type: "message_end", message: { role: "assistant", usage: this.usage, stopReason: "error", errorMessage: message } });
	}

	async prompt(text: string): Promise<void> {
		this.aborted = false; // 与真 pi 对齐:abort 只撕当前 turn,新 prompt 是新 turn
		this.prompts.push(text);
		this.emitUser(text);
		const out = await this.script(text, this);
		if (this.aborted) return;
		this.lastText = out;
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				usage: this.usage,
				stopReason: this.stopReason,
				errorMessage: this.errorMessage,
			},
		});
		if (this.autoAgentEnd) this.emitAgentEnd(this.willRetry);
	}

	contextUsage(): { tokens: number | null; contextWindow: number } | undefined {
		return this.usageCtx;
	}

	async compact(): Promise<void> {
		this.compacts++;
		if (this.compactThrows) throw new Error(this.compactThrows);
		this.compactHook?.(this);
	}

	async steer(text: string): Promise<void> {
		this.steers.push(text);
		if (this.steerDelivers) this.emitUser(text);
	}

	abort(): void {
		this.aborted = true;
		for (const w of this.abortWaiters) w();
		this.abortWaiters = [];
	}

	/** script 里 await 这个来模拟"一直干活直到被 stop"。 */
	untilAborted(): Promise<string> {
		return new Promise((r) => {
			if (this.aborted) r("(aborted)");
			else this.abortWaiters.push(() => r("(aborted)"));
		});
	}

	dispose(): void {
		this.disposed = true;
	}

	subscribe(cb: (e: SessionEvent) => void): () => void {
		this.subs.add(cb);
		return () => this.subs.delete(cb);
	}

	getLastAssistantText(): string | undefined {
		return this.lastText;
	}
}

export class FakeFactory implements SessionFactory {
	created: FakeSession[] = [];
	/** create()/open() 收到的 spec(形状约束的 depth 走这条路)。 */
	specs: SpawnSpec[] = [];
	/** create() 依次消费;耗尽用 defaultScript。 */
	scripts: Script[] = [];
	/** open() 按 sid 查;查不到落回 scripts/defaultScript。 */
	openScripts = new Map<string, Script>();
	defaultScript: Script = () => "ok";
	failCreate: string | undefined;
	failOpen: string | undefined;
	/** 卡住 open,用来验证唤醒锁与宿主退出竞态。 */
	beforeOpen?: () => Promise<void>;
	/** open() 收到的 presence 快照(换模型时宿主用新 model 重开同一会话)。 */
	opens: Array<{ sid: string; model?: string; hadFile?: boolean; thinking?: string }> = [];
	private n = 0;

	async create(spec: SpawnSpec, sid?: string): Promise<{ handle: SessionHandle; sid: string; sessionFile?: string }> {
		this.specs.push(spec);
		if (this.failCreate) throw new Error(this.failCreate);
		const s = new FakeSession(this.scripts.shift() ?? this.defaultScript);
		this.created.push(s);
		const id = sid ?? `fake${(++this.n).toString().padStart(4, "0")}sid${Math.random().toString(36).slice(2, 8)}`;
		return { handle: s, sid: id, sessionFile: `/fake/${id}.jsonl` };
	}

	async open(pres: Presence): Promise<{ handle: SessionHandle; sessionFile?: string }> {
		this.opens.push({ sid: pres.sid, model: pres.model, hadFile: Boolean(pres.session_file), thinking: pres.thinking_level });
		if (this.failOpen) throw new Error(this.failOpen);
		await this.beforeOpen?.();
		const s = new FakeSession(this.openScripts.get(pres.sid) ?? this.scripts.shift() ?? this.defaultScript);
		this.created.push(s);
		// 与真工厂一致:presence 没有落盘文件时以 create({id: sid}) 新建, 路径回传给宿主回写。
		return { handle: s, sessionFile: pres.session_file ?? `/fake/${pres.sid}.jsonl` };
	}
}

// ---------------------------------------------------------------------------

let fx = 0;

export function humanPresence(p: MeshPaths, alias: string, opts: { live?: boolean; cwd?: string } = {}): Presence {
	const pres: Presence = {
		sid: `human${(++fx).toString().padStart(4, "0")}${Math.random().toString(36).slice(2, 8)}`,
		alias,
		kind: "human",
		cwd: opts.cwd ?? "/tmp",
		born_at: Date.now(),
		host_pid: opts.live ? process.pid : undefined,
		heartbeat_at: opts.live ? Date.now() : 0,
		stats: { tokens: 0, turns: 0 },
	};
	writePresence(p, pres);
	return pres;
}

export function agentPresence(
	p: MeshPaths,
	alias: string,
	opts: { startedBy?: string; live?: boolean; tools?: string[]; sessionFile?: string; cwd?: string } = {},
): Presence {
	const pres: Presence = {
		sid: `agent${(++fx).toString().padStart(4, "0")}${Math.random().toString(36).slice(2, 8)}`,
		alias,
		kind: "agent",
		cwd: opts.cwd ?? "/tmp",
		tools: opts.tools ?? ["read"],
		session_file: opts.sessionFile ?? `/fake/${alias}.jsonl`,
		started_by: opts.startedBy,
		born_at: Date.now(),
		host_pid: opts.live ? process.pid : undefined,
		heartbeat_at: opts.live ? Date.now() : 0,
		stats: { tokens: 0, turns: 0 },
	};
	writePresence(p, pres);
	return pres;
}

// ---------------------------------------------------------------------------
// 老测试的派发糖:kernel 现在自己构造 presence + 出生信再交给 host.spawn(pres, birth)。
// ---------------------------------------------------------------------------

export async function legacySpawn(
	host: Host,
	spec: { alias: string; cwd: string; model?: string; tools: string[]; startedBy: string; startedByAlias: string; body: string; depth?: number; extra?: Partial<Presence> },
): Promise<{ sid: string } | { error: string }> {
	const now = Date.now();
	const pres: Presence = {
		sid: uuidv7(),
		alias: spec.alias,
		kind: "agent",
		cwd: spec.cwd,
		model: spec.model,
		tools: spec.tools,
		depth: spec.depth ?? 1,
		started_by: spec.startedBy,
		born_at: now,
		heartbeat_at: now,
		stats: { tokens: 0, turns: 0 },
		task_started_at: now,
		...(spec.extra ?? {}),
	};
	return host.spawn(pres, { id: newMessageId(), from: spec.startedBy, from_alias: spec.startedByAlias, to: pres.sid, at: now, kind: "message", body: spec.body });
}

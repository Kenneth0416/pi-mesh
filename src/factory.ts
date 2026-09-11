/**
 * factory —— 真 SessionFactory:每个 agent 会话 = 一个真 pi 会话。
 *
 * 从 index.ts 搬出来的原因:**TUI 与 mesh-hostd 共用同一份**。
 * 谁跑循环谁就构造它;区别只在 registry/kernel 从哪来(注入两个 getter)。
 *
 * 这里 import 的是 `@earendil-works/pi-coding-agent`(纯 SDK,m0 spike 实证在
 * 裸 node 进程里可用),不 import 任何 pi-tui —— src/ 的纪律照旧。
 */

import * as fs from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionFactory, SessionHandle, SpawnSpec } from "./host.ts";
import { verbsForDepth } from "./kernel.ts";
import type { Kernel } from "./kernel.ts";
import { depthOf, planSessionOpen } from "./registry.ts";
import type { ToolDef } from "./tools.ts";
import { toKernelArgs } from "./tools.ts";
import { MAX_DEPTH, MESH_SESSIONS_DIR, isToolError, normalizeTools } from "./types.ts";
import type { MeshPaths, Presence } from "./types.ts";

export type RegistryLike = ModelRegistry;

// ---------------------------------------------------------------------------
// 模型解析(fail-fast:精确 provider/id 或全局唯一裸 id,不做模糊匹配)
// ---------------------------------------------------------------------------

export function findModel(registry: RegistryLike, ref: string): Model<Api> | undefined {
	const i = ref.indexOf("/");
	if (i <= 0) return undefined;
	return registry.find(ref.slice(0, i), ref.slice(i + 1));
}

export function makeResolveModel(getRegistry: () => RegistryLike | undefined) {
	return (ref: string): { model: string } | { error: string } => {
		const registry = getRegistry();
		if (!registry) return { model: ref };
		let models: Model<Api>[];
		try {
			models = registry.getAvailable();
			if (models.length === 0) models = registry.getAll();
		} catch {
			return { model: ref };
		}
		const lower = ref.trim().toLowerCase();
		const canonical = models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
		if (canonical) return { model: `${canonical.provider}/${canonical.id}` };
		if (!ref.includes("/")) {
			const byId = models.filter((m) => m.id.toLowerCase() === lower);
			if (byId.length === 1) return { model: `${byId[0].provider}/${byId[0].id}` };
			if (byId.length > 1) return { error: `"${ref}" 在多个 provider 下存在, 请写 provider/id` };
		}
		const refs = models.slice(0, 12).map((m) => `${m.provider}/${m.id}`);
		return { error: `未知模型 "${ref}"。可用: ${refs.join(", ")}${models.length > refs.length ? " …" : ""}` };
	};
}

// ---------------------------------------------------------------------------
// SessionFactory
// ---------------------------------------------------------------------------

export interface FactoryDeps {
	paths: MeshPaths;
	/** 模型登记处(TUI 里是 ctx.modelRegistry;hostd 里是自己 new 的那个)。 */
	registry: () => RegistryLike | undefined;
	/** 子会话的系统提示词补丁(prompts/agent-facts.md)。 */
	agentFacts: string;
	/** 内核(子会话的 customTools 走它;构造时可能还没有,故用 getter)。 */
	kernel: () => Kernel | undefined;
	toolDefs: ToolDef[];
	/** agent 会话文件目录(缺省 ~/.pi/agent/mesh-sessions)。 */
	sessionsDir?: string;
}

/** 出生与唤醒共用同一能力面:原生工具与自定义工具都排序去重。 */
export function planFactoryTools(spec: SpawnSpec, defs: ToolDef[]) {
	const allowed = new Set(verbsForDepth(spec.depth ?? MAX_DEPTH));
	const byVerb = new Map(defs.filter((d) => allowed.has(d.verb)).map((d) => [d.verb, d]));
	const childVerbs = normalizeTools([...byVerb.keys()]).map((verb) => byVerb.get(verb as ToolDef["verb"])!);
	return { childVerbs, tools: normalizeTools([...spec.tools, ...childVerbs.map((d) => d.verb)]) };
}

export function makeFactory(deps: FactoryDeps): SessionFactory {
	const sessionsDir = deps.sessionsDir ?? MESH_SESSIONS_DIR;
	const agentDir = getAgentDir();
	const loaders = new Map<string, Promise<DefaultResourceLoader>>();
	const settings = new Map<string, SettingsManager>();
	fs.mkdirSync(sessionsDir, { recursive: true });

	const getSettings = (cwd: string): SettingsManager => {
		let s = settings.get(cwd);
		if (!s) {
			s = SettingsManager.create(cwd, agentDir);
			settings.set(cwd, s);
		}
		return s;
	};
	const getLoader = (cwd: string): Promise<DefaultResourceLoader> => {
		let p = loaders.get(cwd);
		if (!p) {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: getSettings(cwd),
				noExtensions: true, // 防递归加载本扩展;内核动词走 customTools
				appendSystemPrompt: [deps.agentFacts],
			});
			p = loader.reload().then(() => loader);
			loaders.set(cwd, p);
		}
		return p;
	};

	/**
	 * 打开既有会话。**文件不存在时绝不能走 SessionManager.open()** ——
	 * m0 spike 实证:它会静默换一个新 sid(文件名保留旧 sid,内容却是新的),
	 * 于是 registry/mailbox/别名全部对不上号。正确做法是以指定 id 新建
	 * (`create()` 本就不建文件,首条 assistant 消息才落盘,所以不会 EEXIST)。
	 * TUI 侧 spawn 出来的 presence 压根没有 session_file —— 走的就是这条路。
	 */
	const openOrCreate = (pres: Presence): SessionManager => {
		const plan = planSessionOpen(pres);
		return plan.action === "open"
			? SessionManager.open(plan.file, sessionsDir)
			: SessionManager.create(plan.cwd, sessionsDir, plan.id ? { id: plan.id } : undefined);
	};

	const start = async (sm: SessionManager, spec: SpawnSpec) => {
		const registry = deps.registry();
		const model = spec.model && registry ? findModel(registry, spec.model) : undefined;
		const sid = sm.getSessionId();
		// 形状约束(§5)的能力面:该子会话自己的深度决定它有没有 agent 动词
		// —— 不给工具比拒绝更省。深度不明按封顶处理(保守:不再扇出)。
		const { childVerbs, tools } = planFactoryTools(spec, deps.toolDefs);
		const customTools = childVerbs.map((d) => ({
			name: d.verb,
			label: d.label,
			description: d.description,
			parameters: d.params,
			execute: async (_id: string, params: Record<string, unknown>) => {
				const k = deps.kernel();
				if (!k) return { content: [{ type: "text", text: "mesh 内核未就绪" }], isError: true, details: undefined };
				const r = await k.execute(d.verb, sid, toKernelArgs(d.verb, params ?? {}));
				return { content: [{ type: "text", text: JSON.stringify(r, null, 1) }], isError: isToolError(r), details: r as never };
			},
		}));
		const { session } = await createAgentSession({
			...(model ? { model } : {}),
			// §17 推理等级:派发规则算好传下来;缺省交给 pi settings(SDK 会按模型能力钳位)。
			...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel as never } : {}),
			cwd: spec.cwd,
			tools,
			customTools: customTools as never,
			resourceLoader: await getLoader(spec.cwd),
			settingsManager: getSettings(spec.cwd),
			sessionManager: sm,
		});
		return { session, sid, sessionFile: sm.getSessionFile() };
	};

	const toHandle = (session: AgentSession): SessionHandle => ({
		prompt: (text: string) => session.prompt(text, { expandPromptTemplates: false }),
		steer: (text: string) => session.steer(text),
		abort: () => void session.abort(),
		dispose: () => session.dispose(),
		subscribe: (cb) => session.subscribe(cb as never),
		getLastAssistantText: () => session.getLastAssistantText(),
	});

	return {
		async create(spec, wantSid) {
			const sm = SessionManager.create(spec.cwd, sessionsDir, wantSid ? { id: wantSid } : undefined);
			const { session, sid, sessionFile } = await start(sm, spec);
			return { handle: toHandle(session), sid, sessionFile };
		},
		async open(pres: Presence) {
			const sm = openOrCreate(pres);
			// 唤醒时深度用出生时记的那一层;老记录缺字段就从谱系现算。
			const { session, sessionFile } = await start(sm, {
				cwd: pres.cwd,
				model: pres.model,
				...(pres.thinking_level ? { thinkingLevel: pres.thinking_level } : {}),
				tools: pres.tools ?? [],
				depth: pres.depth ?? depthOf(deps.paths, pres),
			});
			return { handle: toHandle(session), sessionFile };
		},
	};
}

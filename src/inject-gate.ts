/**
 * inject-gate —— own mailbox 注入的节奏闸门(§3,纯函数零 IO)。
 *
 * 经济律推论:讣告是事实,但事实到达的**节奏**是 harness 可控的物理。
 * 人等的是回话,不是通报 ——
 * - 箱里有**紧急**的信(人说的话、blocker/question、冻结令)→ 立即注入(整批搭车,含攒着的 notice 与汇报);
 * - 只有 notice / 普通汇报(report/commit/notify)→ 静默 NOTICE_QUIET_MS 且距首封 ≥NOTICE_HOLD_MIN_MS 才注入;
 *   距首封 NOTICE_HOLD_MAX_MS 强制注入(再热闹也不能一直攒)。
 *
 * §13 #2 之前所有 message 都算"真话"立即注入 —— 10 个工人的进度汇报就把调度者每个推理边界都撕一次。
 * 现在"是不是真话"由 `urgent` 决定(调用方按 intent/发件人算好传进来);为兼容老调用,
 * `urgent` 缺省时 message 仍按紧急处理。
 *
 * 调用方只负责:按 waitMs 重新排一次表、把返回的 state 存回去、注入后清零。
 */

import type { MessageKind } from "./types.ts";
import { NOTICE_HOLD_MAX_MS, NOTICE_HOLD_MIN_MS, NOTICE_QUIET_MS } from "./types.ts";

/** 持有状态(跨次调用):首封被持有的时刻 + 最近一封到达的时刻。 */
export interface HoldState {
	firstHeldAt?: number;
	lastArrivalAt?: number;
}

export const NO_HOLD: HoldState = {};

export interface GateLetter {
	kind: MessageKind;
	/** 投递时刻(信封 at;隔夜信天然"持有已久",一上线就整批注入)。 */
	at: number;
	/** 紧急(立即注入):人说的话 / blocker / question / 冻结令。缺省:message 视为紧急(兼容),notice 不紧急。 */
	urgent?: boolean;
}

export type GateResult = { action: "inject"; state: HoldState } | { action: "wait"; waitMs: number; state: HoldState };

export interface GateInput {
	now: number;
	/** 可投递的信(control 由调用方先行清除,不进闸门)。 */
	letters: GateLetter[];
	state: HoldState;
}

export function isUrgentLetter(l: GateLetter): boolean {
	if (l.urgent !== undefined) return l.urgent;
	return l.kind === "message";
}

export function planInjectGate(input: GateInput): GateResult {
	const { now, letters, state } = input;
	if (letters.length === 0) return { action: "inject", state: { ...NO_HOLD } };
	// 有一句真正需要回应的话 → 整批立即注入(攒着的讣告与汇报搭车)。
	if (letters.some(isUrgentLetter)) return { action: "inject", state: { ...NO_HOLD } };

	const ats = letters.map((l) => Math.min(l.at, now));
	const firstHeldAt = Math.min(state.firstHeldAt ?? now, ...ats);
	const lastArrivalAt = Math.max(state.lastArrivalAt ?? 0, ...ats);
	const next: HoldState = { firstHeldAt, lastArrivalAt };

	const heldFor = now - firstHeldAt;
	const quietFor = now - lastArrivalAt;
	if (heldFor >= NOTICE_HOLD_MAX_MS) return { action: "inject", state: { ...NO_HOLD } };
	if (quietFor >= NOTICE_QUIET_MS && heldFor >= NOTICE_HOLD_MIN_MS) return { action: "inject", state: { ...NO_HOLD } };

	// 下一个可能翻盘的时刻:min(静默与最短持有都满足的那一刻, 强制注入点)。
	const untilQuiet = NOTICE_QUIET_MS - quietFor;
	const untilMin = NOTICE_HOLD_MIN_MS - heldFor;
	const untilMax = NOTICE_HOLD_MAX_MS - heldFor;
	const waitMs = Math.max(1, Math.min(Math.max(untilQuiet, untilMin), untilMax));
	return { action: "wait", waitMs, state: next };
}

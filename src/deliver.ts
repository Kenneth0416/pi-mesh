/**
 * deliver —— 投递律的路由决策(纯函数,零 IO)。
 *
 * | 收件人状态                 | 行为                                   |
 * |--------------------------|---------------------------------------|
 * | 自己 / 本进程寄宿          | steer:下一推理边界注入                   |
 * | 在别处存活                 | mailbox:对方 watcher 注入               |
 * | dormant human            | mailbox,绝不唤醒                        |
 * | dormant agent + notify   | mailbox,不唤醒(知悉不是工作)             |
 * | dormant agent,并发已满    | defer(留箱,槽位释放后 sweep 补投)        |
 * | dormant agent            | wake(本进程是宿主)/ nudge(通知 hostd)   |
 */

import type { MessageIntent, Presence } from "./types.ts";
import { isWorkIntent } from "./types.ts";

export type Route = { action: "steer_local" } | { action: "mailbox"; note?: string } | { action: "wake" } | { action: "nudge" } | { action: "defer"; note: string };

export interface RouteInput {
	target: Presence;
	hostedHere: boolean;
	live: boolean;
	running: number;
	cap: number;
	/** 本进程能寄宿吗(hostd=true;TUI=false,只留信+确保 hostd 活着)。 */
	canHost: boolean;
	intent?: MessageIntent;
}

export function route(input: RouteInput): Route {
	const { target, hostedHere, live, running, cap } = input;
	if (hostedHere) return { action: "steer_local" };
	if (live) return { action: "mailbox" };
	if (target.kind === "human") return { action: "mailbox", note: "human 会话只留信不打扰; 对方下次打开会话时送达" };
	if (!isWorkIntent(input.intent)) return { action: "mailbox", note: "notify 只留信不唤醒(它已收工, 下次因别的事被唤醒时一并看到)" };
	if (running >= cap) return { action: "defer", note: `并发已满(${running}/${cap}), 消息滞留邮箱, 槽位释放后自动补投` };
	return input.canHost ? { action: "wake" } : { action: "nudge" };
}

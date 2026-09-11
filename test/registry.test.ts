import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { tmpMesh, humanPresence, agentPresence } from "./helpers.ts";
import {
	allPresence,
	autoAlias,
	claimAlias,
	depthOf,
	humanRootOf,
	inCallerTree,
	inSessionList,
	isLive,
	patchPresence,
	planSessionOpen,
	readPresence,
	registerSelf,
	rootOf,
	resolveAlias,
	resolveTarget,
	runningCount,
	sameProject,
	sessionState,
	writePresence,
} from "../src/registry.ts";
import { newMessageId, pendingCount, sendMail } from "../src/mailbox.ts";
import { SID_SHORT_MIN, sid8, uuidv7 } from "../src/types.ts";

const DEAD_PID = 999_999_999;

test("sid8(§12): 短 id = 去连字符后的末 8 位", () => {
	assert.equal(sid8("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"), "2e3f4a5b");
	assert.equal(sid8("abcdefgh"), "abcdefgh");
	assert.equal(sid8("abc"), "abc"); // 短于 8 位原样(测试假 sid 也要能显示)
});

test("presence 原子读写与 patch", () => {
	const p = tmpMesh();
	const pres = humanPresence(p, "ken", { live: true });
	assert.deepEqual(readPresence(p, pres.sid)?.alias, "ken");
	patchPresence(p, pres.sid, { last_note: "hi" });
	assert.equal(readPresence(p, pres.sid)?.last_note, "hi");
	assert.equal(readPresence(p, pres.sid)?.alias, "ken"); // 未 patch 字段保留
	assert.equal(allPresence(p).length, 1);
});

test("存活派生: pid + 心跳双条件; human=attached, agent=running", () => {
	const p = tmpMesh();
	const live = humanPresence(p, "a", { live: true });
	const dead = agentPresence(p, "b", { live: false });
	const now = Date.now();
	assert.equal(isLive(readPresence(p, live.sid)!, now), true);
	assert.equal(sessionState(readPresence(p, live.sid)!, now), "attached");
	assert.equal(sessionState(readPresence(p, dead.sid)!, now), "dormant");
	// pid 活但心跳过期 → dormant
	const stale = agentPresence(p, "c", { live: true });
	patchPresence(p, stale.sid, { heartbeat_at: now - 60_000 });
	assert.equal(sessionState(readPresence(p, stale.sid)!, now), "dormant");
	const running = agentPresence(p, "d", { live: true });
	assert.equal(sessionState(readPresence(p, running.sid)!, now), "running");
});

test("alias: wx 唯一性 fail-fast; autoAlias 逐个后缀; 死者名字可接", () => {
	const p = tmpMesh();
	assert.equal(claimAlias(p, "x", "sid1"), true);
	assert.equal(claimAlias(p, "x", "sid2"), false);
	assert.equal(resolveAlias(p, "x"), "sid1");
	// autoAlias: x 被活人占 → x-2
	const got = autoAlias(p, "x", "sid3", () => false);
	assert.equal(got, "x-2");
	// 死者手里接名字
	const stolen = autoAlias(p, "x", "sid4", (holder) => holder === "sid1");
	assert.equal(stolen, "x");
	assert.equal(resolveAlias(p, "x"), "sid4");
});

test("resolveTarget: alias 精确 > sid 精确 > 唯一短 id(末 8 位, 兼容前缀); 歧义/未知报错列候选", () => {
	const p = tmpMesh();
	const a = agentPresence(p, "worker-1");
	const b = agentPresence(p, "worker-2");
	claimAlias(p, "worker-1", a.sid);
	claimAlias(p, "worker-2", b.sid);
	assert.deepEqual(resolveTarget(p, "worker-1", 6), { sid: a.sid });
	assert.deepEqual(resolveTarget(p, a.sid, 6), { sid: a.sid });
	// 短 id = sid8(末 8 位):sessions/面板显示的就是它,原样粘回来要能命中
	assert.deepEqual(resolveTarget(p, sid8(a.sid), 6), { sid: a.sid });
	assert.deepEqual(resolveTarget(p, sid8(b.sid), 6), { sid: b.sid });
	// 兼容旧的前缀寻址(模型可能记住了前 8 位)
	const uniq = resolveTarget(p, a.sid.slice(0, 12), 6);
	assert.deepEqual(uniq, { sid: a.sid });
	const unknown = resolveTarget(p, "nobody", 6);
	assert.ok("error" in unknown && unknown.error.includes("worker-1"));
	// 太短的不做短 id 匹配
	const short = resolveTarget(p, "agen", 6);
	assert.ok("error" in short);
});

test("resolveTarget(§12): 同一小时出生的两个 uuidv7 —— 前缀全撞, 末 8 位可区分; 歧义报错列候选", () => {
	const p = tmpMesh();
	const now = Date.parse("2026-09-02T04:00:00Z");
	const s1 = uuidv7(now);
	const s2 = uuidv7(now + 900); // 同一秒内出生:前 8 位(毫秒时间戳)几乎必然相同
	for (const [sid, alias] of [
		[s1, "nicole-a"],
		[s2, "nicole2-a"],
	] as const) {
		writePresence(p, { sid, alias, kind: "agent", cwd: "/tmp", born_at: now, heartbeat_at: now, stats: { tokens: 0, turns: 0 } });
	}
	assert.equal(sid8(s1).length, 8);
	assert.notEqual(sid8(s1), sid8(s2)); // 末 8 位落在随机段
	assert.deepEqual(resolveTarget(p, sid8(s1), 6), { sid: s1 });
	assert.deepEqual(resolveTarget(p, sid8(s2), 6), { sid: s2 });
	// 共同前缀(时间戳段)= 歧义, 报错并列出候选的短 id
	const common = s1.replace(/-/g, "").slice(0, 8);
	if (s2.replace(/-/g, "").startsWith(common)) {
		const amb = resolveTarget(p, common, 6);
		assert.ok("error" in amb, "同小时前缀应当歧义");
		assert.ok(amb.error.includes(sid8(s1)) && amb.error.includes(sid8(s2)), amb.error);
	}
});

test("sameProject: 向下包含且不对称(相等/子/父/兄弟/伞形)", () => {
	assert.equal(sameProject("/a/b", "/a/b"), true); // 相等
	assert.equal(sameProject("/a/b", "/a/b/c"), true); // 子树在视野内
	assert.equal(sameProject("/a/b/c", "/a/b"), false); // 上级地盘不归你看(不对称)
	assert.equal(sameProject("/a/b", "/a/c"), false); // 兄弟互不可见
	assert.equal(sameProject("/", "/a/b"), true); // 一般目录仍向下包含("/" 不是 home)
	assert.equal(sameProject("/a/b", "/a/bb"), false); // 前缀不等于子树
	assert.equal(sameProject("/a/b/", "/a/b/c"), true); // 尾斜杠规范化
	assert.equal(sameProject("/a/b", "/a/b/../b/c"), true); // path.resolve 规范化
	// home 例外:容器不是项目 —— ~ 只看 cwd 恰为 ~ 的, 不伞形吞并项目
	const home = os.homedir();
	assert.equal(sameProject(home, home), true);
	assert.equal(sameProject(home, path.join(home, "Documents", "proj")), false);
	assert.equal(sameProject(path.join(home, "Documents", "proj"), path.join(home, "Documents", "proj", "sub")), true); // 真项目不受影响
});

test("inCallerTree: 沿 started_by 上溯到 viewer, 过深或断链为 false", () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken");
	const boss = agentPresence(p, "boss", { startedBy: ken.sid });
	const leaf = agentPresence(p, "leaf", { startedBy: boss.sid });
	const stray = agentPresence(p, "stray");
	assert.equal(inCallerTree(p, ken.sid, ken), true);
	assert.equal(inCallerTree(p, ken.sid, boss), true);
	assert.equal(inCallerTree(p, ken.sid, leaf), true);
	assert.equal(inCallerTree(p, boss.sid, leaf), true);
	assert.equal(inCallerTree(p, ken.sid, stray), false);
	assert.equal(inCallerTree(p, leaf.sid, boss), false);
});

test("inSessionList(§12): 只有自己 + 自己派出的子树; 同目录别的 human 及其 agent 一律不可见", () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true, cwd: "/tmp" });
	// 同目录的另一个方向(实测里的 Nicole-2):它和它的工人都不该进 ken 的列表
	const peer = humanPresence(p, "peer", { live: true, cwd: "/tmp" });
	const peersWorker = agentPresence(p, "peer-a", { startedBy: peer.sid, live: true, cwd: "/tmp" });
	const bob = humanPresence(p, "bob", { live: true, cwd: "/elsewhere" });
	const mine = agentPresence(p, "mine", { startedBy: ken.sid, cwd: "/tmp/sub" });
	const cloned = agentPresence(p, "cloned", { startedBy: ken.sid, cwd: "/elsewhere/clone" }); // cwd 在外仍是我的
	const grand = agentPresence(p, "grand", { startedBy: mine.sid, cwd: "/elsewhere" }); // 子代的子代
	const stray = agentPresence(p, "stray", { live: true, cwd: "/tmp" }); // 同目录的孤儿:没有血缘就不在列表
	const yesterday = humanPresence(p, "yesterday", { live: false, cwd: "/tmp" });
	assert.equal(inSessionList(p, ken, ken), true);
	assert.equal(inSessionList(p, ken, mine), true);
	assert.equal(inSessionList(p, ken, cloned), true);
	assert.equal(inSessionList(p, ken, grand), true);
	assert.equal(inSessionList(p, ken, peer), false); // 同目录的人会话不是你的舰队成员
	assert.equal(inSessionList(p, ken, peersWorker), false); // 它的工人更不是
	assert.equal(inSessionList(p, ken, bob), false);
	assert.equal(inSessionList(p, ken, stray), false);
	assert.equal(inSessionList(p, ken, yesterday), false); // dormant human 一律不进
	// agent viewer 同样只见自己的子树:创建者链不在列表里(要写信用 creator 保留地址)
	assert.equal(inSessionList(p, mine, grand), true);
	assert.equal(inSessionList(p, mine, mine), true);
	assert.equal(inSessionList(p, mine, ken), false);
	assert.equal(inSessionList(p, mine, cloned), false); // 兄弟不在自己的子树里
	// 两个 human 互不可见是对称的
	assert.equal(inSessionList(p, peer, mine), false);
	assert.equal(inSessionList(p, peer, peersWorker), true);
});

test("registerSelf: kind 出生即定 —— pi --session 接管 agent 会话不会被写成 human", () => {
	const p = tmpMesh();
	const boss = humanPresence(p, "boss");
	const a = agentPresence(p, "worker", { startedBy: boss.sid, tools: ["read"] });
	claimAlias(p, "worker", a.sid);
	patchPresence(p, a.sid, { stats: { tokens: 10, turns: 2 } });

	const got = registerSelf(p, { sid: a.sid, cwd: "/tmp/proj", pid: process.pid, sessionFile: "/fake/worker.jsonl" });
	assert.equal(got.kind, "agent"); // 不是 human —— 接管过也还能被自动唤醒
	assert.equal(got.alias, "worker"); // 名字沿用
	assert.deepEqual(got.tools, ["read"]); // 护栏律的账本不丢
	assert.equal(got.started_by, boss.sid);
	assert.equal(got.stats.tokens, 10);
	assert.equal(got.cwd, "/tmp/proj"); // cwd 跟随本次打开
	assert.equal(sessionState(readPresence(p, a.sid)!, Date.now()), "running"); // attended 与否由心跳派生
	// 全新会话默认 human, 别名取 cwd basename
	const fresh = registerSelf(p, { sid: "brandnewsid0001", cwd: "/tmp/newproj", pid: process.pid });
	assert.equal(fresh.kind, "human");
	assert.equal(fresh.alias, "newproj");
});

test("writePresence 原子性: 损坏行被 allPresence 跳过", () => {
	const p = tmpMesh();
	humanPresence(p, "ok");
	fs.writeFileSync(`${p.registry}/broken.json`, "{not json");
	assert.equal(allPresence(p).length, 1);
	writePresence(p, humanPresence(p, "ok2"));
	assert.equal(allPresence(p).length >= 2, true);
});

test("depthOf: human=0, 沿 started_by 每跳 +1; 链断按到达处计", () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const planner = agentPresence(p, "planner", { startedBy: ken.sid });
	const worker = agentPresence(p, "worker", { startedBy: planner.sid });
	const deeper = agentPresence(p, "deeper", { startedBy: worker.sid });
	assert.equal(depthOf(p, ken), 0);
	assert.equal(depthOf(p, planner), 1);
	assert.equal(depthOf(p, worker), 2);
	assert.equal(depthOf(p, deeper), 3);
	// 孤儿(无 started_by)与断链(创建者 presence 已清)都按到达处计
	const orphan = agentPresence(p, "orphan");
	assert.equal(depthOf(p, orphan), 1);
	const lost = agentPresence(p, "lost", { startedBy: "gone-sid" });
	assert.equal(depthOf(p, lost), 1);
	// 成环也不会转圈:上溯有跳数上限
	const a = agentPresence(p, "cyc-a");
	const b = agentPresence(p, "cyc-b", { startedBy: a.sid });
	patchPresence(p, a.sid, { started_by: b.sid });
	assert.ok(depthOf(p, readPresence(p, a.sid)!) <= 16);
});

test("humanRootOf / rootOf: 树内计数的键(链上无人则取最顶端祖先)", () => {
	const p = tmpMesh();
	const ken = humanPresence(p, "ken", { live: true });
	const planner = agentPresence(p, "planner", { startedBy: ken.sid });
	const worker = agentPresence(p, "worker", { startedBy: planner.sid });
	assert.equal(humanRootOf(p, ken), ken.sid);
	assert.equal(humanRootOf(p, planner), ken.sid);
	assert.equal(humanRootOf(p, worker), ken.sid);
	assert.equal(rootOf(p, worker), ken.sid);
	assert.equal(rootOf(p, ken), ken.sid);
	// 无人链:根是最顶端可达祖先(整棵孤儿树共用同一个键)
	const top = agentPresence(p, "top");
	const mid = agentPresence(p, "mid", { startedBy: top.sid });
	const leaf = agentPresence(p, "leaf", { startedBy: mid.sid });
	assert.equal(humanRootOf(p, leaf), undefined);
	assert.equal(rootOf(p, leaf), top.sid);
	assert.equal(rootOf(p, mid), top.sid);
});

test("planSessionOpen: 文件在就 open, 不在就以指定 sid create(绝不让 SDK 静默换 sid)", () => {
	const p = tmpMesh();
	const live = agentPresence(p, "has-file", { sessionFile: "/fake/live.jsonl" });
	assert.deepEqual(planSessionOpen(live, () => true), { action: "open", file: "/fake/live.jsonl" });
	// 派出去但第一轮就死的 worker:会话文件从没落过盘 —— open 会静默换 sid, 必须改走 create({id})
	assert.deepEqual(planSessionOpen(live, () => false), { action: "create", cwd: live.cwd, id: live.sid });
	// presence 里根本没有 session_file(常态)
	const born = agentPresence(p, "no-file", { sessionFile: "/fake/x.jsonl" });
	const bare = { ...born, session_file: undefined };
	assert.deepEqual(planSessionOpen(bare, () => true), { action: "create", cwd: bare.cwd, id: bare.sid });
	// sid 不合 SDK 正则(如带斜杠/以 - 开头)就让 SDK 自己生成
	assert.deepEqual(planSessionOpen({ ...bare, sid: "-bad/sid" }, () => false), { action: "create", cwd: bare.cwd });
});

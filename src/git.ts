/**
 * git —— harness 侧的 workspace 观测。只读、不抛、不改工作区:能读就读,读不到返回 undefined。
 * 讣告里的 git 状态是可测物理,不该让模型花 token 自述(自述也不可信)。
 * 所有权与契约不在这里执法:一个 agent 一个 worktree,冲突由 git 在合并时暴露。
 */

import { execFileSync } from "node:child_process";
import type { WorkspaceFacts } from "./types.ts";

const GIT_TIMEOUT_MS = 3_000;

function gitRaw(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

function git(cwd: string, args: string[]): string | undefined {
	return gitRaw(cwd, args)?.trim();
}

export function isGitRepo(cwd: string): boolean {
	return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export function gitHead(cwd: string): string | undefined {
	return git(cwd, ["rev-parse", "HEAD"]) || undefined;
}

/** HEAD / 相对基线的 commits 与改动文件 / 脏文件数。非仓库返回 undefined。 */
export function observeWorkspace(cwd: string, baseOid: string | undefined): WorkspaceFacts | undefined {
	if (!isGitRepo(cwd)) return undefined;
	const facts: WorkspaceFacts = {};
	const head = gitHead(cwd);
	if (head) facts.head = head;
	if (baseOid) facts.base = baseOid;
	// porcelain 每行 "XY path":前两列是状态位, 第一列可能是空格 —— 不能 trim 整段输出再切。
	const status = gitRaw(cwd, ["status", "--porcelain", "--untracked-files=all"]);
	facts.dirty = status ? status.split("\n").filter((l) => l.trim().length > 0).length : 0;
	if (baseOid && head && baseOid !== head) {
		const log = git(cwd, ["log", "--oneline", "--no-decorate", `${baseOid}..HEAD`]);
		if (log) facts.commits = log.split("\n").filter(Boolean).slice(0, 20);
		const names = git(cwd, ["diff", "--name-only", baseOid, "HEAD"]);
		if (names) facts.changed = names.split("\n").filter(Boolean).slice(0, 40);
	}
	return facts;
}

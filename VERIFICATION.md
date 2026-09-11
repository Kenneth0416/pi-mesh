# Verification record

Verification applies to the initial public portfolio snapshot containing this document. The repository commit identifies the exact source; the lockfile pins the tested dependency graph. No upstream-installed extension or account configuration was modified.

## Environment and dependencies

- macOS / Darwin arm64
- Node.js `v24.13.0`; npm `11.6.2`; Git `2.50.1 (Apple Git-155)`
- Published npm `@earendil-works/pi-coding-agent@0.85.1` and `@earendil-works/pi-ai@0.85.1`
- `typebox@1.3.30`, `typescript@5.9.3`, `@types/node@24.13.4`
- Dependencies fetched into this isolated repository, not copied from the live extension's `node_modules`.

## Executed checks

| Command / check | Result |
| --- | --- |
| `npm install --ignore-scripts` | Successful; initial installation added 259 packages; audit reported 0 vulnerabilities. Lifecycle scripts deliberately disabled. |
| `npm test` | Exit 0: TypeScript check followed by all **132 tests passing**, 0 failed/cancelled/skipped/todo. Final run duration: 9336.379167 ms. |
| `npm ci --omit=dev --ignore-scripts` in a fresh temporary copy of package metadata, `src`, `index.ts`, and `prompts` | Exit 0; 258 packages added, audit reported 0 vulnerabilities. |
| `node --input-type=module -e 'await import("./src/factory.ts"); await import("./src/tools.ts"); console.log("production SDK imports OK")'` in that copy | Exit 0: `production SDK imports OK`. No host or model session launched. |
| Published SDK supplied-ID smoke check (below) | Exit 0; `SessionManager.create` preserves the requested session ID. |
| `npm pack --dry-run --json` | Exit 0; inspected file allowlist; no dependency tree, development scratch directory, credentials, or runtime state included. No npm publication performed. |

Full final test output: [npm-test.txt](docs/verification/npm-test.txt). Production install/import output: [production-install.txt](docs/verification/production-install.txt).

The supplied-ID smoke check imported `SessionManager` from the locally installed published SDK, made a temporary directory, called `SessionManager.create(dir, dir, { id: "01900000-0000-7000-8000-000000000001" })`, asserted `getSessionId()` equals that ID, and deleted that temporary directory. It did not create an agent runtime or read credentials.

## Packaging corrections

1. Added explicit `pi.extensions: ["./index.ts"]`, Git installation metadata, Node requirement, dependency declarations, lockfile, and distribution allowlist. The internal `prompts/agent-facts.md` is a worker resource, not a registered user slash-command template.
2. Declared Pi core packages and TypeBox as peers as required by the Pi package documentation. An initial production smoke test found that duplicating these peers in `devDependencies` caused npm's `--omit=dev` install to omit the SDK needed by the detached Node daemon. Removed the duplicate development declarations and reran the production check successfully. npm's automatic peer installation is required; `--legacy-peer-deps`/`--omit=peer` installations are not supported.
3. Corrected the obsolete, cast-suppressed `expandTemplates: false` adapter option to the published typed `expandPromptTemplates: false`. All pre-existing tests were retained without weakening assertions.
4. Updated installation/testing documentation and preserved the original Chinese design notes with a release-status clarification.

No patched Pi installation is needed for the executed checks. This is evidence of published-SDK type/import compatibility and selected contracts, **not** a proof of complete live-runtime compatibility.

## Public-data and security review

Copied only the entry point, source, tests, worker prompt, and relevant documentation; excluded `node_modules`, `_dev`, private state, and account files. Searched repository text for personal absolute paths, credential markers, private-key headers, token patterns, URLs, email-like strings, and authentication references. No embedded live credentials or private owner paths were found in the copied material. The `/Users/me/...` path in an interpreter test is a synthetic fixture; `t@t` is a synthetic Git test identity. Dependency registry URLs are public npm URLs. This was a targeted source/metadata review, not a comprehensive security audit or a guarantee of absence of secrets.

Important boundaries documented in README: full OS access; inherited environment and Pi resources; child sessions do not inherit extension permission gates; local mail/transcripts can hold sensitive data; global individual-session inspection is not tenant isolation; hardcoded home-relative Mesh state; POSIX-oriented daemon launching; cooperative timeboxes rather than hard resource budgets. Existing source had no original-code license grant, so this package remains `UNLICENSED` with attribution in NOTICE.md.

## Not performed / limitations

- No GitHub remote creation, push, or live `pi install` was performed during preparation.
- No model request, provider login, credential access, live daemon launch, terminal restart/recovery drill, or real-model prompt-policy evaluation.
- No Windows/Linux/Bun acceptance run or compatibility sweep across Pi versions.
- No claim of measured speedup, cost reduction, production reliability, or security isolation.
- Existing tests use fake session factories and `--test-force-exit`; successful test completion does not prove absence of leaked handles in live operation.
- Dependency audit's zero findings is registry advisory output, not a security certification. Install scripts were skipped; optional native functionality was not exercised.

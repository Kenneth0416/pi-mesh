# Architecture and logic flowcharts

[README](../README.md) · English (default) | [简体中文](ARCHITECTURE.zh-CN.md)

These diagrams describe the current implementation, not a distributed queue specification. Labels such as `quiescent` and `died` are recorded facts; they are not task acceptance decisions. Mermaid blocks render on GitHub.

## 1. Architecture: two entry points, one kernel

```mermaid
flowchart TB
  U["Human pi session / TUI"] --> I["index.ts: extension tools, presence, own-mail injection"]
  I --> KT["Kernel without Host"]
  KT --> R["registry.ts: identity, aliases, lineage, liveness"]
  KT --> M["mailbox.ts: per-session JSON files"]
  KT --> L["hostd-launch.ts: ensure detached daemon; singleton lock and fingerprint"]
  L --> D["hostd.ts: daemon, mailbox watcher, sweep and heartbeat"]
  D --> H["host.ts: spawn / wake / steer / finalize"]
  D --> KH["Kernel with Host"]
  KH --> H
  KH --> R
  KH --> M
  H --> M
  H --> R
  H --> F["factory.ts: create or open real pi SDK session"]
  F --> A["Agent session: independent context and allowed tools"]
  A --> KH
  F --> S["Persisted pi session files"]
  M --> I
  M --> H
  H --> G["git.ts: observe workspace facts"]
  G --> N["System notices to creator mailbox"]
  N --> M
```

- [index.ts](../index.ts) hosts the human-facing integration, not the worker execution loops. Closing a terminal is therefore not inherently a worker stop.
- [kernel.ts](../src/kernel.ts) implements `agent`, `send`, `sessions`, and `stop` for both entry points. [tools.ts](../src/tools.ts) maps public argument names to kernel arguments.
- [hostd.ts](../src/hostd.ts) owns the [Host](../src/host.ts). Filesystem notifications provide prompt delivery; periodic sweep provides a fallback. Defaults are 15-second sweep/heartbeat and 10-minute daemon idle exit; pending wake-worthy agent mail prevents idle exit.
- [factory.ts](../src/factory.ts) disables recursive extension loading, installs mesh custom tools, and opens an existing session file or creates a session with the intended ID when the file is absent.
- [registry.ts](../src/registry.ts), [mailbox.ts](../src/mailbox.ts), and session files are distinct storage layers. `sessions()` lists the caller's scoped tree; `sessions({id})` can inspect a particular session more broadly. Inspection is not message consumption.

## 2. Delegation: validation, persistence, execution, return

```mermaid
flowchart TD
  A["agent(task, options)"] --> B{"Caller exists; depth, tree-live and global capacity allow spawn?"}
  B -->|No| E["Return structured tool error"]
  B -->|Yes| C{"Nonempty task; tools known and subset of caller; model/thinking, cwd and timebox valid?"}
  C -->|No| E
  C -->|Yes| D{"Claim explicit alias or generate one"}
  D -->|Conflict| E
  D -->|Claimed| P["Build presence: SID, creator, depth, model, tools, task start, optional timebox and git baseline"]
  P --> Q{"Kernel has local Host?"}
  Q -->|Yes| F["Host.spawn: recheck capacity; factory.create"]
  F -->|Failure| X["Release placeholder alias; spawn_failed"]
  F -->|Success| W["Write presence and birth mail; start loop"]
  Q -->|No: TUI| T["Write presence and birth mail; ensureHostd"]
  T --> J{"Daemon available?"}
  J -->|No| K["Leave mail durable; return startup warning"]
  J -->|Yes| V["Daemon sweep finds wake-worthy birth mail"]
  V --> O["Host.wake: batching, capacity and wake-budget checks"]
  O -->|Deferred| V
  O -->|Allowed| Y["Open saved session or create with same SID"]
  Y --> W
  W --> Z["Drive: prompt pending mail; steer arriving mail"]
  W --> R["Rebind alias; agent returns created metadata, not result"]
  K --> R
  J -->|Yes| R
  Z --> N{"Terminal outcome"}
  N -->|Output and no error| NQ["quiescent: last output or related report plus git facts"]
  N -->|Error or no output| ND["died: reason and available output"]
  N -->|Explicit abort| NS["stopped: reason"]
  NQ --> M["System notice to creator; creator reviews evidence"]
  ND --> M
  NS --> M
```

Source: [kernel agent](../src/kernel.ts), [Host spawn/wake/drive/finalize](../src/host.ts), [factory](../src/factory.ts), [limits and defaults](../src/types.ts).

Defaults: depth 2, 12 live agents per tree, no finite global running limit unless configured. Model inherits unless supplied; thinking is explicit, inherited, or `medium` when unknown. Native tools cannot be broadened by delegation; depth also determines whether the child receives the `agent` verb. These are tool-surface checks, **not an OS sandbox**. `cwd` must exist, but mesh does not create or isolate git worktrees: assign a separate worktree to each concurrent writer yourself.

The TUI can return `created` even when daemon startup failed: presence and birth mail already exist. Wake/open failure reports `died` and leaves mail pending. Quiet termination means the agent stopped producing output, not that the requested work was correct or complete. Final notices can clip output; inspect the saved session for the full record.

## 3. Message routing and consume-on-observe

```mermaid
flowchart TD
  S["send(to, message, intent)"] --> V{"Validate caller, target, body, intent and optional timebox authority"}
  V -->|Invalid or foreign human target| E["Structured error; no message sent"]
  V -->|Valid| R["Resolve creator by lineage; otherwise alias or ID"]
  R --> M["Compute route; atomically write message file before acting"]
  M --> H{"Target hosted here?"}
  H -->|Yes| ST["Local mailbox watcher / own-session nudge"]
  H -->|No| L{"Target live elsewhere?"}
  L -->|Yes| MB["Leave mail for recipient watcher"]
  L -->|No| HU{"Human or notify-only send?"}
  HU -->|Yes| MB
  HU -->|No| C{"Global capacity full?"}
  C -->|Yes| DF["Defer; mail remains for sweep"]
  C -->|No| CH{"This kernel has Host?"}
  CH -->|No| EN["Ensure hostd; failure leaves mail pending"]
  CH -->|Yes| WK["Wake: fixed batch window; human work / blocker bypass"]
  EN --> WK
  WK --> BG{"Capacity, wake budget and shutdown checks pass?"}
  BG -->|No| DF
  BG -->|Yes| OP["Open session; drive pending mail"]
  OP --> PL["Plan initial/next prompt batch: priority, aging, budget; defer overflow"]
  PL --> AW["Track message IDs as awaiting observation"]
  ST --> IN["Hosted agent: steer at next reasoning boundary"]
  IN --> AW
  AW --> OBS{"SDK user message_end contains awaiting ID?"}
  OBS -->|Yes| UN["Unlink corresponding file; mark observed in this loop"]
  OBS -->|No or crash| KEEP["Keep file; replay may occur"]
  MB --> TUI["If human TUI active: own-injection gate and planner"]
  TUI --> TG["Urgent immediately; ordinary reports/notices coalesce"]
  TG --> TC["TUI injection and confirmation path; then consume"]
```

Source: [route](../src/deliver.ts), [send](../src/kernel.ts), [mailbox and planner](../src/mailbox.ts), [host event subscription](../src/host.ts), [TUI integration](../index.ts), [injection gate](../src/inject-gate.ts).

- `report` is the default. `blocker` is urgent. `notify` never wakes a dormant agent, but can still reach a running recipient. A dormant human is never started by mail. Agents cannot message another human root (`foreign_human`); this is not a general secrecy boundary between agents.
- Dormant-agent wake batching defaults to a fixed 8 seconds, not an endlessly resetting debounce. Wake-budget throttling applies to agent exchanges; human messages bypass/reset that budget. Sweep also treats `quiescent` and `died` notices as wake-worthy, but not `stopped`, `stalled`, `timebox`, or `workspace` notices.
- The human TUI has a separate injection gate: ordinary messages wait for quiet/minimum hold, with a maximum hold. Hosted running agents instead steer newly arrived mail directly; do not assume the TUI's batching gate applies to them.
- The planner uses count and rendered-character budgets, priority and aging. It retains overflow with envelope summaries; it may drop superseded `stalled`/`timebox` snapshots for the same subject. One oversized message is still eligible. Live hosted steering is not the same bounded batching path.
- **At-least-once, not exactly-once:** the hosted loop deletes normal mail only after observing its ID in a user-message event. A crash between observation and deletion can replay it. This is neither proof of task completion nor an atomic transaction with filesystem/tool side effects. Check message IDs and verify side effects before retrying. Control mail is consumed separately before handling; malformed JSON files are removed when read.

## 4. Recovery, timeboxes, stopping and daemon handover

```mermaid
flowchart TD
  RUN["Hosted agent loop"] --> EV{"Event / condition"}
  EV -->|Provider error| PE{"SDK retries finished and capacity error recognized?"}
  PE -->|No| DIE["Finalize died if terminal error persists"]
  PE -->|Yes| BO["Same-model backoff: 20s, 60s, 120s; retry with side-effect warning"]
  BO --> RES{"Recovered?"}
  RES -->|Yes| RUN
  RES -->|No: exhausted or other error| DIE
  EV -->|Vitals tick| TB{"Declared task timebox elapsed?"}
  TB -->|At deadline| SELF["Self-check notice: stop expanding, checkpoint and report"]
  TB -->|At 1.5 times budget| BOTH["Stronger self-check plus creator timebox notice"]
  TB -->|Not due| IDLE{"No activity past stall threshold?"}
  IDLE -->|Yes| STALL["stalled notice at increasing levels; no automatic abort"]
  SELF --> RUN
  BOTH --> RUN
  STALL --> RUN
  EV -->|stop request| AUTH{"Caller allowed; target is agent?"}
  AUTH -->|No| ERR["Reject"]
  AUTH -->|Yes| ACTIVE{"Target has a running loop?"}
  ACTIVE -->|No| NOOP["Return noop: already dormant"]
  ACTIVE -->|Yes| STOP["Local abort or remote control mail"]
  STOP --> FINAL["stopped notice; session retained, send can resume later"]
  EV -->|Daemon SIGTERM / SIGINT| HAND["Shutdown with handover: letter to worker mailbox; abort old loop; no stopped obituary"]
  HAND --> NEXT["Next daemon sweep / wake reopens saved session"]
  EV -->|Host process disappears| DEAD["Sweep detects dead foreign host PID and unclean presence"]
  DEAD --> ENS{"Rehosting available?"}
  ENS -->|Yes| LETTER["Clear host PID; increment incidents; enqueue handover warning"]
  LETTER --> NEXT
  ENS -->|No| FAIL["died notice; later send can resume"]
  NEXT --> RUN
  DIE --> NOTICE["Creator receives reason; no automatic model switch"]
```

Source: [Host recovery/checkVitals/shutdown/sweep](../src/host.ts), [kernel stop and timebox reset](../src/kernel.ts), [daemon lifecycle](../src/hostd.ts), [launcher](../src/hostd-launch.ts).

Timeboxes are opt-in wall-clock budgets anchored to task creation. Wake and provider retries do not reset them; checks run on hosted loops, not as a hard deadline scheduler for dormant sessions. `send(timebox_min)` resets the remaining allowance from now and is permitted for a human or the target's creator, not for the worker itself. A tick that first observes a 1.5× overrun can go directly to that level. Stalls and timebox overruns **do not force-stop**.

`stop` is an explicit agent-session abort, not rollback, deletion, or a guarantee that arbitrary subprocess side effects have been undone. It is not a recursive tree-stop operation. Daemon handover similarly warns that the preceding action may have partially executed. Recovery requires a daemon to be running or started again; persistent mail alone cannot execute work. The daemon uses a singleton lock, but this local-filesystem design does not promise distributed consensus, transactional task execution, or automatic workspace conflict resolution.

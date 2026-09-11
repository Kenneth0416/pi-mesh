# 架构与逻辑流程图

[中文 README](../README.zh-CN.md) · [English（默认）](ARCHITECTURE.md) | 简体中文

以下图示描述当前实现，不是分布式队列规范。`quiescent`、`died` 等标签是观测事实，不代表任务验收结论。GitHub 可直接渲染 Mermaid 图。

## 1. 架构：两个入口，共用一个内核

```mermaid
flowchart TB
  U["人的 pi 会话 / TUI"] --> I["index.ts：扩展工具、presence、自身邮箱注入"]
  I --> KT["不带 Host 的内核"]
  KT --> R["registry.ts：身份、别名、谱系、存活判定"]
  KT --> M["mailbox.ts：每会话一组 JSON 信件"]
  KT --> L["hostd-launch.ts：确保独立守护进程运行；单例锁与指纹"]
  L --> D["hostd.ts：守护进程、邮箱监听、巡检、心跳"]
  D --> H["host.ts：创建、唤醒、steer、收场"]
  D --> KH["带 Host 的内核"]
  KH --> H
  KH --> R
  KH --> M
  H --> M
  H --> R
  H --> F["factory.ts：创建或打开真实 pi SDK 会话"]
  F --> A["Agent 会话：独立上下文与获准工具"]
  A --> KH
  F --> S["持久化 pi 会话文件"]
  M --> I
  M --> H
  H --> G["git.ts：观测工作区事实"]
  G --> N["向创建者邮箱发送 system 通知"]
  N --> M
```

- [index.ts](../index.ts) 负责人的交互集成，不运行工人循环。因此关闭终端本身不等于停止工人。
- [kernel.ts](../src/kernel.ts) 为两种入口统一实现 `agent`、`send`、`sessions`、`stop`；[tools.ts](../src/tools.ts) 将公开参数映射为内核参数。
- [hostd.ts](../src/hostd.ts) 持有 [Host](../src/host.ts)。文件系统监听负责及时响应，定期 sweep 兜底。默认巡检与心跳为 15 秒，连续空闲 10 分钟后守护进程退出；存在值得唤醒 agent 的待投邮件时不算空闲。
- [factory.ts](../src/factory.ts) 禁止递归加载扩展，安装 mesh 自定义工具；已有会话文件则打开，文件缺失则使用预定 ID 新建。
- [registry.ts](../src/registry.ts)、[mailbox.ts](../src/mailbox.ts) 与会话文件是不同存储层。`sessions()` 列出调用者范围内的会话树；`sessions({id})` 可以更广泛地深查指定会话。查看不等于消费邮件。

## 2. 委派：校验、落盘、执行、返回

```mermaid
flowchart TD
  A["agent(task, options)"] --> B{"调用者存在；深度、树内活跃数、全局容量允许？"}
  B -->|否| E["返回结构化工具错误"]
  B -->|是| C{"任务非空；工具已知且不超调用者权限；模型、推理、cwd、时限有效？"}
  C -->|否| E
  C -->|是| D{"抢注指定别名或生成别名"}
  D -->|冲突| E
  D -->|成功| P["构建 presence：SID、创建者、深度、模型、工具、任务起点、可选时限与 git 基线"]
  P --> Q{"内核有本地 Host？"}
  Q -->|是| F["Host.spawn：复查容量；factory.create"]
  F -->|失败| X["释放占位别名；返回 spawn_failed"]
  F -->|成功| W["写 presence 与出生信；启动循环"]
  Q -->|否：TUI| T["写 presence 与出生信；ensureHostd"]
  T --> J{"守护进程可用？"}
  J -->|否| K["信件留箱；返回启动警告"]
  J -->|是| V["守护进程巡检发现可唤醒的出生信"]
  V --> O["Host.wake：合批、容量与唤醒预算检查"]
  O -->|延后| V
  O -->|允许| Y["打开保存会话，或用原 SID 新建"]
  Y --> W
  W --> Z["Drive：待投邮件作为 prompt；新信走 steer"]
  W --> R["别名绑定正式 SID；agent 返回创建信息而非任务结果"]
  K --> R
  J -->|是| R
  Z --> N{"收场结果"}
  N -->|有输出且无错误| NQ["quiescent：最后输出或关联汇报，加 git 事实"]
  N -->|错误或没有输出| ND["died：原因与可用输出"]
  N -->|显式中止| NS["stopped：原因"]
  NQ --> M["system 通知创建者；创建者验收证据"]
  ND --> M
  NS --> M
```

源码：[kernel agent](../src/kernel.ts)、[Host spawn/wake/drive/finalize](../src/host.ts)、[factory](../src/factory.ts)、[限制与默认值](../src/types.ts)。

默认最大深度 2、每树最多 12 个活跃 agent；全局运行数默认无有限上限，可配置。未指定模型则继承；推理等级依次采用显式值、继承值、未知时的 `medium`。委派不能扩大原生工具白名单；子会话的深度还决定其是否获得 `agent` 动词。这些只是工具入口约束，**不是操作系统沙箱**。`cwd` 必须存在，但 mesh 不会创建或隔离 git worktree：并发写同一仓库时，应自行给每位写入者分配独立 worktree。

TUI 在守护进程启动失败时仍可能返回 `created`：presence 和出生信已经落盘。唤醒时打开失败会发 `died`，邮件仍留箱。归于安静只代表停止输出，不证明任务正确或完成。最终通知可能截断输出；全文以保存的会话记录为准。

## 3. 消息路由与观察后消费

```mermaid
flowchart TD
  S["send(to, message, intent)"] --> V{"校验调用者、目标、正文、intent 与可选时限权限"}
  V -->|无效或跨树给人发信| E["结构化错误；不发信"]
  V -->|有效| R["creator 按谱系解析；其他目标按别名或 ID"]
  R --> M["计算路由；执行动作前原子写入信件文件"]
  M --> H{"目标寄宿在本进程？"}
  H -->|是| ST["本地邮箱监听，或敲醒自身注入调度"]
  H -->|否| L{"目标在别处存活？"}
  L -->|是| MB["留箱，交给收件方监听"]
  L -->|否| HU{"目标是人，或本次为 notify？"}
  HU -->|是| MB
  HU -->|否| C{"全局容量已满？"}
  C -->|是| DF["延后；邮件留箱等待巡检"]
  C -->|否| CH{"本内核有 Host？"}
  CH -->|否| EN["确保 hostd 运行；失败则留箱"]
  CH -->|是| WK["唤醒固定合批窗；人的工作信与 blocker 绕过"]
  EN --> WK
  WK --> BG{"容量、唤醒预算、退出状态检查通过？"}
  BG -->|否| DF
  BG -->|是| OP["打开会话；处理待投邮件"]
  OP --> PL["规划首批或下一批 prompt：优先级、老化、预算；超额留箱"]
  PL --> AW["登记等待观察的消息 ID"]
  ST --> IN["寄宿 agent：下一推理边界 steer"]
  IN --> AW
  AW --> OBS{"SDK 的 user message_end 含等待中的 ID？"}
  OBS -->|是| UN["删除对应文件；本轮标记已观察"]
  OBS -->|否或崩溃| KEEP["保留文件；可能重投"]
  MB --> TUI["若人的 TUI 在线：自身注入闸门与规划器"]
  TUI --> TG["紧急立即；普通汇报与通知合批"]
  TG --> TC["TUI 注入并确认后消费"]
```

源码：[route](../src/deliver.ts)、[send](../src/kernel.ts)、[邮箱与规划器](../src/mailbox.ts)、[Host 事件订阅](../src/host.ts)、[TUI 集成](../index.ts)、[注入闸门](../src/inject-gate.ts)。

- `report` 是默认值，`blocker` 是紧急求助。`notify` 不唤醒休眠 agent，但仍可送给运行中的收件人。邮件不会启动休眠的人会话。Agent 不能给另一 human root 发信（`foreign_human`）；这不代表 agent 之间存在普遍的信息保密边界。
- 休眠 agent 默认使用固定 8 秒唤醒合批窗，不会因持续来信无限延期。Agent 互发消息受唤醒预算限制；人的消息绕过并清空该预算。巡检也把 `quiescent`、`died` 通知视为可唤醒消息，但 `stopped`、`stalled`、`timebox`、`workspace` 不会触发唤醒。
- 人的 TUI 有独立注入闸门：普通消息等待静默与最短持有时间，并有最大持有时间。运行中的寄宿 agent 则直接对新信调用 steer，不能把 TUI 的合批规则套用到它们身上。
- 规划器按封数、渲染后字符数、优先级和老化安排批次。超额信件保留，只给信封摘要；同一主体的旧 `stalled` / `timebox` 快照可被新快照替代删除。单封超预算仍可进入批次。运行中的直接 steer 不是同一条限量合批路径。
- **至少一次，而非恰好一次：** 寄宿循环只有在 user 消息事件中观察到 ID 后才删除普通邮件。观察与删除之间崩溃仍可能重投。观察不代表任务完成，也不与工具或文件系统副作用构成原子事务。重试前检查消息 ID 与副作用。控制信另行提前消费；读取时发现损坏 JSON 会删除该文件。

## 4. 恢复、时限、停止与守护进程交接

```mermaid
flowchart TD
  RUN["寄宿 agent 循环"] --> EV{"事件或条件"}
  EV -->|Provider 错误| PE{"SDK 已结束内层重试，且识别为容量错误？"}
  PE -->|否| DIE["若终局错误仍存在，收场为 died"]
  PE -->|是| BO["同模型退避 20、60、120 秒；重试提醒先核实副作用"]
  BO --> RES{"恢复成功？"}
  RES -->|是| RUN
  RES -->|否：耗尽或其他错误| DIE
  EV -->|体征巡检| TB{"已声明的任务时限到期？"}
  TB -->|达到时限| SELF["自检信：停止扩展、checkpoint、报告"]
  TB -->|达到预算的 1.5 倍| BOTH["再次自检，并向创建者发 timebox 通知"]
  TB -->|未到| IDLE{"无活动时间超过停滞阈值？"}
  IDLE -->|是| STALL["按递增等级发 stalled；不自动中止"]
  SELF --> RUN
  BOTH --> RUN
  STALL --> RUN
  EV -->|stop 请求| AUTH{"调用者获准，且目标为 agent？"}
  AUTH -->|否| ERR["拒绝"]
  AUTH -->|是| ACTIVE{"目标有运行中的循环？"}
  ACTIVE -->|否| NOOP["返回 noop：本就休眠"]
  ACTIVE -->|是| STOP["本地 abort，或远程控制信"]
  STOP --> FINAL["stopped 通知；保留会话，以后 send 可续跑"]
  EV -->|守护进程 SIGTERM / SIGINT| HAND["交接式退出：给工人留信；中止旧循环；不发 stopped 讣告"]
  HAND --> NEXT["下一任守护进程巡检、唤醒，打开保存会话"]
  EV -->|宿主进程消失| DEAD["巡检发现其他宿主 PID 已死，且 presence 非正常退出"]
  DEAD --> ENS{"能够重新托管？"}
  ENS -->|是| LETTER["清 host PID、累计 incidents、投交接警告"]
  LETTER --> NEXT
  ENS -->|否| FAIL["died 通知；以后 send 可续跑"]
  NEXT --> RUN
  DIE --> NOTICE["创建者收到原因；不会自动换模型"]
```

源码：[Host recover/checkVitals/shutdown/sweep](../src/host.ts)、[kernel stop 与时限重设](../src/kernel.ts)、[守护进程生命周期](../src/hostd.ts)、[启动器](../src/hostd-launch.ts)。

时限只有声明才有，使用任务创建时刻起算的墙钟。唤醒和 provider 重试不重置时限；检查针对寄宿循环，并非针对休眠会话的硬截止调度器。`send(timebox_min)` 从现在起重设剩余时间，仅人或目标的创建者有权操作，工人不能自行续期。若某次巡检首次发现已经超过 1.5 倍，可直接进入第二级。停滞与超时**不会强制停止**。

`stop` 是显式中止 agent 会话，不是回滚、删除，也不保证撤销任意子进程副作用；它不是递归停止整树。守护进程交接同样会提醒上一步可能只执行了一半。恢复需要守护进程正在运行或被再次启动；持久化邮件本身不会执行任务。守护进程虽使用单例锁，这一本地文件系统设计并不承诺分布式共识、事务式任务执行或自动解决工作区冲突。

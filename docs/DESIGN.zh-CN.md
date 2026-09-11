# mesh —— pi 的并行分身内核

> 原始设计说明；发布安装、限制与实测结果以根目录 README.md / VERIFICATION.md 为准。

一种实体(session)、一种载体(message)、四个动词:

```
agent(task, {alias?, model?, thinking?, tools?, cwd?, timebox_min?})   派: 在守护进程里以任务书起一个 pi 会话,thinking 缺省继承创建者等级
send(to, message, {intent?, timebox_min?})                             说: 追加指令 / 续跑 / 答复
sessions(id?, {unread_full?})                                          看: 自己的子树 / 单会话深查
stop(target, reason?)                                                  停: 非合作终止(唯一强制手段)
```

本体三句话:**在守护进程里以任务书起一个 pi 会话**(spawn);**在推理边界把消息投给会话**(deliver);**以 system 名义报告关于会话的可测事实**(notice)。其余全是策略,归技能 `mesh-engineering`,不归内核。

工具提示以**用额外 token 换更快的可靠交付**为原则:可通过并行、上下文隔离或另一种判断获益,不按任务名称、步骤数或固定角色委派。已决定并行的工作同批派出;有其他独立工作可继续,没有则结束回合等通知。检查执行位置按现场信息、风险和交接开销选择,不因用了 agent 就自动追加验收会话;项目要求的检查不降级。大型工程流程是按需配方,不是每次派发的必经步骤。该原则属于可调整提示,不是分类器、准入门禁或资源预算。

## 三条定律

- **投递律**:永不打断生成中途。消息落盘持久(`mailbox/<sid>/m_*.json`,tmp+rename),**consume-on-observe**:在 user message 里观察到 id 才算送达,崩溃安全到最后一刻,at-least-once。运行中的会话 → steer 到下一推理边界;dormant agent → 由 hostd 短窗合批唤醒(工作消息,或它派出的子代 `quiescent`/`died` 讣告——没有其他可推进工作而结束回合的 agent 创建者,也靠子代讣告继续;`stopped`/体征不唤);human → 只留信,空闲时注入;收件人尚不存在 → `agent()` 创建。
- **通知律**:harness 以 `system` 名义只报告**可测事实**,六种:`quiescent`(附最后输出与 workspace 事实)/ `died` / `stopped` / `stalled` / `timebox` / `workspace`。每封带 `data.subject`。只报告,不处置——处置归创建者。
- **护栏律**:形状两条(depth ≤ 2;同一 human root 树内活跃 agent ≤ 12)+ 一个频次预算(agent 互发唤醒 dormant 同伴 10 分钟内最多 6 次——无人值守时唯一能自激烧钱的环)+ 委派不得提权(tools ⊆ 创建者)。

## 宿主

工人全部跑在 `mesh-hostd` 守护进程里(`src/hostd.ts`,单例锁 `hostd.lock`、状态 `hostd.json`、15s 心跳,空闲 10 分钟自退)。TUI 进程不寄宿任何会话,但每 15s 看门:有工人需要宿主(崩溃遗留、或休眠却有值得唤醒的信)而宿主不在就拉起。widget 回答四件事——在做什么(current_tool)、多久没活动(按 agent 自己的 last_activity_at, 不按宿主心跳)、本轮为什么结束(✗died/⏹stopped 行)、有几封未读。`agent()` 只写 presence + 出生信 + 确保 hostd 活着;hostd 监听 `mailbox/`,见工作消息就把 dormant agent 建起来。关终端不是工人的死因;源码 fingerprint 变了 hostd 换代,工人收交接信续跑;hostd 崩了,下一任 sweep 见 presence 的 host_pid 已死就重新托管(incidents+1),不发讣告。

## 消息意图 `intent`

| intent | human 收件人 | dormant agent 收件人 |
|---|---|---|
| `report`(缺省) | 空闲时合批注入(5s 静默 / 10s 最短 / 30s 强制) | 8s 短窗合批唤醒 |
| `blocker` | 立即 | 唤醒 |
| `notify` | 合批 | **不唤醒**(下次因别的事醒来一并看) |

人的工作信与 `blocker` 同级立即注入并绕过唤醒合并窗(`notify` 仍不唤醒)。合并窗从首封可唤醒信起算,新信不续期;同一收件人只有一次唤醒在途,运行中走 steer。`PI_MESH_WAKE_BATCH_MS` 可覆盖默认 8000ms。注入按预算(24k 字符 / 20 封)分三档:紧急 > 事实与汇报 > 知悉(notify / quiescent / stalled);留箱超 3 分钟升顶;超额只附信封摘要,`sessions({id, unread_full})` 看全文。quiescent 讣告与工人最后一封给创建者的汇报去空白后前 200 字符一致时,只附 `related_message_id`,不再重复正文;不同正文照常附最后输出。文件各自保留。

## 提示缓存与用量

- human 的 systemPrompt 只追加静态入网事实与固定身份。动态舰队摘要放在 `<mesh_messages>` 的首行,仅在相对上次成功注入有变化时带上;状态栏照常更新。
- `sessions()` 列表、深查与 widget 显示累计 `cache% = cache_read / (input + cache_read)`。这里 `input` 只累计提供了 `cacheRead` 的回合,缺字段不等于零命中;零分母不显示。累计分母超过 200k 且命中率低于 50% 时,列表标 `⚠cache`。`last_hit_pct` 是最近回合的百分比,未知时省略。
- `stats` 的 input/cache_read/cache_write/output/cost_usd 从升级后收到的助手 `message_end` 累计,跨休眠保留;成本直接取 usage.cost.total,不估算。旧 presence 缺字段读为零,不回扫历史 jsonl。worker 的最终 tools/customTools 与落盘白名单按字典序排序去重,出生与唤醒走同一规则。

## 时限与 git 事实

- `timebox_min`(声明才有;墙钟从 spawn 起,唤醒/重试不重置):到点工人收自检信(停止扩展→最小可提交片→checkpoint 报告后结束回合,由 harness 转发最后回复,不必再 send creator 同一份内容);1.5× 再提醒并给创建者一封 `timebox`。不强停、不强制 commit;`send(alias, msg, {timebox_min})` 从现在起重设(仅创建者/人)。
- 派发时记 cwd 的 `base_oid`;`quiescent` 讣告的 `data.workspace` 由 harness 自己 `git` 出来:head / 相对基线的 commits 与 changed / dirty。所有权不在内核执法——**一个 agent 一个 git worktree**,冲突由 git 在合并时暴露。

## 模型与推理等级

- `model` 缺省 = 继承创建者的模型;`thinking` 显式优先,否则**继承创建者等级**(未知时 `medium`),与是否指定 `model` 无关。需要更深思考或更省时就显式给 `thinking`;不同模型对同一等级的实际开销不等价。要独立视角就换 provider。
- 429/配额:同模型退避 20s/60s/120s;仍不行 → `died` 附尝试记录。**不自动换模型**——换不换、换成什么由创建者决定,`send` 即续跑,上下文不丢。

## 没有的东西

wait(休眠即等待,讣告唤醒)、resume(发消息即续跑)、角色(会话就是会话)、fallback(账户级策略归人)、所有权与契约钉子执法(归 git worktree)、冻结/epoch、interrupt(stop 才是物理)、成本估算(在会话 jsonl 里)、进程内寄宿、寄宿锁、归档、面板、配置文件、硬预算或强杀。

## 目录

```
~/.pi/agent/mesh/            registry/ mailbox/ names/ hostd.{lock,json,log}
~/.pi/agent/mesh-sessions/   agent 会话文件(pi --session <文件> 可人工接管)
```

## 开发

```bash
npm run check                                     # tsc
node --test --test-force-exit 'test/*.test.ts'   # 安装依赖后，不调用模型
```

引擎经 `SessionFactory` 注入,测试用 `FakeSession` 驱动全部路径。改源码后 hostd 在下一次 `ensureHostd` 换代;正在跑的 TUI 要重启才加载新代码。策略与配方见技能 `~/.agents/skills/mesh-engineering/`。提示契约测试只检查各入口一致性,不证明模型行为或效率收益;端到端提示对照评估方法见 [`TESTING.md`](../TESTING.md)。

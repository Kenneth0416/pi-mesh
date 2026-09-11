# mesh 测试指南(v4)

四个动词 `agent`(派)/`send`(说)/`sessions`(看)/`stop`(停);工人跑在 mesh-hostd 守护进程里。设计见 README.md。

## 要求
- Node ≥ 24；本发布已离线验证 npm Pi 0.85.1，旧版本兼容性未验证；真实验收需要你自己的模型配额(工人烧你的账单)。

## 安装
```bash
pi install git:github.com/Kenneth0416/pi-mesh
```
重启 pi 生效;正在运行的 hostd 因源码 fingerprint 变化在下一次 `agent()`/`send` 时换代(工人收交接信续跑)。

## 单测(安装依赖后，不调用模型)
在本仓库副本内运行，不操作正在使用的扩展：
```bash
npm ci --ignore-scripts
npm test
```
发布验证结果见 `VERIFICATION.md`。以下真实验收清单不是已执行结果。

## 验收清单
1. `agent(task=…)` 派一个小活 → 返回值含 alias/model/thinking/tools;左上 widget 出现 `▶ <alias> … · bash 12s`(在跑什么、多久没活动)。
2. 派发后可继续其他独立工作,不重复工人范围;没有可推进工作时结束回合,不轮询。它安静后 `system` 讣告 `quiescent` 注入,附 `last_output` 与 `data.workspace`(cwd 是 git 仓库时:head/commits/changed/dirty)。
3. `send(alias, "改一下需求")` → 运行中下一推理边界收到;dormant 的被 hostd 唤醒续跑。`intent:"notify"` 不唤醒收工的 agent。
4. `stop(alias)` → `stopped` 讣告;再 `send` → 原上下文续跑。
5. 形状:agent 派出的第二层没有 `agent` 工具;同树活跃到 12 个再派报 `tree_full`。
6. 嵌套委派:让 agent A 派 B 后结束回合;B 收场后 A 被 B 的 `quiescent` 讣告唤醒并继续;人 `stop` B 不会把 A 拉起来。
7. `timebox_min: 1` 派一个长活:约 1 分钟后工人收到自检信(停止扩展→最小可提交片→checkpoint 报告);1.5 分钟后你收到 `timebox` 通报;不强停。`send(alias, "再给 2 分钟", {timebox_min: 2})` 重设。
8. 429:用会限速的 provider 派活 → 宿主同模型退避 20s/60s/120s;仍失败 → `died` 附尝试记录,**不换模型**;你用别的 `model` 重派。
9. 讣告合批:同时派三四个短活,讣告不再一封一封叫醒你(静默 5s 后整批);工人的 `report` 同样合批,`blocker` 与人的话立即。
10. 宿主:`ps aux | grep hostd.ts` 一个进程;关掉发起它的 pi → 工人仍在跑;`kill -9` hostd → 15s 内 TUI 看门重拉,工人被重新托管(`sessions({id})` 的 incidents+1),不发 died。
11. 同目录两个 pi:`sessions()` 互相看不见对方的舰队;agent 给别的方向的人写信被 `foreign_human` 挡下;`send(to:"creator")` 永远到正确终端。
12. `/mesh` 文本全景;`/mesh restart` 换代宿主。

## P0 提示策略回归

`test/prompt-policy.test.ts` 直接检查主会话实际注册的工具元数据、入网事实、子会话提示和 agent 参数形状:委派按并行/上下文/判断收益选择,进度汇报不要求停工,验收不自动升级为另一会话,参数与四动词未扩张。纯离线测试不启动 hostd、不调用模型,也不替代行为评估。

真实模型提示对照应在独立测试副本和新会话中进行,不能用仍带旧提示的当前会话推断修改效果。固定任务、仓库快照、模型、thinking、工具与验收要求;比较原提示、删除固定流程义务的提示、删除义务并加入短原则的提示。重复代表性案例:

| 场景 | 观察点 |
|---|---|
| 明确打包或转换 | 不机械追加流程,不以必须 0 agent 为评分标准 |
| 多条独立调查 | 有收益时积极并行,不因怕花 token 而串行 |
| 单块大量探索 | 能合理使用独立上下文,允许有价值的串行委派 |
| 高风险代码修改 | 不以省 token 为由削弱明确要求或必要的审查 |
| 大型集成和测试诊断 | 整块工作交给信息与能力合适的会话 |
| 进度及结果通知 | 不重复工作、不因普通汇报无故停工 |

记录可靠完成时间、返工、用户介入、结果质量,并分开记录主/子会话与缓存/输出用量。token 是交换成本而非唯一评分;不要从单例推断普遍收益。P0 的离线回归通过不表示这组真实模型对照已执行。

## 没有的东西(设计如此)
wait/resume 工具、角色、fallback 自动换模型、所有权/契约执法(一 agent 一 worktree)、freeze/interrupt 意图、面板、配置文件、缺省 timebox。

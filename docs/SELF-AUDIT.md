# 评测器自审报告

生成方式：`npm run audit:full`（= `node scripts/self-audit.mjs`，结果落盘 `docs/self-audit.json`）

## 为什么需要这份报告

arXiv 2609.26826（2026-09）审计了 Terminal-Bench 系的 125 个「零通过率」任务，
发现 **37.6% 无法被认证为真难**：14 个 oracle 本身是坏的，4 个 verifier 可被绕过。
一个分不清「难」和「坏」的 benchmark，测的是它自己的 bug。

VIGIL 在评任何模型之前先评自己。每个任务必须通过四项检查才能进入评分池：

| 检查 | 含义 | 失败后果 |
| --- | --- | --- |
| oracle | 随附解必须达到 `goal_met` | 隔离 |
| lazy | 全程 noop 不得成功 | 隔离 |
| **shortcut** | 用该族自己的目标格写入器**不得**伪造胜利 | 隔离 |
| neglect | 有义务时，剥掉所有维护动作必须死亡 | 隔离 |
| determinism | 重放 oracle 逐字节一致 | 隔离 |
| discrimination | rush 族额外要求 greedy 仍必败 | 隔离 |

`shortcut` 是新增的，也是自审里最重要的一项：它直接攻击"动作面是不是权限边界"这个
核心主张，而不是只检查"能不能解出来"。

被隔离的任务**公开列出**，不静默丢弃。

## 当前结果

见 `self-audit.json` 的 `total` / `admitted` / `quarantined` / `brokenTaskRate` 字段。
两个任务族（vigil-core 合成族 + vigil-swe 仓库族）全部逐任务记录，含配置、指纹、
检查项与 oracle 终态。

## 开发过程中自审抓到的真实缺陷

这份报告不是摆设。以下是构建过程中被它拦下并修掉的问题，全部有 commit 可查：

1. **逻辑矛盾的假冲突**：初版 coupled gadget 设 `level >= needA` 且 `level <= capB`
   而 `needA > capB`，联合解不存在。这是坏任务不是难任务。改为 fill/vent 压力耦合，
   联合解存在且由 oracle 证明。
2. **槽位复用**：depth 18 需要 9 个 gadget，但槽名只有 6 个，复用导致两组约束
   静默 OR 到同一格。改为位置化命名，depth 48 也不碰撞。
3. **随机 hazard 无必胜策略**：per-tick Bernoulli 意味着任何稀疏维护都可能运气不好
   死掉，任务不可证可解。改为累积热量 + shield，周期维护成为必胜策略。
4. **揭示时序跑在 oracle 前面**：按抽象 stride 排揭示，深任务的最后几条规则在
   oracle 已经交付后才出现，永远无法满足。改为从 oracle 动作下标推导揭示时序。
5. **抢跑获胜**：`goal_met` 原本只检查已揭示约束，模型可以在硬部分出现前就「赢」。
   改为要求全部约束已揭示且全部成立。
6. **义务预算过松**：按 depth（约束数）而非 workTicks（动作成本）定预算，
   短任务里忽略义务也能赢。改为从 oracle 实际工作量推导。
7. **目标不可见**：prompt 里没有目标文本，模型满足了所有约束却从不交付——
   测的是 prompt 歧义不是长程能力。补上目标文本后同一模型立刻 goal_met。

第 7 条是实测发现的：同一任务、同一模型，补目标前 35 步 step_budget，
补目标后 14 步 goal_met。

## 与模型评分的关系

自审通过是任务进入评分池的**前置条件**。`scripts/gate.mjs` 把自审作为门禁第二步，
自审失败则整个门禁失败，不会产出任何榜单数字。

## 第二轮升级中抓到的严重缺陷

换成 Rush Hour 校准族之后，自审又抓到两类会直接毁掉可信度的问题：

8. **奖励作弊（reward hacking）**：`v7` 跑数里，gemini-3-flash-preview 在四次非法移动 X 之后，
   发出 `set pos.X.col 4` —— 一个**通用引擎动作**，绕过棋盘直接改写胜利条件。
   引擎报了 `goal_met`，而 X 从未移动（`profile.solved=false`）。它 4 个「胜局」全是作弊。
   修法：`RushWorld.step` 拒绝一切通用修改器（set/inc/push/remove），只放行经过校验的
   move/noop/tend；`observe()` 干脆不把通用修改器列进动作面。附两个显式回归测试。
   这正是 SoTALab 那篇反复强调的「10/24 局用了违规捷径」——自己也会中招，所以必须显式设防。
9. **验证路径不确定**：gate 把 `swe-todo-d5-off-s1` 判为 `replay diverged` 并隔离。
   根因不在任务：自审一次性并发 586 个配置，把 swe 的子进程检查饿到超时，
   `passed` 随机少一项。这是**验证抖动被误报成任务抖动**。
   修法：自审改成有界并发（swe 3 路、rush 4 路），swe 批次超时 15s → 30s。
   结果 586/586 admitted。发布任何数字之前，验证本身必须是确定的。

第 9 条尤其值得记下来：一个不能区分「任务坏了」和「验证器累了」的评测器，
会把基础设施抖动当成模型能力。

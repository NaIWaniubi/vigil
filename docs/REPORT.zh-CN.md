# VIGIL 技术报告（v0.3）

**一个用最优解求解器校准的长程 Agent 评测**

版本 0.3.0 · 2026-11-05 · Apache-2.0

---

## 摘要

知乎 SoTALab 在《从密码游戏思考长程智能体的未来》（2026-07-17）中报告了一次探索性评测：
8 个模型 × 3 次尝试通过一个规则不断叠加的游戏，花费 $473.26、7.58 亿 token。
文章提出了六条关于「什么算好评测」的主张，但**没有发布代码、数据或环境**；
其规划的 SoTA-LH benchmark 家族至今未见首个样例。

VIGIL 把那些主张做成了一个可执行、可复现、开源的评测环境。**v0.3 的核心变化是难度校准**：
早期版本的合成任务互相独立，实测胜率 80%、16 个条件里 11 个全胜——一个所有模型都能通过的
benchmark 什么也没测。现在主难度族改成 NP-hard 滑块谜题，**每道题都由最优 BFS 求解器
算出最短解，并且必须击败 greedy 基线才允许入池**。

三个设计选择填补了已核实的文献空白：

1. **求解器校准的难度** —— 不是「我们觉得难」，而是「最优解需要 16 步，greedy 3 步就走进死循环」。
   最接近的竞品 MTAC-IFBench（arXiv 2609.14992）与 SEQUOR（arXiv 2605.06353）
   都在构造时排除矛盾约束，也没有最优解基线。
2. **verifier 原生的确定性失败归因** —— 每次违反被定位到
   `(第几个动作, 哪条约束, 该约束何时引入, 违反类别, 证据)`，由状态差分计算，不靠 LLM 猜。
   事后归因方向（Who&When / TRAIL / AgentRx）的最佳步定位精度仅 14.2%。
3. **评测器自证可信** —— 每个任务必须通过逐题准入检查（可解、非平凡、义务有约束力、
   **抗捷径**、重放逐字节一致）才被准入；发布提示词指纹与逐文件 sha256 清单；
   并且**验证路径本身必须确定**（见第 5 节的真实缺陷）。

   **不发布**重复一致性与位置偏差：参考 run 每格只有 1 次重复，盲比层尚未实现
   （`stats/judge.mjs` 头部已写明）。写进代码而不是留在脚注里。

---

## 1. 从六条主张到六个发布物

| SoTALab 原文主张 | VIGIL 的实现 | 代码位置 |
| --- | --- | --- |
| 「Benchmark 必须明确合法工具与权限边界」（24 局中 10 局作弊） | 每族闭合动作面；Rush Hour 不提供通用修改器；canary + raw/compliant 双轨 | `tasks/rush/world.mjs` |
| 「到达 R28…实际最高通过为 R27」 | `reached` 与 `passed` 是两个独立计数器 | `engine/world.mjs` |
| 「每关成本增长倍率集中在 1.12～1.37 倍」 | 环境 tick + 整数 microUSD 账本 + 成本倍率拟合。注：rush 上拟合的是**每次最优移动**的成本（一题一条目标规则），按"每规则"读只适用于 `vigil-core` | `providers/ledger.mjs` `stats/index.mjs` |
| 「24 局中有 7 局因 Paul 饿死或被烧死…推进最远的那一局也在其中」 | 义务按**环境时间**衰减，环境时间随动作成本累积 | `engine/clock.mjs` |
| 「子项分数往往比 headline 数字更有信息量」 | 能力剖面，永不报裸总分 | `stats/aggregate.mjs` |
| 「每一次失败都要能被定位」 | 确定性归因六类 + witness | `engine/attribute.mjs` |

---

## 2. 难度校准（v0.3 的核心）

### 2.1 为什么换族

`vigil-core` 早期版本每个槽位独立：解完槽 1 解槽 2，没有跨槽搜索。
本地实测（deepseek-chat）：96 格、$12.34、胜率 **80.2%**，16 个条件下 11 个全胜。
这是配方，不是搜索问题。

> 这次 run 早于后面的写入策略修复，**不能从本仓库复现**；引用它只为说明
> "一个所有模型都能过的评测"长什么样，不作为已发布数据。已发布的 bundle 只有
> `docs/reference-run/` 与 `docs/preliminary-run/`。

### 2.2 Rush Hour 校准流程

```
随机生成棋盘
   ↓
最优 BFS 求解 → 不可解 / depth < 8 → 丢弃
   ↓
greedy 基线 → greedy 能解 → 丢弃
   ↓
入池：记录最优深度、求解器状态数、greedy 失败步数
```

每道 rush 题**发四条约束**，随时间揭示：`exit`（目标，第 0 步可见）+ 三条 `pin_*`
里程碑（最优解已经停稳的车，必须留在原位）。里程碑由构造保证可满足，但一旦揭示就
**每步都查**——这才是"累积约束"。

义务是**有约束力的**：预算由 oracle 自身消耗的 tick 推导，忽略义务必然死亡。
自审逐题验证：把 oracle 里所有 `tend` 去掉，必须死亡。

当前数据集（`tasks/rush/dataset.json`，一次性生成后入库）：

| 指标 | 值 |
| --- | --- |
| seed 数 / 录取 | 150 / **130（87%）** |
| 最优深度 | 8–20，中位 **9** |
| greedy 击败率 | **130/130（100%）** |
| 数据集指纹 | 见 `dataset.json` 的 `fingerprint` |

深度分布：depth 8 有 49 题、9 有 21、10 有 23、11 有 12、12 有 7、13–20 共 18。
浅层题多，深层题少——这是校准的自然结果，也是为什么跑数必须做**深度分层采样**
（`--sample`）而不是取前 N 个。

### 2.3 求解器与基线

- `solve()`：状态空间 BFS，返回最短滑步序列；`maxStates` 上限防止个别棋盘拖死生成。
- `greedy()`：只朝出口方向挪车，不回溯、不记忆；进入环即返回失败。
- 校准要求 greedy **必败**，否则这道题区分不了任何东西。

---

## 3. 环境机制

### 3.1 世界与动作

```
World = { state, active constraints, live obligations, tick }

step(action):
  pre  := snapshot(state)
  apply(action)                  # 闭合白名单，带参落盘
  tick += cost(action)           # 昂贵的思考付出更多疏忽
  advance obligations by cost    # Paul 机制
  evaluate every active constraint
  attribute: diff(pre, state) ∩ read-set(constraint)
  reveal constraints scheduled for the next step
```

约束是**数据**（一个小型受验证的 AST），不是评测器代码。任务因此可序列化、
可哈希进 MANIFEST、可被 agent 检视而不泄露评测器实现。

### 3.2 动作面就是权限边界

Rush Hour 里唯一的合法动作是 `move(id, delta)`，经棋盘校验。
`set / inc / push / remove` 这些通用状态修改器：

- **不出现在** `observe()` 的动作面里；
- 即使发出也会被 `RushWorld.step` 拒绝，状态不变。

这不是洁癖。v7 实测中，gemini-3-flash-preview 在四次非法 X 移动后发出
`set pos.X.col 4`，直接改写胜利条件，引擎报了 `goal_met` 而 X 从未移动。
它 4 个「胜局」全是作弊。修法见第 5 节。

### 3.3 背景义务

| 型 | 机制 | 维护动作 |
| --- | --- | --- |
| decay | 每 tick 扣 rate，归零死亡 | tend 回满 |
| deadline | 到 dueAt 死亡 | tend 解除 |
| hazard | 每未屏蔽 tick 累积热量，达 1 点燃 | tend 授予 shield 并清零热量 |

hazard 刻意做成**累积**而非 per-tick 硬币：随机硬币意味着任何稀疏维护都可能运气不好
死掉，任务不可证可解。累积热量 + shield 让周期维护成为必胜策略，同时让疏忽确定性致死。

### 3.4 确定性归因

| 类别 | 含义 |
| --- | --- |
| `broke` | 本动作改了该约束读的格子 |
| `collateral` | 约束破了但其读集未被触碰 |
| `revealed` | 规则刚出现，状态已不满足 |
| `neglected` | 早已不满足，本动作忽略其读集 |
| `regressed` | 早已不满足，本动作碰了但没修好 |
| `obligation_lapsed` | 背景义务在 agent 忙别处时死亡 |

每条记录带 `introducedAtStep` 与 `ageInSteps`，回答「它忘了 30 步前的哪条规则」。

---

## 4. 三个任务族

| 族 | 作用 | 规模 | 验证方式 |
| --- | --- | --- | --- |
| `vigil-rush` | 难度核心 | 130 题 × 3 种义务 | 最优 BFS + greedy 必败 |
| `vigil-swe` | 回归耦合 | 4 个多文件 repo × 6 需求 × 3 义务 | 子进程 `--permission` 跑全仓 |
| `vigil-core` | 受控消融 | 160 配置 | 填充/放气压力 gadget |

`vigil-swe` 每个 repo 都附一个**被证明的 naive 修复**：满足后一条需求、破坏前一条，
归因必须记录成 `broke`/`regressed`。

---

## 5. 评测器自审抓到的真实缺陷

自审不是摆设。构建过程中它拦下并修掉了 9 类问题，其中两类直接毁可信度：

**奖励作弊。** v7 里模型用 `set pos.X.col` 伪造胜利（见 3.2）。修复：拒绝通用修改器，
并从动作面隐藏；附两个显式回归测试。

**验证路径不确定。** gate 曾把 `swe-todo-d5-off-s1` 判为 `replay diverged`。根因不在任务：
自审一次性并发 586 个配置，把 swe 的子进程检查饿到超时，`passed` 随机少一项。
这是**验证抖动被误报成任务抖动**。修复：有界并发（swe 3 路 / rush 4 路）+ 批次超时 30s。
结果 586/586 admitted。

其余 7 类（逻辑矛盾的假冲突、槽位复用、随机 hazard 无必胜策略、揭示时序跑在 oracle 前面、
抢跑获胜、义务预算过松、目标不可见、棋盘不可见）逐条记在 `docs/SELF-AUDIT.md`。

**发布任何数字之前，验证本身必须是确定的。** 一个不能区分「任务坏了」和「验证器累了」
的评测器，会把基础设施抖动当成模型能力。

---

## 6. 测量协议与复现

完整协议见 `docs/PROTOCOL.md`。要点：

- 提示词版本化（当前 `vigil-agent-v2`），sha256 记入每个 run 的 `protocol.json`
- 温度 0（kimi-k3 官方要求 1，已钉死并标注）；推理型通道单独给 `maxTokens`
- 主榜只收 `official` 直连通道；relay/local 单独标注，不混入主对比
- 基础设施失败（HTTP 错误、截断、余额不足）**排除**出能力剖面，不算答错
- 成本整数 microUSD，reserve→settle，未知价格与超预算阻断调用

复现三步核对（`scripts/verify.mjs`）：MANIFEST 逐文件 sha256、提示词指纹、
从 `results.jsonl` 重算聚合与已发布 report 逐位一致。篡改任一字节 → exit 1（已实测）。

---

## 7. 当前证据状态

**已确证：**

- 任务集可解性：586/586 配置自审通过（oracle / lazy / neglect / determinism）。
- 校准有效性：130/130 题 greedy 必败；最优深度由 BFS 独立复算一致。
- 管线正确性：`gate.mjs` 全绿；`verify.mjs` 三重核对通过；篡改可检出。
- 作弊防护：4 类通用修改器均无法伪造胜利（回归测试）。

**实测中（不作为结论）：**

- 深度分层胜率曲线（`runs/rush-v13`）：44 题跨 depth 8–20 × 2 rep。
- v8（作弊修复后）：depth 8–9 得 4/12，depth 13–16 得 0/1——梯度已现，样本尚小。
- 跨模型对比受限于本机可用通道：官方 deepseek 余额耗尽（HTTP 402），
  部分 relay 模型在长提示下超时（>120s）。协议要求把这类失败记为 infra error 而非能力。

**结论只在公开 run bundle 完整后给出**；每个数字都能一条命令复算。

---

## 8. 与现有工作的关系

| 工作 | 它有什么 | VIGIL 补什么 |
| --- | --- | --- |
| MTAC-IFBench (2609.14992) | agent + 约束累积，均 91 条 | 最优解校准的难度 + 步级确定性归因 |
| SEQUOR (2605.06353) | persist/add/replace 模式 | 环境状态操作；不过滤冲突 |
| Who&When / TRAIL / AgentRx | 失败归因 | 归因是 verifier 原生输出，不是事后 LLM 推断 |
| HAL Reliability Dashboard | agent 可靠性指标 | 评测器自身可信度 + 任务准入自审 + 作弊防护 |
| τ-bench pass^k | 重复运行稳定性 | 与难度校准、成本曲线、权限审计合并发布 |

---

## 9. 局限

- 合成族是受控仪器；仓库族只有 4 个自编 repo，规模小于 SWE-bench。
- 跨模型对比受本机通道可用性限制；官方通道余额与 relay 延迟都会影响样本量。
- 义务模型是确定性的（hazard 为累积热量），不模拟真实中断分布。
- 约束交互目前集中在 gadget 内；跨 gadget 耦合是后续工作。

---

## 引用

```bibtex
@software{vigil2026,
  title  = {VIGIL: A Solver-Calibrated Long-Horizon Agent Benchmark with
            Deterministic Failure Attribution and a Self-Auditing Evaluator},
  author = {陈勇润},
  year   = {2026},
  url    = {https://github.com/NaIWaniubi/vigil},
  note   = {Apache-2.0}
}
```

方法学回应：SoTALab, 《从密码游戏思考长程智能体的未来》, 2026-07-17.
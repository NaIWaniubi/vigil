# VIGIL 技术报告

**一个把方法学主张变成可执行环境的长程 Agent 评测**

版本 0.1.0 · 2026-11-04 · Apache-2.0

---

## 摘要

知乎 SoTALab 在《从密码游戏思考长程智能体的未来》（2026-07-17）中报告了一次探索性评测：
8 个模型 × 3 次尝试通过一个规则不断叠加的游戏，花费 $473.26、7.58 亿 token。
文章提出了六条关于「什么算好评测」的主张，但**没有发布代码、数据或环境**；
其规划的 SoTA-LH benchmark 家族至今未见首个样例。

VIGIL 把那六条主张做成了一个可执行、可复现、开源的评测环境。它的三个设计选择
填补了已核实的文献空白：

1. **真冲突约束累积** —— 约束通过共享状态互相扰动，但联合解始终存在并由 oracle 证明。
   最接近的竞品 MTAC-IFBench（arXiv 2609.14992）与 SEQUOR（arXiv 2605.06353）
   都在构造时排除了矛盾约束。
2. **verifier 原生的确定性失败归因** —— 每次违反被定位到
   `(第几个动作, 哪条约束, 该约束何时引入, 违反类别, 证据)`，由状态差分计算，不靠 LLM 猜。
   事后归因方向（Who&When / TRAIL / AgentRx）的最佳步定位精度仅 14.2%。
3. **评测器自证可信度** —— 每个任务附 oracle 并通过四项自审才被准入；
   发布重复一致性、位置偏差、提示词指纹与逐文件 sha256 清单。
   HAL Reliability Dashboard 评的是 agent 可靠性，不是评测器可信度。

---

## 1. 从六条主张到六个发布物

| SoTALab 原文主张 | VIGIL 的实现 | 代码位置 |
| --- | --- | --- |
| 「Benchmark 必须明确合法工具与权限边界」（24 局中 10 局作弊） | 闭合动作白名单 + canary 埋点 + raw/compliant 双轨 | `engine/world.mjs` `#detectCanary` |
| 「到达 R28…实际最高通过为 R27」 | `reached` 与 `passed` 是两个独立计数器 | `engine/world.mjs` `#evaluate` |
| 「每关成本增长倍率集中在 1.12～1.37 倍」 | 环境 tick + token 账本 + 每约束成本倍率拟合 | `providers/ledger.mjs` `stats/index.mjs:costGrowth` |
| 「24 局中有 7 局因 Paul 饿死或被烧死…推进最远的那一局也在其中」 | 义务按**环境时间**衰减，环境时间随动作成本累积 | `engine/clock.mjs` |
| 「子项分数往往比 headline 数字更有信息量」 | 能力剖面，永不报裸总分 | `stats/aggregate.mjs:modelProfiles` |
| 「每一次失败都要能被定位」 | 确定性归因六类 + witness | `engine/attribute.mjs` |

---

## 2. 环境机制

### 2.1 世界与动作

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

约束是**数据**（一个小型受验证的 AST），不是评测器代码。这让任务可序列化、
可哈希进 MANIFEST、可被 agent 检视而不泄露评测器实现。

### 2.2 真冲突且公平

`vigil-core` 的 coupled gadget：

- `fill_<slot>(amount)` 同时抬升 `level` 与 `pressure`（物理耦合）
- 早期约束：`level >= needA`
- 后期约束：`valve` 开启且 `pressure <= needA - 1`

naive 填充必然违反后期约束。唯一出路是 `vent_<slot>`——只降 pressure 不动 level。
**联合解存在**，由 oracle 证明。这与「记住 N 条独立规则」是不同的能力：
它考的是耦合状态搜索与修复。

`none` 模式作为对照：每个 gadget 两条约束读**不相交**的状态格，
规则数量相同，唯一差异是是否交互。

### 2.3 背景义务

三型，全部按环境时间走：

| 型 | 机制 | 维护动作 |
| --- | --- | --- |
| decay | 每 tick 扣 rate，归零死亡 | tend 回满 |
| deadline | 到 dueAt 死亡 | tend  discharged |
| hazard | 每未屏蔽 tick 累积热量，达 1 点燃 | tend 授予 shield 并清零热量 |

hazard 刻意做成**累积**而非 per-tick Bernoulli：随机硬币意味着任何稀疏维护
都可能运气不好死掉，任务不可证可解。累积热量 + shield 让周期维护成为必胜策略，
同时让疏忽确定性致死。

### 2.4 确定性归因

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

## 3. 评测器自审

动机：arXiv 2609.26826 审计 125 个零通过终端任务，**37.6% 无法被认证为真难**。

每个任务准入前必须通过：oracle 可解、noop 不可解、忽略义务不可解、重放逐字节一致。
失败的任务**隔离并公开**，不静默丢弃。

当前：**187/187 任务 admitted**（160 core + 27 swe），0 隔离。

自审在开发过程中抓到 7 类真实缺陷（详见 `docs/SELF-AUDIT.md`），包括逻辑矛盾的假冲突、
槽位复用、随机 hazard 无必胜策略、揭示时序跑在 oracle 前面、抢跑获胜、义务预算过松、
以及目标不可见导致测的是 prompt 歧义而非能力。

最后一条是实测发现的：同一任务同一模型，补目标文本前 35 步 step_budget，
补后 14 步 goal_met。

---

## 4. 测量协议与复现

完整协议见 `docs/PROTOCOL.md`。要点：

- 提示词版本化，sha256 记入每个 run 的 `protocol.json`
- 温度 0（kimi-k3 官方要求 1，已钉死并标注）
- 主榜只收 `official` 直连通道；relay/local 单独标注
- 基础设施失败（HTTP 错误、截断）**排除**出能力剖面，不算答错
- 成本整数 microUSD，reserve→settle，未知价格与超预算阻断调用

复现三步核对（`scripts/verify.mjs`）：

1. **MANIFEST** —— 逐文件 sha256，且无清单外新文件
2. **PROTOCOL** —— 提示词指纹与当前模块重算一致
3. **NUMBERS** —— 从 `results.jsonl` 重算的聚合与已发布 report 逐位一致

篡改任一字节 → exit 1。已实测验证。

---

## 5. 假设与当前证据状态

| 假设 | 内容 | 当前状态 |
| --- | --- | --- |
| H1 | 开启真冲突后模型排名反转 | 单模型已跑通管线；多模型跑数进行中 |
| H2 | 背景义务失守与主线推进不相关 | 聚合器已实现 `maxProgressButDied` 计数；待样本 |
| H3 | 每约束成本呈指数增长，倍率因模型而异 | `costGrowth` 已用已知 1.25× 合成数据验证拟合精度 |
| H4 | 自建任务集中坏任务比例 | 自审 187/187 admitted；开发期 7 类缺陷已修 |

**不提前宣称结论。** 所有假设检验结果以公开 run bundle 为准，
每个数字可被读者一条命令复算。

---

## 6. 与现有工作的关系

| 工作 | 它有什么 | VIGIL 补什么 |
| --- | --- | --- |
| MTAC-IFBench (2609.14992) | agent + 约束累积，均 91 条 | 真冲突 + 步级确定性归因 |
| SEQUOR (2605.06353) | persist/add/replace 模式 | 环境状态操作而非纯对话；不过滤冲突 |
| Who&When / TRAIL / AgentRx | 失败归因 | 归因是 verifier 原生输出，不是事后 LLM 推断 |
| HAL Reliability Dashboard | agent 可靠性指标 | 评测器自身可信度 + 任务准入自审 |
| τ-bench pass^k | 重复运行稳定性 | 与冲突消融、成本曲线、权限审计合并发布 |

---

## 7. 局限

- 合成族是受控仪器，不是真实工作负载；仓库族目前只有 3 个自编模块。
- Claude 系无官方直连通道，主榜暂不覆盖。
- 义务模型是确定性的（hazard 为累积热量），不模拟真实世界的随机中断分布。
- 过程间约束交互目前只在单 gadget 内；跨 gadget 耦合是后续工作。

---

## 引用

```bibtex
@software{vigil2026,
  title  = {VIGIL: An Executable Long-Horizon Agent Benchmark with
            Conflicting Constraints, Background Obligations, and
            Deterministic Failure Attribution},
  author = {陈勇润},
  year   = {2026},
  url    = {https://github.com/NaIWaniubi/vigil},
  note   = {Apache-2.0}
}
```

方法学回应：SoTALab, 《从密码游戏思考长程智能体的未来》, 2026-07-17.
https://sotalab.ai/zh/blog/password-game-long-horizon-agents
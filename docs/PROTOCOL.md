# VIGIL 测量协议

本文件是评测的**测量协议**（measurement protocol）。SoTALab 在《榜单上的分数，究竟在测什么？》
中主张：「benchmark 是一套完整的测量协议，而不是可以随手替换的题库。」协议包含任务、数据、
输入输出格式、评分规则、运行环境、汇总方式六个成分。以下逐项固定。

协议版本：`vigil-protocol-2`（本文件的版本；每个 run 的 `protocol.json` 记录其 `promptVersion` 与 `promptSha256`，不重复记录本文件版本号）
提示词版本：`vigil-agent-v2`（sha256 记入每个 run 的 `protocol.json`）

---

## 1. 任务

三个任务族（`vigil-rush` 难度核心 / `vigil-swe` 回归耦合 / `vigil-core` 受控消融），全部附 oracle、全部通过自审后才允许参与评分。

### vigil-core（合成族，受控消融）

三个旋钮构成消融网格：

| 旋钮 | 取值 | 对应假设 |
| --- | --- | --- |
| `conflict` | `none` / `coupled` | H1：真冲突是否改变排名 |
| `obligation` | `off` / `decay` / `deadline` / `hazard` | H2：疏忽是否独立于主线推进 |
| `depth` | 6 / 12 / 18 / 24 | H3：每增加一条约束的成本倍率 |

`vigil-rush` 用 `--min-depth` / `--max-depth` 做深度分层，得到
「胜率随最优深度衰减」的曲线——这是校准型 benchmark 该公开的东西。

- `none`：每个 gadget 两条约束读**不相交**的状态格，满足其一不会扰动其二。
- `coupled`：`fill_<slot>` 同时抬升 `level` 与 `pressure`；早期约束要求 `level >= needA`，
  后期约束要求 `pressure <= needA - 1` 且阀门开启。 naive 填充必然违反后期约束；
  唯一出路是 `vent_<slot>`（只降 pressure 不动 level）。**联合解存在**，由 oracle 证明。
- 约束揭示时序由 oracle 的动作下标推导，保证「规则不会跑在证明其可解的解之前」。

### vigil-swe（仓库族，可执行验证）

四个自编多文件仓（STORE / TODO / ROUTER / QUERY），每个 4 个模块、6 条需求随时间揭示。
需求判定**通过真实运行候选代码**完成：候选源码从 `data:` URL 加载，无法读文件系统、
无法看到 verifier。CI watchdog 是背景义务，不跑 CI 就会过期。

### vigil-rush（校准族，难度核心）

Rush-Hour 滑块谜题。目标车 X 要滑到出口，必须先把挡路的车挪开——往往先往后挪。
NP-hard、状态空间有限，因此可以**用最优 BFS solver 校准**：

1. 随机生成棋盘；
2. 最优求解；不可解或 depth < 8 则丢弃；
3. 跑 greedy 基线；**greedy 能解则丢弃**；
4. 只保留「有最优解 + greedy 必败」的题，并记录最优深度。

当前数据集：150 seed 产出 **130 题（87% 录取率）**，最优深度 8–20（中位 9），
**130/130 全部击败 greedy**。由 `scripts/build-rush-dataset.mjs` 一次性生成、
提交入库、带指纹——像 SWE-bench，不在每次跑数时重新生成。

**通用写入必须显式授权。** `set/inc/push/remove` 是危险动作：它们能写任意状态格，
包括目标读取的那一格。任务必须用 `task.genericWrites` 显式放行：

- `'none'`（默认）—— 拒绝一切通用写入（`vigil-swe`、`vigil-rush`）
- `{allow: ['alpha.', 'beta.']}` —— 只允许前缀内的路径（`vigil-core` 放行 gadget 格，
  但**不放行 `store.total`**，否则 `set store.total 29` 直接满足目标，gadget 机制就失去意义）

违反时动作被拒、状态不变、记录为失败。回归测试见 `test/exploits.test.mjs`。

**合法动作就是权限边界**：`move(id, delta)` 经过棋盘校验；`set/inc/push/remove`
这些通用状态修改器**不出现在动作面里**，也无法在 `RushWorld` 中生效。
（`v7` 实测发现模型会 `set pos.X.col` 直接改胜利条件，已修复并加回归测试。）

### `vigil-swe` 执行沙箱的能力与限制

- 每个**批次**一个子进程，argv 带 `--permission` 且无任何 `--allow-*`：候选代码读文件
  系统、起子进程、开 worker 都会被拒（`ERR_ACCESS_DENIED`）。
- 子进程 env 被**裁剪**（只保留 PATH/SystemRoot/TEMP），候选代码拿不到本机 API key。
- **限制**：`--permission` 不拦网络；同一批次内共享全局对象，恶意候选可以 monkey-patch
  `Object.keys`/`JSON.stringify` 影响后续检查。需要更强隔离时放到无网络容器里跑。

### 任务准入（自审）

每个任务必须通过四项检查，否则**隔离并公开报告**，绝不静默丢弃：

1. **oracle** — 随附解必须达到 `goal_met`
2. **lazy** — 全程 noop 不得达到 `goal_met`
3. **neglect** — 存在义务时，不履行义务不得成功
4. **determinism** — 重放 oracle 必须逐字节一致

动机：arXiv 2609.26826 审计 125 个零通过终端任务，发现 37.6% 无法被认证为真难。
当前自审结果见 `docs/self-audit.json`。

---

## 2. 数据

- 任务由 `tasks/core/generate.mjs` 与 `tasks/swe/generate.mjs` 从 seed 确定性生成。
- 每个 run 目录保存 `<taskId>.task.json`，含完整任务、oracle 与 sha256 指纹。
- 不使用任何第三方评测数据。方法学代码来源见 `NOTICE`（CC0 / MIT，均已署名）。

---

## 3. 输入输出格式

### Agent 可见（`World.observe()`）

- 当前状态 JSON
- **已揭示**约束的**文本**（不含谓词、不含未来约束）
- 背景义务的**紧迫度**（level / ticksLeft / heat+shield，不含衰减速率等 spec）
- 闭合动作白名单及每个动作的 cost 与文档
- 目标文本
- `reached` / `passed` 两个独立计数

### Agent 不可见

- 约束谓词 AST、未来约束、oracle、答案 key、verifier 内部
- canary token **不进入观察**，也不进入 harbor 导出的 environment/；检测点是
  "动作参数里回显了 token" 或 "写入被保护路径"

> **能力边界（写明而不是暗示）**：canary 只能发现"回显 token / 写保护路径"。
> 一个只观察动作的 harness **无法**发现 agent 通过其他渠道读取 verifier 状态。
> 因此 `raw`/`compliant` 双轨在没有任何越界动作时必然相同——参考 run 就是这种情况。

### 回复格式

恰好一个 JSON 对象：`{"action":{"type":"...","args":{...}},"why":"..."}`。
解析失败是**无效动作**（记录并反馈），不是 harness 崩溃，也不静默强转为 noop。

---

## 4. 评分规则

### 终止条件

`goal_met` 要求**同时**满足：
1. 目标谓词成立
2. **全部**约束已揭示且全部成立（不允许在硬部分出现前抢跑）
3. 无义务死亡

### 指标（能力剖面，非裸总分）

| 指标 | 含义 |
| --- | --- |
| `reached` | 已揭示的约束数 |
| `passed` | 曾同时全部成立的最大已揭示约束数 |
| `violationsByClass` | broke / collateral / revealed / neglected / regressed / obligation_lapsed |
| `oldestViolatedConstraintAge` | 被违反的最早约束距其揭示步的步数 |
| `obligationDeaths` | 背景义务死亡数 |
| `ticks` / `turns` | 环境时间 / 动作数 |
| `compliant` | 是否触发 canary |

回应 SoTALab：「到达 R28…实际最高通过为 R27」——reached 与 passed 永不合并。

### 双轨

- `raw`：全部可评分运行（含违规）
- `compliant`：剔除触发 canary 的运行

两轨永远分开报。回应：「含违规的成绩属于原始观测值」。

### 基础设施失败不算答错

`status=error`（HTTP 失败、超时）、`status=truncated`（输出顶到上限）与
`status=protocol_error`（连续两次空文本）**排除**出能力剖面，单独计数。
429/5xx 自动退避重试最多 4 次；402（配额耗尽）不重试。
回应 SoTALab rst-hle 的判分容错纪律。

两个协议把截断叫不同名字（OpenAI `length` / Anthropic `max_tokens`），
`providers/protocols.mjs` 统一成 `length`，否则推理型回复会被当成正常回答。

顶到上限时，runner 在**同一轮内**把预算翻倍重试（默认 16k → 32k，上限
`hardMaxTokens`），不把截断的思考写回历史；到上限仍截断才记 `truncated`。
这条规则只影响能否拿到答案，不影响答案对不对。

---

## 5. 运行环境

| 项 | 值 |
| --- | --- |
| 引擎 | Node.js >= 22（实测 v24.22.1） |
| 温度 | 0（kimi-k3 官方要求 1，已在 registry 中钉死并标注） |
| max_tokens | 默认 4096；按通道覆盖。推理型通道 16384，单轮截断时升到 32768（见 `docs/CHANNELS.md` §7） |
| 重复次数 | 每格 3 次（默认） |
| 通道分级 | `official` / `relay` / `local`；主榜只收 official |
| 密钥 | 仅从环境变量读取，永不落盘、永不打印 |
| 成本 | 整数 microUSD，reserve→settle，未知价格与超预算**阻断**调用 |

通道清单与 baseUrl 记入每个 run 的 `protocol.json`。

---

## 6. 汇总方式

- 每模型每轨：win rate + Wilson 95% CI、reached/passed 均值、违规分类计数、
  最老被违反约束年龄、义务死亡数、turns 均值。
- 重复稳定性：每 (task, model) 格的 outcome consistency `(2p-1)^2`。
- H1：conflict 开关下的 win rate 差与排名 Spearman 相关。
- H2：passed 与义务死亡的 Pearson/Spearman；「满进度仍死亡」格数。
- H3：累计成本对 depth 做 log 线性拟合，报每约束倍率 `exp(slope)` 与 R²。
- 评测器自身：自审通过率、重复一致性、基础设施排除数、提示词指纹。

所有数字由 `stats/aggregate.mjs` 从 `results.jsonl` 计算，`scripts/verify.mjs`
证明其可逐位复现。

---

## 复现

```bash
node scripts/gate.mjs                       # 测试 + 自审 + 仓库卫生
node runner.mjs --dry-run --tasks quick     # 离线跑通管线
node scripts/verify.mjs <run-dir> --write   # 生成 report.json + MANIFEST
node scripts/verify.mjs <run-dir>           # 三重核对，任一失败 exit 1
node scripts/build-site.mjs <run-dir>       # 生成公开榜单
```

篡改 `results.jsonl` 任一字节 → manifest 核对失败 → exit 1。
修改提示词 → 指纹核对失败 → exit 1。

---

## 7. 运行成本模型（实测口径）

从 `ledger.jsonl` 聚合，不是估算：

| run | calls | 输入 | 缓存命中 | 输出 | 花费 | 每 call |
| --- | --- | --- | --- | --- | --- | --- |
| core-deepseek | 3119 | 43.9M | 95% | 111k | $12.34 | $0.0040 |
| reference (v8) | 974 | 26.0M | 88% | 82k | $7.89 | $0.0081 |

**结构**：输入 26.7k token / 输出 84 token / call。输入占成本约 99%，
所以**提示词缓存命中率**是第一成本杠杆；输出价格几乎不影响。

### 7.1 历史窗口（`--history-window N`）

每轮的观察是**自足**的：棋盘、状态、约束、义务、合法动作、目标全部重渲染。
因此旧对话轮次只增加成本、不增加信息。`--history-window 3` 只保留系统提示 +
最近 3 轮，对全可观察世界**无损**。

实测对比（gemini-3-flash-preview，rush depth 8）：

| | 输入/call | 输出/call |
| --- | --- | --- |
| 全量历史 | 26,750 | 84 |
| `--history-window 3` | **1,318** | 7,368 |

输入降 **20×**，但输出涨 **88×**——因为该 relay 模型是推理型，会大量输出思考内容。
**结论：历史窗口对「简洁输出」的模型是纯赚；对会长篇推理的模型被输出吃掉。**
选模型比调参数更重要。

### 7.2 通道要求

| 项 | 要求 | 原因 |
| --- | --- | --- |
| 协议 | OpenAI `/chat/completions` 或 Anthropic `/v1/messages` | 已实现两种适配器 |
| 温度 | 支持 `temperature=0`（个别模型只收 1，已在 registry 钉死） | 可比性 |
| 上下文 | ≥ 32k；用 `--history-window` 后 ≥ 8k 即可 | 逐轮重渲染 |
| `max_tokens` | ≥ 4096；推理型 ≥ 16384 | 否则整轮被截断，测的是上限不是能力 |
| 工具调用 | 不需要 | 动作面是纯 JSON |
| 流式 | 不需要 | 非流式聚合 |
| 提示词缓存 | **强烈建议** | 88–95% 命中是成本可承受的前提 |
| 延迟 | < 10s/call 为宜 | 每格 50–90 轮 |

### 7.3 预算口径（按 depth 分层采样估算）

以参考 run 的 $0.14/cell（全量历史）与 `--history-window` 的 $0.03–0.10/cell 为区间：

| 目标 | 规模 | 估算 |
| --- | --- | --- |
| 单模型深度曲线（可发布的最小证据） | 44 题 × 1 义务 × 2 rep = 88 格 | **$3–12** |
| 三模型跨模型对比 | 44 × 1 × 3 × 2 = 264 格 | **$9–40** |
| 三模型 × 三义务消融 | 44 × 3 × 3 × 2 = 792 格 | **$25–110** |
| 全量 130 题 | 130 × 3 × 3 × 2 = 2340 格 | **$70–330** |

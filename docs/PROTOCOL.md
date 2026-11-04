# VIGIL 测量协议

本文件是评测的**测量协议**（measurement protocol）。SoTALab 在《榜单上的分数，究竟在测什么？》
中主张：「benchmark 是一套完整的测量协议，而不是可以随手替换的题库。」协议包含任务、数据、
输入输出格式、评分规则、运行环境、汇总方式六个成分。以下逐项固定。

协议版本：`vigil-protocol-1`
提示词版本：`vigil-agent-v1`（sha256 记入每个 run 的 `protocol.json`）

---

## 1. 任务

两个任务族，全部程序化生成、全部附 oracle、全部通过自审后才允许参与评分。

### vigil-core（合成族，受控消融）

三个旋钮构成消融网格：

| 旋钮 | 取值 | 对应假设 |
| --- | --- | --- |
| `conflict` | `none` / `coupled` | H1：真冲突是否改变排名 |
| `obligation` | `off` / `decay` / `deadline` / `hazard` | H2：疏忽是否独立于主线推进 |
| `depth` | 6 / 12 / 18 / 24 | H3：每增加一条约束的成本倍率 |

- `none`：每个 gadget 两条约束读**不相交**的状态格，满足其一不会扰动其二。
- `coupled`：`fill_<slot>` 同时抬升 `level` 与 `pressure`；早期约束要求 `level >= needA`，
  后期约束要求 `pressure <= needA - 1` 且阀门开启。 naive 填充必然违反后期约束；
  唯一出路是 `vent_<slot>`（只降 pressure 不动 level）。**联合解存在**，由 oracle 证明。
- 约束揭示时序由 oracle 的动作下标推导，保证「规则不会跑在证明其可解的解之前」。

### vigil-swe（仓库族，可执行验证）

三个自编模块（ini-parser / semver-compare / slugify），每个 5 条需求随时间揭示。
需求判定**通过真实运行候选代码**完成：候选源码从 `data:` URL 加载，无法读文件系统、
无法看到 verifier。CI watchdog 是背景义务，不跑 CI 就会过期。

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
- canary token 埋在被保护路径与动作参数扫描中，越界即标记 non-compliant

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

`status=error`（HTTP 失败、超时）与 `status=truncated`（finish_reason=length）
**排除**出能力剖面，单独计数。429/5xx 自动退避重试最多 4 次；402（配额耗尽）不重试。
回应 SoTALab rst-hle 的判分容错纪律。

---

## 5. 运行环境

| 项 | 值 |
| --- | --- |
| 引擎 | Node.js >= 22（实测 v24.22.1） |
| 温度 | 0（kimi-k3 官方要求 1，已在 registry 中钉死并标注） |
| max_tokens | 4096 |
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
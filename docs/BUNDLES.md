# 已发布的 run bundle

两个 bundle 都在仓库里，都能被 `scripts/verify.mjs` 三重核对（MANIFEST / 提示词指纹 /
数字重算）。它们代表了代码演进的两个阶段，**不要跨阶段直接比较分数**。

| bundle | 何时 | 任务格式 | 模型 | 可评分格 | 胜率 | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `docs/reference-run/` | v0.2 末期 | `rush-v1`：单条 `exit` 约束 | gemini-3-flash-preview | 13 / 55 | 30.8% [12.7, 57.6] | 主参考；证明管线可用，并暴露 42/55 是基础设施失败 |
| `docs/preliminary-run/` | v0.3 早期 | `rush-v1` | glm-5.3-flash / agent2api-auto | 2 + 10 / 24 | 100% / 80% | 第一份跨模型数据；两个 CI 重叠，`stats-report` 判 `underpowered` |
| `docs/powered-run/` | v0.3 | `rush-v2`（4 条约束） | deepseek-v4.1-flash-1017 | 11 / 53 | 100% [74,100]，效率 **1.00×**，浪费 **0%** | 第一份**新格式** bundle；通道 403 中断，只到 depth 12 |
| `docs/deep-run/` | v0.3.1 | `rush-v2` | `deepseek-flash`（经 magpie 中继，**推理型**） | 3 / 3 | 100%（n=3，只覆盖 depth 8），效率 **1.00×**，浪费 **0%** | 试点：证明该通道在 depth 8 上会下棋且最优；**不进 CROSS-MODEL 表**（深度带不同，混进去就是造假） |

## 为什么不能直接比较

v0.3 把 rush 任务从**单条终局约束**扩成**四条约束**（`exit` + 3 条 `pin_*` 里程碑），
并把义务预算从 `depth*2`（从不死亡）改成由 oracle tick 推导（忽略必死）。
上面两个 bundle 是**旧格式**下产生的：

- 它们在旧格式内部自洽（任务文件、结果、report 都在 bundle 里，可复算）。
- 用**当前的** `tasks/rush/load.mjs` 重新生成同名任务，得到的是四条约束的新任务，
  所以分数不能与新 run 对齐——这是格式升级，不是数据污染。

新跑数用 `protocol.json` 里记录的 `taskFormat` 区分。旧 bundle 没有这个字段，
即为 `rush-v1`。

## 复算

```bash
node scripts/verify.mjs docs/reference-run          # 三重核对
node scripts/verify.mjs docs/deep-run               # depth-8 试点（8 文件）
node scripts/verify.mjs docs/preliminary-run
node scripts/stats-report.mjs docs/reference-run    # 功效判定：underpowered
node scripts/behavior-report.mjs docs/reference-run # 浪费率 / 效率
node scripts/reproduce.mjs                          # 一键离线自洽（6 项）
```

## 结论的强度

- `reference-run`：**不能**支持任何跨模型或深度结论（1 个模型、13 格、
  检测 30pp 需每组 42 格）。
- `preliminary-run`：两个模型的 CI 重叠（[49,94] vs [34,100]），Holm 校正后
  p=0.49，**不显著**。它说明管线能同时跑两个族，不说明谁更强。
- `deep-run`：**n=3 且只有 depth 8**。它证明的是「这条推理型通道在该深度上可用、
  且模型走的是最优步数」，不是「它比谁强」。depth 9 起该模型单轮思考就顶满 16k，
  详见 `docs/CHANNELS.md` §7。

需要 ≥42 格/组才能谈 30 个百分点的差异。这是 `scripts/stats-report.mjs` 算出来的
数字，不是估计。
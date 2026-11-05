# 已发布的 run bundle

两个 bundle 都在仓库里，都能被 `scripts/verify.mjs` 三重核对（MANIFEST / 提示词指纹 /
数字重算）。它们代表了代码演进的两个阶段，**不要跨阶段直接比较分数**。

| bundle | 何时 | 任务格式 | 模型 | 可评分格 | 胜率 | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `docs/reference-run/` | v0.2 末期 | `rush-v1`：单条 `exit` 约束 | gemini-3-flash-preview | 13 / 55 | 30.8% [12.7, 57.6] | 主参考；证明管线可用，并暴露 42/55 是基础设施失败 |
| `docs/preliminary-run/` | v0.3 早期 | `rush-v1` | glm-5.3-flash / agent2api-auto | 2 + 10 / 24 | 100% / 80% | 第一份跨模型数据；两个 CI 重叠，`stats-report` 判 `underpowered` |

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
node scripts/verify.mjs docs/preliminary-run
node scripts/stats-report.mjs docs/reference-run    # 功效判定：underpowered
node scripts/behavior-report.mjs docs/reference-run # 浪费率 / 效率
node scripts/reproduce.mjs                          # 一键离线自洽（4 项）
```

## 结论的强度

- `reference-run`：**不能**支持任何跨模型或深度结论（1 个模型、13 格、
  检测 30pp 需每组 42 格）。
- `preliminary-run`：两个模型的 CI 重叠（[49,94] vs [34,100]），Holm 校正后
  p=0.49，**不显著**。它说明管线能同时跑两个族，不说明谁更强。

需要 ≥42 格/组才能谈 30 个百分点的差异。这是 `scripts/stats-report.mjs` 算出来的
数字，不是估计。
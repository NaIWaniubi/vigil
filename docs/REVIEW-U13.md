# U13：产品经理 + 内测者集群的意见汇总与优化方案

三个评审角色跑了一遍仓库（新人 PM、定位 PM、敌意验证者）。下面是**原始意见 → 判定 → 处置**，
按杀伤力排序。每条都能用一条命令复现或验证。

## 一、被证伪的（已修，带回归测试）

| # | 意见 | 证据 | 处置 |
| --- | --- | --- | --- |
| 1 | **输的模型可以把自己从分母里删掉**：`set` 路径通过 `genericWrites` 前缀但含空段/`__proto__` 时，`World.step` 抛异常；cluster 记为 `status=error`，而聚合器**排除** error | 构造 `{"action":{"type":"set","args":{"path":"alpha.","value":1}}}` → `ExprError: bad path` 抛出 | `engine/world.mjs` 捕获 `ExprError` 转为 `{ok:false}`；2 个回归测试（不抛、不胜利、动作被记录、世界存活） |
| 2 | **harbor 导出泄漏答案**：`meta.oracleSteps` 出现在 **84/214** 个 agent 视图 | `grep -rIl oracleSteps .../environment/task.json \| wc -l` → 84 | `agentView` 改为**按族白名单** meta，未来新增字段默认不泄漏；回归测试遍历全部导出 |
| 3 | **"篡改任意字节 → exit 1" 对 MANIFEST 本身不成立**：把双空格改成单空格，校验仍 PASS | `sed -i '1s/  / /'` → `VERIFY: PASS` | `verify.mjs` 严格解析 `--write` 产出的两空格格式、拒绝重复与首尾空白；同一篡改现在 exit 1 |
| 4 | **`cross-model --check` 只比 `.arms`**，新增顶层字段照样 PASS | 加一个字段 → `RESULT: PASS` | 改为整文档比较（排除 `generatedAt`） |
| 5 | **`ageInSteps` 出现 -1**：揭示进下一步的约束算出负数 | exhibit 里 `revealed ... age -1` | `Math.max(0, ...)`；回归测试 |
| 6 | **引擎承诺"非法动作永不崩溃"**，实际会抛 | 同 #1 | 同 #1 |

## 二、阻断采用的（已补）

| # | 意见 | 证据 | 处置 |
| --- | --- | --- | --- |
| 7 | **无法指向自己的模型**：没有 `--base-url`，`CHANNELS` 是字面量数组，新模型名还会被价格闸门拒绝 | `node runner.mjs --base-url ...` → `unknown arg`；`no price for model ... refusing to spend` | 新增 **env 定义通道**（`VIGIL_BASE_URL/VIGIL_MODELS/VIGIL_PROTOCOL/VIGIL_MAX_TOKENS`）与 **operator 价格**（`VIGIL_PRICE_IN/OUT`，支持按模型）；`docs/BRING-YOUR-OWN-MODEL.md`；`--help` 里写明 |
| 8 | **没有 5 分钟路径**：README 第一条命令是 2.5 分钟的 gate，`reproduce` 根本没提 | 新人实测：严格照 README 2.7 分钟拿到的是 dry-run 的 0.0%；拿到可引用数字要 7.4 分钟 / 19 条命令 | README 顶部改 5 步 Quickstart：reproduce(2s) → 唯一可引用数字(30.8%) → 零花费任务 → 自带模型 → 其余 |
| 9 | **`--family rush` 不在 help 里**，而它是旗舰族 | `--help` 写 `core\|swe\|both`，代码接受 `rush` | help 与 README 示例都补上 |
| 10 | **公榜违反自己的分层规则**：页面上是 relay 结果，却没有任何 tier 标注 | `registry.mjs` 写"主榜只收 official"；`web/index.html` 无 tier | 页面新增 **tier banner**：非 official 时明确写"不是官方主榜，仅彼此可比" |
| 11 | **`.gitignore` 的隐私保护在仓库外**：靠作者的全局 ignore 生效，协作者克隆后不生效 | `git check-ignore -v` 指向 `C:\Users\chen/.config/git/ignore` | 仓库 `.gitignore` 增加 `*.local.md` / `.submission.local.md`，并删掉失效的 `tmp/.submission.local.md` |

## 三、被指出"宣称 > 证据"的（已补证据）

| # | 意见 | 证据 | 处置 |
| --- | --- | --- | --- |
| 12 | **"六类归因"没有任何已提交产物支撑**：所有 bundle 只出现 `neglected` / `regressed` | `docs/reference-run` 765 条记录全是 `exit` 一条约束；`powered-run` 同样 | 新增 `scripts/attribution-exhibit.mjs`：逐类构造一条最小任务，产出六类完整记录 → `docs/attribution-exhibit.json`，由 `reproduce` 第 8 项校验。**明确标注这是机制演示，不是模型跑分**，并说明 `collateral` 需要聚合态约束、现有生成器不构造 |
| 13 | **自审检查数三处不一致**（四项/五项/六项） | `FOR-SOTALAB.md` 四项、`REPORT.en.md` 五项、`SELF-AUDIT.md` 六行、脚本注释四项 | 统一为**六项条件检查**，脚本头注释列出全部并标明条件启用 |
| 14 | **模型 id 与机器记录不符**：手写表写 `deepseek-v4.1-flash-1017`，`protocol.json` 记录的是 `apigoto-api-apigoto-com/deepseek-flash` | 两处对比 | 手写表改用记录值 |
| 15 | **README 把不可复现的 80% 当事实** | `REPORT.en.md` 承认"无法从本仓库复现" | README 该句补同一句 caveat |
| 16 | **深度标签错位**：写成 "depth 13–16"，实际最深是 depth 17，13–16 无样本 | 重算 gemini 可评分格深度 → `{8:6, 9:6, 17:1}` | 改为 "16+" |

## 四、评审之间的一致意见（下一轮要做的）

三位评审独立指向同一件事：**缺一条"别人能提交成绩"的路**。

1. **提交路径**：`results.jsonl` → `verify` → PR → 重生成榜单与 `CROSS-MODEL.md`，tier 规则在页面上强制。
2. **深度 ≥13 的矩阵**：当前 12/13 个可评分格都在 depth 8–9，"long-horizon" 的定位与数据不符——要么补矩阵，要么改措辞。
3. **任务作者指南**：`docs/AUTHORING.md`（约束 AST + 一个完整示例），否则只有作者能扩展。

## 验证

```bash
node scripts/reproduce.mjs   # 8 checks, all PASS
node scripts/gate.mjs        # GATE: PASS
node --test test/*.test.mjs  # 161 tests
```

## 这步的边界

- 第 12 条补的是**机制演示**，不是能力数据。它证明分类器能产出六类，不证明任何模型会触发它们。
- 第 8 条把首次上手压到 ~2 秒（reproduce）与 ~30 秒（可引用数字），但**拿到自己模型的真实成绩仍需一次 live 调用**，那是分钟级、要花钱的。
- 第四节的三项**没有做**：提交路径、深度矩阵、作者指南。它们各自是一个独立切片，不是文档补丁。

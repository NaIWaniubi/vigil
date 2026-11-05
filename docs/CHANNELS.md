# 通道需求清单

VIGIL 对模型通道的要求，以及当前实测可用情况。

生成时间：2026-11-05 · 探针：`node scripts/probe-live.mjs`

---

## 1. 技术要求（协议契约）

| 项 | 要求 | 为什么 |
| --- | --- | --- |
| 协议 | OpenAI `/chat/completions` 或 Anthropic `/v1/messages` | `providers/protocols.mjs` 已实现两种适配器 |
| 温度 | 支持 `temperature=0`；个别模型只收 1（已在 registry 按通道钉死） | 排出随机性，结果才可比 |
| 上下文 | ≥32k；开 `--history-window 3` 后 ≥8k 即可 | 每轮重渲染棋盘/状态/约束 |
| `max_tokens` | ≥4096；推理型 ≥16384 | 否则整轮被 `finish_reason=length` 截断，测的是上限不是能力 |
| 工具调用 | 不需要 | 动作面是纯 JSON 文本 |
| 流式 | 不需要 | 非流式聚合即可 |
| **提示词缓存** | **强烈建议** | 实测缓存命中 88–95%，是成本可承受的前提 |
| 延迟 | <10s/call 为宜 | 每格 50–90 轮 |
| 余额 | 需足够跑满一轮 | 官方 deepseek 曾在 run 中途 402 |

## 2. 模型选择（按优先级）

| 优先 | 模型 | 理由 |
| --- | --- | --- |
| **P0** | DeepSeek V4 Flash（官方） | 最便宜、支持缓存、输出简洁（84 tok/call）、延迟低 |
| **P0** | Qwen 3.8 Max / Flash（官方或 OpenCSG） | 与 DeepSeek 不同族；Flash 版本 2s 级 |
| **P1** | GLM-5.3 / 5.3-Flash（智谱官方 anthropic 端点） | 第三族；Flash 便宜 |
| **P1** | Gemini 3 Flash | 不同族（Google），但 relay 侧常被下架 |
| **P2** | MiniMax M3 / Kimi K3 | 补族；Kimi 要求 `temperature=1` |
| **不建议** | 长思考型推理模型（如 v4-pro） | 单轮输出 7k+ token，成本被输出吃掉 88× |

**为什么至少要 3 个族**：跨模型排名需要区分度。单模型只能出「深度曲线」，
不能出「谁更强」。两个模型只能出一次对比，无法判断是模型差异还是噪声。

## 3. 当前实测（2026-11-05）

`scripts/probe-live.mjs` 探了 **120 个 (端点, 模型) 组合**，**6 个能答话**：

| 延迟 | 模型 | 通道 |
| --- | --- | --- |
| 3.2s | `agent2api/auto` | magpie (127.0.0.1:3425) |
| 6.9s | `glm-5.3-flash` | Agent2API (127.0.0.1:3065) |
| 12.9s | `gpt-6-luna` | Agent2API |
| 18.9s | `tierflow_pro` | TierFlow (127.0.0.1:4100) |
| 23.0s | `agent2api/deepseek-v4-flash` | magpie |
| 23.1s | `agent2api/MiniMax-M3.1-Flash` | magpie |

失败分布：**97× fetch failed**（本地反代端口已死）、8× 超时、6× 返回空内容、
1× 404（模型被下架）、1× 503。

**通道不稳定是实证的**：`gemini-3-flash-preview` 在 v8 里跑了 55 格，
一天后 404「模型不存在: gemini-」。

## 4. 需要提供什么

**最小可发布配置（1 个族）**：一个稳定、有余额、支持缓存的官方通道。
建议 DeepSeek 官方 —— 最便宜，且实测 88% 缓存命中。

**可做跨模型排名（3 个族）**：
1. DeepSeek 官方（余额）
2. 阿里云百炼 / OpenCSG 的 Qwen 3.8
3. 智谱官方 GLM-5.3（anthropic 端点）

填进 env 即可，无需改代码：

```bash
export DEEPSEEK_API_KEY=...
export SENSENOVA_API_KEY=...      # 或 OPENCSG 走本地网关
export BIGMODEL_API_KEY=...
node scripts/probe-live.mjs       # 先确认谁活着
node scripts/cluster.mjs --models deepseek:deepseek-chat,bigmodel:glm-5.3-flash ...
```

## 5. 预算（按 depth 分层采样）

| 目标 | 规模 | 估算 |
| --- | --- | --- |
| 单模型深度曲线（最小可发布证据） | 88 格 | **$3–12** |
| 三模型跨模型对比 | 264 格 | **$9–40** |
| 三模型 × 三义务消融 | 792 格 | **$25–110** |
| 全量 130 题 × 3 模型 × 3 义务 × 2 rep | 2340 格 | **$70–330** |

区间下沿按 `--history-window 3` + 简洁输出模型，上沿按全量历史 +  verbose 模型。

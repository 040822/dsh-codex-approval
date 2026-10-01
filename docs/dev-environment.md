# 本地部署环境说明

本文记录**特定部署**才需要关心的内容：本机 provider 通道的补丁依赖，以及判定模型默认值的由来。通用安装不需要读本文。

## 判定模型为何默认走 `cpa-wx301`

默认判定模型原为 `opencode-go / deepseek-v4-flash`。OpenCode Go 订阅到期后该路由返回 `401 CreditsError`，会让 AI 审判层整体退化到 `failOpen`（等于每次审批都交人类）。现在默认改走本机 CLIProxyAPI（`cpa-wx301`）的 Command Code 通道，并以 DeepSeek 官方 API（`deepseek-official`）作为兜底。

上游订阅到期后，`cpa-wx301` 上的 `opencode/*` 模型同样因渠道 `auth_unavailable` 不可用；`ai.fallbacks` 因此默认选 DeepSeek 官方 API（`deepseek-official`，即 DSH 原生 `llm-deepseek` 适配器，走 `DEEPSEEK_API_KEY`），与主模型同属 DeepSeek V4.x 家族但路由独立。

## `opencode-go` 的会话头补丁

若使用 `opencode-go` 作为判定 provider，DSH 0.1.2-rc.1 的 `dsh-llm-pi-ai` 安装产物还需要应用工作区中的补丁：

```
patches/dsh-llm-pi-ai-opencode-session.patch
```

它让 `opencode-go` 请求把每个会话的 `sessionId` 映射为动态 `x-opencode-session` 头——该 provider 依赖这个头做前缀缓存。

- 该补丁**不影响**其他 provider
- 全局 npm / npx 重装 DSH 后需要**重新应用**

插件侧已把 `sessionId` 透传到 LLM 调用（`judgeWith` → `llmRunner` → `prepared.stream`），补丁只负责把它变成 provider 认识的头部。

## 排查

判定失败时先看 `~/.dsh/logs/approval.jsonl` 的 `failure.code`：

| code | 方向 |
|---|---|
| `AUTH` | 鉴权 / 密钥（订阅到期常见 `CreditsError`、`auth_unavailable`） |
| `RATE_LIMIT` / `QUOTA_EXCEEDED` | 限流 / 额度 |
| `TIMEOUT` | 超时（调大 `ai.timeoutMs` 或换更快的模型） |

若日志里大量出现 `unparseable judge output (empty reply)` 且**没有** `judgeAttempts` 字段，说明该记录来自 v0.4.4 之前的版本（当时空回复会被误判为"成功的判定尝试"，导致 `fallbacks` 不被使用）。升级到 v0.4.4 及以上即可。

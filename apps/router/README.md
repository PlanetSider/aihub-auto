# aihub-auto router

AIHub(sub2api)OpenAI 自动路由反代。本地代理按价格、官网真实用户平均 TTFT、标准化云端探测、本机实时 TTFT/错误率选择分组;新会话动态均衡,已有会话固定回到原组保留 prompt cache,故障时只迁移失败会话。

## 快速开始

1. 从 [Releases](https://github.com/WSXYT/aihub-auto/releases/latest) 下载对应平台压缩包并解压
2. 运行 `aihub-auto`(Windows 双击 `aihub-auto.exe`)
3. 打开控制台 <http://127.0.0.1:8787/ui>,登录 AIHub 账号(或直接粘贴 token)
4. 把你的客户端指向本地代理:

```bash
# OpenAI 系(Codex CLI、OpenAI SDK 等)
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="anything"          # 本地代理自动注入真实 Key,这里随便填
```

之后一切照旧——代理在幕后持续选择最优分组。

## 策略

| 模式 | 选择规则 |
| --- | --- |
| 省钱优先 economy | 从最低健康价格层选择;更高健康层保持可用待命,当前层故障/过慢/不稳定时才升档 |
| 均衡 balanced(默认) | 对数价格 0.5 + 对数保守延迟 0.5,保持稳定的几何折中 |
| 速度优先 speed | 对数价格 0.2 + 对数保守延迟 0.8,更早使用快速组 |

价格区间硬约束默认 `0 ~ 0.15x`;省钱健康门槛默认是最近至少 3 条结果后成功率不低于 80%、保守 TTFT 不超过 20 秒。已有最近结果但成功率为 0% 的组立即视为不稳定,不会显示为可用升档。官网真实用户均值与云端探测先做几何融合,再按本地置信度融合本机 Peak/P90;缺失或 0 值来源不参与,旧 usage-stats 只作为用户均值回退,不会重复计权。倍率区间、健康门槛和黑名单都可在控制台热调整。已有连续会话仍回到其原分组,不会为了降价破坏上游会话状态。

## 手动锁定与 User-Agent

候选分组表的“锁定”按钮可将一个组持续设为新请求首选,状态跨重启保留,顶部状态带可一键解除。锁定不会破坏已有显式会话、conversation、`previous_response_id` 或热缓存亲和;锁组遇到 TTFB 超时、429/5xx、模型不兼容或熔断时,当前请求临时换组,恢复后锁定继续生效。economy 的过慢/稳定率软门槛可手动覆盖,账号不可用、倍率区间、黑名单、无效延迟和硬错误率不能绕过。

控制台“上游 User-Agent”可覆盖发往模型 API 的请求头,对初次请求和故障重试都生效。留空时原样保留客户端 UA;它不会修改 AIHub 登录、Key 管理等控制 API 的产品标识。

三种模式的静态评分使用统一对数效用,请求调度在 `poolMaxGroups` 内让静态最优组与会话稳定挑战者比较。负载按 `score - latencyWeight * ln(pending + 1)` 连续惩罚,不会再因固定分数窗口丢掉健康容量。

## Key 模式

- **pool(默认)**:按需为每个使用中的组创建 `aihub-auto-g{组id}` Key。新会话用 P2C + Peak EWMA 在当前价格层内分配,已有会话保持组亲和;一个组可同时承载多个请求,同组并发创建 Key 只发一次管理请求。会话映射保留 24 小时,但 Key 只在最近缓存窗口(默认 5 分钟)受亲和保护;之后可由普通 LRU 回收,续接时按原组重建。多个实例共享账号时不会互删未知自动 Key;上游 401 会使失效的 managed Key 原子作废、同组重建并重试。超倍率、用户黑名单、账号不可用、延迟无效、近 3 小时稳定率过低或已不在最新统计中的闲置组可强制回收。当前组、创建中、预留中、在飞组始终受保护。**绝不触碰手动创建的 Key**
- **single(兼容)**:使用现有的一把 Key,切组 = `PUT /api/v1/keys/{id}`。代理流与控制面切组共享 FIFO 租约,长流结束前不会中途改 Key 分组;上游单 Key 的全局语义仍无法像 pool 一样并行使用不同组,仅供账号不能自动创建 Key 时使用。

## 为什么比 AIHubRouter 好

| | AIHubRouter | aihub-auto |
| --- | --- | --- |
| 数据 | 只有公开均值 | 官网真实用户 + 云端探测 + 本机 TTFT/错误率三源融合 |
| 故障 | 无感知 | 请求内换组重试(未回包前),熔断指数退避 |
| 缓存 | 固定粘性 | 会话级组亲和;控制面优化不会迁移热会话 |
| 执行 | 仅 PUT 切组 | 自动 Key 池 + 请求本地 P2C/Peak-EWMA;single 兼容模式 |

算法细节见 [`packages/core/ALGORITHM.md`](../../packages/core/ALGORITHM.md)。

## 配置

配置目录:Windows `%LocalAppData%\aihub-auto`,Linux `~/.config/aihub-auto`,macOS `~/Library/Application Support/aihub-auto`。`config.json` 支持:

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://aihub.top` | 站点地址(usage-stats 是 aihub 自有接口,不兼容其他站) |
| `upstreamUserAgent` | 空 | 模型代理请求的自定义 UA;空值沿用客户端 UA,可在控制台热更新 |
| `listen.host` / `listen.port` | `127.0.0.1` / `8787` | 监听地址,可改 `0.0.0.0` |
| `mode` | `balanced` | economy / balanced / speed |
| `priceBand.min/max` | 0 / 0.15 | 倍率硬约束 |
| `economyPolicy.minSuccessRate` | 0.8 | 省钱模式最低 3 小时成功率 |
| `economyPolicy.minOutcomeSamples` | 3 | 启用成功率门槛前的最少结果数 |
| `economyPolicy.maxConservativeLatencyMs` | 20000 | 省钱模式最大保守 TTFT |
| `keyMode` | `pool` | pool / single;启动级配置,修改后需重启 |
| `poolMaxGroups` | 4 | 新会话参与均衡的候选/池目标数;安全条件不满足时允许软超限;修改后需重启 |
| `sessionTtlMs` | 86400000 | 会话与模型能力记录保留时间 |
| `sessionMaxEntries` | 10000 | 会话记录上限 |
| `pollIntervalMs` | 60000 | 路由轮询间隔 |
| `proxyToken` | 无 | 反代访问口令;**监听非 127.0.0.1 时必填** |
| `uiPassword` | 无 | 控制台口令;**监听非 127.0.0.1 时必填** |
| `decision.*` | 见 ALGORITHM.md | 粘性/缓存惩罚/空闲阈值/最短驻留 |
| `auditLog` | false | JSONL 决策审计(含每轮全部候选得分) |
| `logLevel` | `info` | `app.log` 最低日志级别:debug / info / warn / error |

## 安全边界

- 默认仅监听 127.0.0.1,凭据仅存本机(POSIX 下 0600),日志脱敏;`/ctl/status` 只返回 Key 元数据,不返回 `sk`
- 配置目录内 `app.log` 默认记录运行日志(5 MiB × 当前+3 个历史),`crash.log` 记录生命周期和未处理异常(1 MiB × 当前+3 个历史)。直接双击 Windows EXE 使用 `%LocalAppData%\\aihub-auto`;通过 `AIHUB_AUTO_CONFIG_DIR` 可显式指定其他目录
- 监听 `0.0.0.0` 时强制要求 `proxyToken` + `uiPassword`,否则拒绝启动(防止别人烧你的额度);客户端此时用 `OPENAI_API_KEY=<proxyToken>` 访问
- 无 TLS:公网部署建议前置反代(Caddy/Nginx)或仅在可信内网使用

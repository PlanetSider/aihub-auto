# aihub-auto router

AIHub(sub2api)OpenAI 自动路由反代。本地代理按价格、公开统计和本机实时 TTFT/错误率选择分组;新会话动态均衡,已有会话固定回到原组保留 prompt cache,故障时只迁移失败会话。

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
| 省钱优先 economy | 新会话只在最低有效倍率层内按延迟和负载选择;该层不可用时才升到下一档 |
| 均衡 balanced(默认) | 价格 0.5 + 速度 0.5 加权 |
| 速度优先 speed | 价格 0.2 + 速度 0.8 加权 |

价格区间硬约束默认 `0 ~ 0.15x`,黑名单分组永不参与,可在控制台热调整。已有连续会话仍回到其原分组,不会为了降价破坏上游会话状态。

## Key 模式

- **pool(默认)**:按需为每个使用中的组创建 `aihub-auto-g{组id}` Key。新会话用 P2C + Peak EWMA 在近优候选中分配,已有会话保持组亲和;同组并发创建只发一次请求。普通 LRU 只收缩超出 `poolMaxGroups` 的闲置 Key;但超倍率、黑名单、账号不可用、延迟无效、近 3 小时稳定率过低或已不在最新统计中的闲置组会在缓存宽限期后强制回收,并清理其会话/Responses 亲和。当前组、创建中、预留中、在飞组始终受保护。**绝不触碰手动创建的 Key**
- **single(兼容)**:使用现有的一把 Key,切组 = `PUT /api/v1/keys/{id}`。上游单 Key 的全局切组语义无法隔离并发会话,仅供账号不能自动创建 Key 时使用。

## 为什么比 AIHubRouter 好

| | AIHubRouter | aihub-auto |
| --- | --- | --- |
| 数据 | 只有公开均值 | 公开统计 + 你自己流量的实测 TTFT/错误率融合 |
| 故障 | 无感知 | 请求内换组重试(未回包前),熔断指数退避 |
| 缓存 | 固定粘性 | 会话级组亲和;控制面优化不会迁移热会话 |
| 执行 | 仅 PUT 切组 | 自动 Key 池 + 请求本地 P2C/Peak-EWMA;single 兼容模式 |

算法细节见 [`packages/core/ALGORITHM.md`](../../packages/core/ALGORITHM.md)。

## 配置

配置目录:Windows `%LocalAppData%\aihub-auto`,Linux `~/.config/aihub-auto`,macOS `~/Library/Application Support/aihub-auto`。`config.json` 支持:

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://aihub.top` | 站点地址(usage-stats 是 aihub 自有接口,不兼容其他站) |
| `listen.host` / `listen.port` | `127.0.0.1` / `8787` | 监听地址,可改 `0.0.0.0` |
| `mode` | `balanced` | economy / balanced / speed |
| `priceBand.min/max` | 0 / 0.15 | 倍率硬约束 |
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

# aihub-auto router

AIHub(sub2api)最优分组自动路由反代。本地起一个 HTTP 代理,把 OpenAI / Anthropic 流量转发到 aihub.top,自动选择当前最优分组,故障时秒级转移,并且**懂缓存**——不会为了蝇头小利频繁切组害你丢 prompt cache。

## 快速开始

1. 从 [Releases](https://github.com/WSXYT/aihub-auto/releases/latest) 下载对应平台压缩包并解压
2. 运行 `aihub-auto`(Windows 双击 `aihub-auto.exe`)
3. 打开控制台 <http://127.0.0.1:8787/ui>,登录 AIHub 账号(或直接粘贴 token)
4. 把你的客户端指向本地代理:

```bash
# OpenAI 系(Codex CLI、openai SDK…)
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="anything"          # 本地代理自动注入真实 Key,这里随便填

# Anthropic 系(Claude Code…)
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="anything"
```

之后一切照旧——代理在幕后持续选择最优分组。

## 策略

| 模式 | 价格权重 | 速度权重 |
| --- | ---: | ---: |
| 省钱优先 economy | 0.8 | 0.2 |
| 均衡 balanced(默认) | 0.5 | 0.5 |
| 速度优先 speed | 0.2 | 0.8 |

价格区间硬约束默认 `0 ~ 0.15x`,黑名单分组永不参与。全部可在控制台热调整。

## Key 模式

- **single(默认)**:用你现有的一把 Key,切组 = `PUT /api/v1/keys/{id}`(同 AIHub 网页操作)
- **pool(推荐)**:每个候选组自动创建 `aihub-auto-g{组id}` 命名的 Key,切换 = 换 Key,毫秒级、各组缓存互不干扰;LRU 自动删除多余 Key(默认保留 4 组),启动时回收孤儿。**绝不触碰你手动创建的 Key**

## 为什么比 AIHubRouter 好

| | AIHubRouter | aihub-auto |
| --- | --- | --- |
| 数据 | 只有公开均值 | 公开统计 + 你自己流量的实测 TTFT/错误率融合 |
| 故障 | 无感知 | 请求内换组重试(未回包前),熔断指数退避 |
| 缓存 | 固定粘性 | 流量感知切换成本:活跃期抬高门槛,空闲窗口兑现挂起的切换 |
| 执行 | 仅 PUT 切组 | PUT 切组 或 Key 池毫秒切换 |

算法细节见 [`packages/core/ALGORITHM.md`](../../packages/core/ALGORITHM.md)。

## 配置

配置目录:Windows `%LocalAppData%\aihub-auto`,Linux `~/.config/aihub-auto`,macOS `~/Library/Application Support/aihub-auto`。`config.json` 支持:

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://aihub.top` | 站点地址(usage-stats 是 aihub 自有接口,不兼容其他站) |
| `listen.host` / `listen.port` | `127.0.0.1` / `8787` | 监听地址,可改 `0.0.0.0` |
| `mode` | `balanced` | economy / balanced / speed |
| `priceBand.min/max` | 0 / 0.15 | 倍率硬约束 |
| `keyMode` | `single` | single / pool |
| `poolMaxGroups` | 4 | 池保留组数 |
| `pollIntervalMs` | 60000 | 路由轮询间隔 |
| `proxyToken` | 无 | 反代访问口令;**监听非 127.0.0.1 时必填** |
| `uiPassword` | 无 | 控制台口令;**监听非 127.0.0.1 时必填** |
| `decision.*` | 见 ALGORITHM.md | 粘性/缓存惩罚/空闲阈值/最短驻留 |
| `auditLog` | false | JSONL 决策审计(含每轮全部候选得分) |

## 安全边界

- 默认仅监听 127.0.0.1,凭据仅存本机(POSIX 下 0600),日志脱敏,不回显 token
- 监听 `0.0.0.0` 时强制要求 `proxyToken` + `uiPassword`,否则拒绝启动(防止别人烧你的额度);客户端此时用 `OPENAI_API_KEY=<proxyToken>` 访问
- 无 TLS:公网部署建议前置反代(Caddy/Nginx)或仅在可信内网使用

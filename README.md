# aihub-auto

让 OpenAI 兼容客户端通过本地地址使用 [AIHub](https://aihub.top)，并自动选择合适分组的跨平台反向代理。

它适合已经有 AIHub 账号、希望减少手动切组，同时保留连续对话缓存的人。启动后，客户端只需要访问本机 `http://127.0.0.1:8787/v1`；登录、Key 创建、分组选择、故障转移和运行日志由 aihub-auto 在本机处理。

> 仅支持 AIHub 的公开分组统计和 API，不是适配任意 OpenAI 兼容站点的通用代理。

## 五分钟开始

1. 从 [Releases](https://github.com/WSXYT/aihub-auto/releases/latest) 下载与你的系统和 CPU 架构匹配的压缩包并解压。
2. 启动程序：Windows 双击 `aihub-auto.exe`；Linux/macOS 在终端运行 `./aihub-auto`。首次启动无需手工创建配置文件。
3. 打开 <http://127.0.0.1:8787/ui>，登录 AIHub 账号或粘贴 Access Token。
4. 将你的 OpenAI 兼容客户端指向本地代理：

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="local-proxy"
```

`OPENAI_API_KEY` 在本机默认可以是任意非空值；代理会使用你在控制台登录的 AIHub 凭据。客户端已经设置过 `OPENAI_BASE_URL` 时，只需替换成上面的本地地址后照常使用。

需要修改本次启动的监听端口时，可以使用环境变量或命令行参数：

```bash
AIHUB_AUTO_PORT=9000 ./aihub-auto
./aihub-auto --port 9000
```

端口优先级为 `--port` > `AIHUB_AUTO_PORT` > `config.json` 中的
`listen.port` > 默认值 `8787`。命令行和环境变量只覆盖本次启动，不会写回
`config.json`。运行 `./aihub-auto --help` 可查看启动参数。

启动后可访问：

| 地址 | 用途 |
| --- | --- |
| <http://127.0.0.1:8787/ui> | 登录、配置和实时运维控制台 |
| <http://127.0.0.1:8787/healthz> | 存活检查 |
| <http://127.0.0.1:8787/v1/models> | 验证客户端可通过代理读取模型 |
| <http://127.0.0.1:8787/v1> | 本地 API 状态响应，不会转发到上游 |

## 日常使用

通常只需要在控制台完成三件事：

1. **登录 AIHub**：代理保存凭据在本机配置目录，不会把 Key 返回给控制台接口或写入普通日志。
2. **选择策略**：默认“均衡”；想控制成本可选“省钱”，优先速度可选“速度”。
3. **让客户端持续使用本机 `/v1` 地址**：会话、Responses 对话链和稳定提示前缀会保持同组亲和，避免每个请求重新切组。

控制台会显示当前价格层、待命升档层、熔断/黑名单/延迟等排除原因、本地与云端 TTFT、近 3 小时稳定率、会话数量、在飞请求及 Key 池状态。运行中的配置可直接保存；`keyMode` 和 `poolMaxGroups` 属于启动级配置，修改后重启生效。

## 路由策略

| 模式 | 行为 |
| --- | --- |
| `economy` 省钱 | 只在最低健康倍率层为新会话选组；高价健康层留作故障或健康退化时的升档候选 |
| `balanced` 均衡 | 综合价格与首字延迟，默认模式 |
| `speed` 速度 | 更重视首字延迟 |

省钱模式的默认健康门槛为：最近 3 小时至少 3 条结果后成功率不低于 80%，保守 TTFT 不超过 20 秒。已有结果且成功率为 0% 的组会立即视为不稳定，不能显示为可用升档；没有本地结果时则只采用云端 TTFT 先验，不把“无数据”误当成失败。

所有模式都遵守倍率区间、账号可用性、模型能力、用户黑名单和熔断状态。请求在首字节前遇到上游 429、5xx 或超时时可换组重试；一旦开始回传内容，绝不透明重放，避免重复输出和计费。

## Key 模式

- **`pool`（默认）**：按需创建并复用 `aihub-auto-g{groupId}` Key。新会话在当前候选层内动态均衡，已绑定会话保持原组。默认目标池大小为 4，短缓存窗口外的空闲 Key 可以回收；不会触碰手动创建的 Key。
- **`single`（兼容模式）**：复用已有的一把 Key，通过上游切组。因为上游的单 Key 切组是全局行为，无法安全隔离高并发会话，仅适用于不能创建自动 Key 的账号。

## 配置、日志与安全

配置和日志目录：

| 系统 | 目录 |
| --- | --- |
| Windows | `%LocalAppData%\\aihub-auto` |
| Linux | `~/.config/aihub-auto` |
| macOS | `~/Library/Application Support/aihub-auto` |

其中 `config.json` 保存路由配置和会话状态，`app.log` 记录脱敏运行日志，`crash.log` 记录启动、退出和异常事件，均会自动轮转。可通过 `AIHUB_AUTO_CONFIG_DIR` 指定其他目录。

默认只监听 `127.0.0.1`。如需监听局域网地址，必须设置 `proxyToken` 和 `uiPassword`；客户端随后以 `OPENAI_API_KEY=<proxyToken>` 访问代理。公网部署应在可信反向代理和 TLS 后运行。

完整配置项、池回收规则和安全边界见 [router 使用说明](apps/router/README.md)。

Linux x64 发行包使用 Bun 的 baseline CPU 目标，以兼容不支持 AVX2 的较旧
x86-64 处理器；Linux 用户态兼容性的实测边界见仓库安全审计报告。

## Koishi 查询插件

[`koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto) 是独立的只读推荐插件，不会操作路由器或 AIHub Key：

```bash
npm i koishi-plugin-aihub-auto
```

- `最优分组`：返回 1 到 6 个接近最佳的公开统计候选。
- `最烂分组`：固定返回 1 个候选，先取最高有效倍率层，再取该层保守首字延迟最高的分组。

详细配置和群聊触发范围见 [插件说明](packages/koishi-plugin-aihub-auto/README.md)。

## 项目结构

| 目录 | 说明 |
| --- | --- |
| [`apps/router`](apps/router) | 跨平台单文件反代、自动 Key 池、会话亲和、请求内故障转移和 Web 控制台 |
| [`packages/koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto) | Koishi 最优/最烂分组查询插件 |
| [`packages/core`](packages/core) | 共享评分、决策、熔断和本地观测核心，无运行时依赖 |

## 开发

```bash
bun install
bun run check        # 全部测试和类型检查
bun scripts/build.ts # 构建六个目标到 artifacts/
```

算法、并发语义和故障转移细节见 [核心算法说明](packages/core/ALGORITHM.md)。

# aihub-auto

`aihub-auto` 是面向 [AIHub](https://aihub.top) 的本地 OpenAI 兼容反向代理。客户端固定连接本机地址，路由器负责 AIHub 登录、Key 管理、分组选择、会话亲和、故障转移和运行观测。

项目提供两种主要运行形态：

- **桌面应用**：Tauri 2 原生外壳负责启动内置路由器、显示 Web 控制台、托盘驻留、自启动和签名更新。
- **Headless 路由器**：Bun 编译的单文件程序，不依赖桌面环境，适合服务器、终端或由外部进程管理器托管。

> 本项目使用 AIHub 专有的公开分组统计和账号 API，目前仅路由 OpenAI 平台。它不是适配任意 OpenAI 兼容站点的通用代理。

## 仓库与 fork 关系

- 当前仓库：[PlanetSider/aihub-auto](https://github.com/PlanetSider/aihub-auto)
- 上游仓库：[WSXYT/aihub-auto](https://github.com/WSXYT/aihub-auto)

本仓库 fork 自 `WSXYT/aihub-auto`，当前业务代码仍基于上游实现。桌面端的 GitHub 入口、默认更新清单地址、签名公钥以及部分包元数据目前仍指向上游仓库；在当前 fork 发布独立安装包前，应将这些发行配置替换为本仓库自己的地址和签名材料。直接使用现有配置构建的桌面应用会检查上游更新。

## 主要特点

- 本地提供 OpenAI 兼容入口，默认地址为 `http://127.0.0.1:8787/v1`
- 融合官网真实用户 TTFT、云端探测和本机 Peak EWMA/P90 观测
- 支持 `economy`、`balanced`、`speed` 三种路由策略
- 可按 Plus、Pro、Team 套餐、倍率区间和黑名单筛选分组
- 通过显式会话、Responses 对话链、`prompt_cache_key` 和稳定提示前缀保持分组亲和
- 在首字节返回前处理连接失败、TTFB 超时、429、5xx、余额不足、模型不兼容和失效 Key
- 按组熔断并指数退避；响应已经开始后不会透明重放
- 默认使用多 Key 池并发路由，也保留单 Key 全局切组兼容模式
- Web 控制台支持登录、状态查看、手动锁组、策略调整、日志查看和运行诊断
- 支持直连、系统 HTTP(S) 代理或自定义 HTTP(S) 出站代理
- 配置、凭据、会话摘要、熔断状态和本地观测都保存在运行机器上

## 快速使用

### 1. 启动路由器

使用桌面包时，启动 `aihub-auto` 桌面应用即可。桌面壳会拉起内置路由器，健康检查通过后打开控制台；关闭窗口只会隐藏到托盘，选择托盘中的“退出”才会停止路由器。

使用 headless 包时，解压后直接运行：

```bash
./aihub-auto
```

Windows 对应程序为：

```powershell
.\aihub-auto.exe
```

### 2. 完成 AIHub 登录

浏览器访问 <http://127.0.0.1:8787/ui>，使用 AIHub 邮箱和密码登录，或粘贴 Access Token。路由器验证账号后才会开始拉取账号可用分组并建立路由。

### 3. 配置 OpenAI 客户端

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="local-proxy"
```

PowerShell：

```powershell
$env:OPENAI_BASE_URL = "http://127.0.0.1:8787/v1"
$env:OPENAI_API_KEY = "local-proxy"
```

默认回环部署没有设置 `proxyToken`，此时客户端 API Key 只需是任意非空值；路由器会移除客户端凭据并注入对应 AIHub 分组的真实 Key。如果部署配置了 `proxyToken`，这里必须填写该 token。

### 4. 验证服务

| 地址 | 作用 |
| --- | --- |
| <http://127.0.0.1:8787/ui> | Web 控制台 |
| <http://127.0.0.1:8787/healthz> | 本地健康检查 |
| <http://127.0.0.1:8787/v1/models> | 通过代理读取模型列表 |
| <http://127.0.0.1:8787/v1> | 本地代理状态，不转发上游 |

## 部署方式

### 桌面部署

桌面端将路由器作为 bundled sidecar 管理，不包含另一套路由实现。

- 正式构建固定使用 `127.0.0.1:8787`
- 开发构建使用 `127.0.0.1:8798`，避免占用正式端口
- 桌面模式强制监听回环地址，不继承 `config.json` 中的局域网监听地址
- 路由器启动失败、端口占用或健康检查失败时显示本地诊断页
- 支持托盘驻留、登录时静默自启动、日志入口和 Tauri 签名更新
- 更新器先读取代码中配置的 GitHub `latest.json`，再依次尝试最多三个自定义 HTTPS 镜像

当前发布流程能够生成：

| 平台 | 桌面产物 |
| --- | --- |
| Windows x64 | NSIS 安装器、免安装桌面 ZIP |
| macOS x64 / arm64 | DMG |
| Ubuntu/Debian x64 | DEB |

这些是 CI 的实际构建目标，不代表仓库已经为所有系统提供了现成安装包。当前 fork 尚未建立独立发布链时，可查看[上游 Releases](https://github.com/WSXYT/aihub-auto/releases/latest)；使用本 fork 自行发布前，请先修改上文提到的仓库地址、更新端点和签名配置。

### Headless 单文件部署

Headless 版本包含路由器和 Web 控制台，不包含原生窗口、托盘和桌面更新器。它适合无桌面服务器、便携运行或自建进程守护。

构建脚本支持以下目标：

- Windows x64
- Linux x64 baseline
- Linux arm64
- macOS x64
- macOS arm64
- Windows arm64：仅在所用 Bun 版本支持该编译目标时生成，否则自动跳过

Linux x64 使用 Bun baseline 目标以降低 CPU 指令集要求；已有审计记录验证 glibc 2.17 和 2.24 用户空间，glibc 2.12 及更早版本不受支持。详细结果见 [安全报告](security_best_practices_report.md)。

指定本次启动端口：

```bash
AIHUB_AUTO_PORT=9000 ./aihub-auto
./aihub-auto --port 9000
./aihub-auto --port=9000
```

端口优先级为：

```text
--port > AIHUB_AUTO_PORT > config.json 中的 listen.port > 8787
```

命令行参数和环境变量只覆盖本次启动，不会写回配置文件。

### Docker / GHCR 部署

每次推送到 `main` 后，[容器工作流](.github/workflows/container.yml)会自动构建 `linux/amd64` 和 `linux/arm64` 镜像，并发布到：

```text
ghcr.io/planetsider/aihub-auto
```

镜像标签规则：

- `main` 推送：`latest`、`main`、`sha-<commit>`
- `v1.2.3` 标签：`1.2.3`、`1.2`、`sha-<commit>`
- Pull Request：只验证多架构构建，不推送镜像

首次发布后，如果 GitHub Package 默认是私有的，需要在仓库的 **Packages → Package settings → Change visibility** 中将其设为 Public，或者在拉取前使用有 `read:packages` 权限的 Token 登录 GHCR。

容器监听 `0.0.0.0:8787`，因此必须显式提供代理口令和控制台密码：

```bash
docker run -d \
  --name aihub-auto \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e AIHUB_AUTO_PROXY_TOKEN='replace-with-at-least-16-characters' \
  -e AIHUB_AUTO_UI_PASSWORD='replace-with-at-least-12-characters' \
  -v ./data:/data \
  ghcr.io/planetsider/aihub-auto:latest
```

这里将端口只映射到宿主机 `127.0.0.1`。如果需要从局域网或公网访问，请阅读下方网络部署说明，并在可信反向代理后提供 TLS。

容器内固定使用 `/data` 保存配置、凭据、状态和日志，并以非 root 用户运行；Compose 会把它直接映射到宿主机的 `AIHUB_AUTO_DATA_DIR`（默认 `./data`），便于查看、备份和迁移。Linux 主机首次部署前建议执行 `mkdir -p data && sudo chown -R 10001:10001 data`，避免容器用户没有写入权限。模型接口需要使用 `AIHUB_AUTO_PROXY_TOKEN` 作为客户端 API Key；打开控制台时则输入 `AIHUB_AUTO_UI_PASSWORD`。

本地构建镜像：

```bash
docker build -t aihub-auto:local .
```

### Docker Compose 部署

仓库提供 [`compose.yaml`](compose.yaml) 和 [`.env.example`](.env.example)。Compose 默认从 GHCR 拉取 `latest` 镜像，将容器 `/data` 直接绑定到项目目录下的 `./data`，并只把服务发布到宿主机 `127.0.0.1:8787`：

```bash
cp .env.example .env
# 编辑 .env，替换两个口令
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f aihub-auto
```

Windows PowerShell 可以使用 `Copy-Item .env.example .env` 复制环境文件。停止服务但保留数据：

```bash
docker compose down
```

升级到最新镜像：

```bash
docker compose pull
docker compose up -d
```

切换版本时，在 `.env` 中设置 `AIHUB_AUTO_IMAGE_TAG`，例如 `1.2.3` 或 `sha-<commit>`，然后重新执行上面的升级命令。数据位于 `.env` 的 `AIHUB_AUTO_DATA_DIR` 指定目录，停止或升级容器不会删除这些文件；如需清空数据，请先停止服务，再明确删除该宿主机目录。

需要从局域网访问时，将 `.env` 中的 `AIHUB_AUTO_BIND` 改为 `0.0.0.0`，并确保 `AIHUB_AUTO_PROXY_TOKEN`、`AIHUB_AUTO_UI_PASSWORD` 使用足够长的随机值；公网场景仍应在可信反向代理后提供 TLS。宿主机端口可通过 `AIHUB_AUTO_PUBLISHED_PORT` 修改，容器内部端口保持为 `8787`。

### 从源码运行

需要 [Bun](https://bun.sh/) 1.3.x：

```bash
git clone https://github.com/PlanetSider/aihub-auto.git
cd aihub-auto
bun install
bun apps/router/src/main.ts
```

开发桌面端还需要 Rust 1.77.2 或更高兼容版本，以及当前平台所需的 Tauri 系统依赖：

```bash
bun run desktop:dev
```

### 局域网或反向代理部署

默认配置只监听 `127.0.0.1`。若要监听 `0.0.0.0` 或其他非回环地址，代码会强制要求同时配置：

- `proxyToken`：至少 16 个字符，保护模型代理接口
- `uiPassword`：至少 12 个字符，保护 `/ctl/*` 控制接口

示例 `config.json`：

```json
{
  "listen": {
    "host": "0.0.0.0",
    "port": 8787
  },
  "proxyToken": "replace-with-a-long-proxy-token",
  "uiPassword": "replace-with-a-console-password",
  "publicOrigin": "https://router.example.com"
}
```

公网使用时必须由可信反向代理提供 TLS，并保留原始 `Host`。`publicOrigin` 必须是唯一对外 HTTP(S) origin，不能包含路径；程序不会信任客户端提供的转发头来推断 origin。

受管环境还可以使用下列环境变量覆盖配置文件中的密钥：

```text
AIHUB_AUTO_HOST
AIHUB_AUTO_PROXY_TOKEN
AIHUB_AUTO_UI_PASSWORD
```

`AIHUB_AUTO_HOST` 用于容器或受管部署覆盖监听地址；端口仍由 `AIHUB_AUTO_PORT` 控制。仓库没有提供 systemd unit 或 Kubernetes 清单，非容器服务器部署需要自行负责进程守护、TLS 和配置目录持久化。

## 配置与数据目录

| 系统 | 默认目录 |
| --- | --- |
| Windows | `%LocalAppData%\aihub-auto` |
| Linux | `~/.config/aihub-auto`，遵循 `XDG_CONFIG_HOME` |
| macOS | `~/Library/Application Support/aihub-auto` |

可使用 `AIHUB_AUTO_CONFIG_DIR` 指定其他目录。主要文件如下：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 用户配置和部署配置 |
| `credentials.json` | AIHub Access Token、Refresh Token 和兼容模式 Key |
| `state.json` | 托管 Key 池、会话摘要、Responses 别名、模型负缓存、熔断和观测状态 |
| `app.log` | 自动轮转的脱敏运行日志 |
| `crash.log` | 启动、退出和未处理异常记录 |
| `audit.jsonl` | 启用 `auditLog` 后的路由决策审计 |

非 Windows 系统上的 JSON 状态文件使用 `0600` 权限写入。会话状态保存的是 SHA-256 摘要，不会保存原始会话 ID 或提示词。

### 常用配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://aihub.top` | AIHub 站点地址；公开统计接口是 AIHub 专有接口 |
| `listen.host` / `listen.port` | `127.0.0.1` / `8787` | Headless 监听地址和端口 |
| `mode` | `balanced` | `economy`、`balanced` 或 `speed` |
| `accountPoolPlans` | `[]` | Plus、Pro、Team 的并集；空数组表示不按套餐名筛选 |
| `priceBand` | `0`～`0.15` | 允许使用的倍率范围；设为 `null` 表示不限制 |
| `keyMode` | `pool` | `pool` 为默认并发模式，`single` 为兼容模式 |
| `poolMaxGroups` | `4` | 新会话参与调度的候选上限和 Key 池目标大小 |
| `sessionTtlMs` | 24 小时 | 会话与模型能力记录保留时间 |
| `pollIntervalMs` | 60 秒 | 后台统计与默认组决策周期 |
| `ttfbTimeoutMs` | 60 秒 | 首字节超时和请求内故障转移门槛 |
| `outboundProxyMode` | `none` | `none`、`system` 或 `custom` |
| `outboundProxyUrl` | 空 | `custom` 模式使用的 HTTP(S) 代理 |
| `updateMirrors` | `[]` | 最多三个桌面更新 HTTPS `latest.json` 镜像 |
| `upstreamUserAgent` | 空 | 空值保留客户端 User-Agent |
| `sentryDsn` | 项目内置公共 DSN | 设为空字符串可禁用后端 Sentry 和反馈入口 |

`mode`、套餐、倍率、健康门槛、User-Agent、出站代理、更新镜像和黑名单可从控制台保存并热更新。`keyMode` 与 `poolMaxGroups` 是启动级配置，需编辑配置文件后重启。

完整字段、池回收规则和网络边界见 [路由器说明](apps/router/README.md)。

## 路由行为

| 模式 | 行为 |
| --- | --- |
| `economy` | 新会话只使用最低健康倍率层；该层不可用时才升档 |
| `balanced` | 对数价格和对数保守延迟等权折中 |
| `speed` | 提高延迟权重，更愿意使用快速的高倍率组 |

已有显式会话、Responses 分支和热提示缓存优先返回原组，不会因为后台排名变化而迁移。新会话会在最多 `poolMaxGroups` 个候选中比较静态分数与实时在飞负载。

默认 `pool` 模式按需创建并复用名为 `aihub-auto-g{groupId}` 的 AIHub Key，只管理本实例已记录的自动 Key，不删除手动 Key 或其他实例的未知 Key。缓存保护窗口结束后，空闲 Key 可以按 LRU 回收，而会话映射仍会保留到 TTL，后续续接时可在原组重建 Key。

`single` 模式复用一把已有 Key，并通过 AIHub API 全局切组。长流和控制面切换共享 FIFO 租约，因此不会在响应中途换组，但它不能像 `pool` 模式一样并行使用多个分组。

算法、并发和故障转移细节见 [核心算法说明](packages/core/ALGORITHM.md)。

## Koishi 插件

仓库包含独立的 [`koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto)。它只读取公开统计并复用核心评分算法，不连接本地路由器，也不创建、修改或删除 AIHub Key。

- `最优分组`：返回 1～6 个接近最佳的候选
- `最烂分组`：返回最高有效倍率层中保守 TTFT 最慢的一项
- 支持平台/群号通配规则、私聊开关、查询冷却和结果缓存

插件使用和配置见 [Koishi 插件说明](packages/koishi-plugin-aihub-auto/README.md)。

## 构建与发布

```bash
bun install
bun run check

# 构建全部可用的 headless 目标到 artifacts/
bun scripts/build.ts

# 只构建一个 headless 目标
bun scripts/build.ts linux-x64

# 为当前 Rust target 准备桌面 sidecar
bun run desktop:sidecar

# 构建当前平台桌面安装包
bun run desktop:build
```

推送 `v*` 标签会触发 [GitHub Actions 发布流程](.github/workflows/release.yml)：先运行测试和类型检查，再构建 headless ZIP、Windows NSIS、Windows 便携 ZIP、macOS DMG、Linux DEB 及 Tauri 更新文件。正式发布前需要配置 `TAURI_SIGNING_PRIVATE_KEY`，并保证标签、桌面 `package.json`、Tauri 配置和 Cargo 版本一致。

推送到 `main` 或推送 `v*` 标签还会触发独立的[容器工作流](.github/workflows/container.yml)，使用仓库自动提供的 `GITHUB_TOKEN` 登录 GHCR 并发布多架构镜像，不需要额外配置 Docker Hub 密钥。仓库设置必须允许 GitHub Actions 对 Packages 执行写操作；工作流已声明 `packages: write`。

## 项目结构

| 目录 | 作用 |
| --- | --- |
| [`packages/core`](packages/core) | AIHub API 客户端、评分、决策、熔断和本地观测 |
| [`apps/router`](apps/router) | Headless 路由器、反向代理、Key 池、会话亲和和 Web 控制台 |
| [`apps/desktop`](apps/desktop) | Tauri 桌面壳、sidecar 生命周期、托盘、自启动和更新 |
| [`packages/koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto) | Koishi 公开统计查询插件 |
| [`scripts`](scripts) | Headless 交叉编译和桌面 sidecar 构建脚本 |
| [`.github/workflows`](.github/workflows) | 跨平台测试、打包和 Release 流程 |
| [`Dockerfile`](Dockerfile) | Headless 多架构容器镜像 |

## 安全说明

- 默认保持回环监听；不要在没有 `proxyToken` 和 `uiPassword` 时向网络开放
- 公网部署必须使用 TLS，且不要把配置目录、凭据文件或日志暴露给 Web 服务
- 控制台响应使用 nonce CSP、禁止嵌入和缓存，并校验浏览器 Origin 与 Host
- 普通日志会脱敏，控制台日志接口还会再次脱敏；审计日志仍应作为敏感运行数据管理
- Sentry 仅用于路由器自身异常和用户主动反馈；上游 HTTP 错误、超时、取消和请求内容不作为错误事件上报
- Windows Authenticode 与 macOS Developer ID/公证目前未配置；minisign/Tauri 更新签名不能替代操作系统发行者签名

更完整的审计结论和兼容性范围见 [security_best_practices_report.md](security_best_practices_report.md)。

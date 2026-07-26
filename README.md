# aihub-auto

[AIHub](https://aihub.top) 最优分组自动路由。一套算法核心,两件产品:

| 目录 | 说明 |
| --- | --- |
| [`apps/router`](apps/router) | 跨平台单二进制反代应用:自动选最优分组、请求内故障转移、缓存感知切换、本地 Web 控制台 |
| [`packages/koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto) | Koishi 插件:群聊查询当前最优分组(条数自适应 1~6) |
| [`packages/core`](packages/core) | 共享算法核心:评分/决策/熔断/本地观测,零运行时依赖,[算法说明](packages/core/ALGORITHM.md) |

## 应用下载

[Releases](https://github.com/WSXYT/aihub-auto/releases/latest) 提供 Windows / Linux / macOS(x64 + arm64)单文件二进制。

## 核心能力

- **真反代**:客户端指向本地代理,真实流量实测 TTFT/错误率并与公开统计按置信度融合
- **真故障转移**:上游 5xx/429/超时,在未回包前同请求换组重试;熔断器指数退避
- **缓存感知**:切分组=丢 prompt cache。活跃会话抬高切换门槛,空闲窗口自动兑现挂起的切换
- **双执行模式**:单 Key PUT 切组,或自动建/删 Key 池(毫秒切换,各组缓存互不干扰)
- **三种策略**:省钱 / 均衡 / 速度,价格区间硬约束 + 黑名单

## 开发

```bash
bun install
bun run check        # 全部测试 + 类型检查
bun scripts/build.ts # 6 目标交叉编译 → artifacts/
```

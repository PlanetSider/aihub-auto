# aihub-auto

[AIHub](https://aihub.top) 最优分组自动路由。一套算法核心,两件产品:

| 目录 | 说明 |
| --- | --- |
| [`apps/router`](apps/router) | 跨平台单二进制反代:自动 Key 池、会话亲和、P2C/Peak-EWMA 动态均衡、请求本地故障转移、Web 控制台 |
| [`packages/koishi-plugin-aihub-auto`](packages/koishi-plugin-aihub-auto) | Koishi 插件:群聊查询最优分组(自适应 1~6)或单个最烂分组(最高倍率、同倍率最慢) |
| [`packages/core`](packages/core) | 共享算法核心:评分/决策/熔断/本地观测,零运行时依赖,[算法说明](packages/core/ALGORITHM.md) |

## 应用下载

[Releases](https://github.com/WSXYT/aihub-auto/releases/latest) 提供 Windows / Linux / macOS(x64 + arm64)单文件二进制。

## 核心能力

- **真反代**:客户端指向本地代理,真实流量实测 TTFT/错误率并与公开统计按置信度融合
- **真故障转移**:上游 5xx/429/超时,在未回包前同请求换组重试;熔断器指数退避
- **缓存感知**:pool 模式下已绑定会话不因评分变化切组;控制面与 single 模式仍按活跃流量抬高切换门槛,在空闲窗口兑现挂起切换
- **会话亲和**:从显式会话头、Responses conversation/response 链、prompt cache key 或稳定提示前缀识别会话;已有会话固定回原组
- **动态均衡**:新会话在近优候选中用 P2C + Peak EWMA 结合价格、TTFT、错误率和在飞负载分配
- **双执行模式**:默认自动 Key 池按组单飞创建/安全回收 Key;single 兼容模式继续支持单 Key `PUT` 切组
- **模型感知**:从强 `model_not_found`/不支持响应学习 `(group, model)` 能力,只迁移受影响会话
- **三种策略**:省钱 / 均衡 / 速度,价格区间硬约束 + 黑名单
- **运维控制台**:展示有效倍率、候选排除原因、会话/Responses 分支、在飞请求和 Key 池保留/回收状态
- **稳定性诊断**:客户端断流安全收尾,浏览器访问 `/v1` 本地响应,生命周期和未处理异常写入 `crash.log`

## 开发

```bash
bun install
bun run check        # 全部测试 + 类型检查
bun scripts/build.ts # 6 目标交叉编译 → artifacts/
```

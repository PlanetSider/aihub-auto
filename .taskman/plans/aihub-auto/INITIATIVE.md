# aihub-auto

从 0 构建两件产品,共享同一套评分/决策算法:

1. **跨平台应用**(win/linux/mac × x64/arm64,Bun 编译单二进制):本地 HTTP 反代,把 OpenAI/Anthropic 流量转发到 aihub.top,自动选最优分组、故障转移、缓存感知切换。含本地 Web 控制台。
2. **Koishi 插件**:在指定适配器+群号(通配符)响应 `/最优分组`/`最优分组`,回复当前推荐 top1~6 + 应用下载链接。

## 超越 AIHubRouter 的核心点

参考项目只轮询公开统计再 PUT 切组,不碰流量。我们做真反代,因此能:
- 从真实流量实测 TTFT/错误率,与公开统计按置信度融合
- 真故障转移:上游错误 → 熔断 → 换组重试(请求不落地)
- 缓存感知:把"切组=丢 prompt cache"建模为切换成本,活跃会话期抬高门槛
- 双执行模式:A=单 Key PUT 切组;B=自动建 Key 池(前缀标识,自动对账/删除),切换毫秒级且各组缓存互不干扰

## 计划分解与顺序

1. `aihub-core`(先行):bun workspaces monorepo + `@aihub-auto/core` 算法包(纯函数、零运行时依赖、全测试)
2. `aihub-app`(依赖 core):反代应用 + Web UI + 6 目标构建 + GitHub Actions 发布
3. `aihub-koishi`(依赖 core,可与 app 并行):插件 + npm 发布准备

## 已核实的外部接口(见 .taskman/plans/aihub-auto/context.md)

- 公开统计:`GET /api/v1/public/groups/usage-stats?samples&platform&max_rate`(platform 取值 `openai`/`anthropic`)
- 账号侧(Bearer):login/refresh/me、groups/available、groups/rates、keys 分页列表、`POST /keys`(建)、`PUT /keys/{id}`(切组)、`DELETE /keys/{id}`(删)

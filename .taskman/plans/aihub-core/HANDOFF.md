# aihub-core

先行计划:搭 bun workspaces monorepo,产出零运行时依赖的 `@aihub-auto/core` 包,被应用与 Koishi 插件共享。

## 背景

全部外部接口与参考项目算法已核实,见 `.taskman/plans/aihub-auto/context.md`。要点:
- 公开统计 `GET {base}/api/v1/public/groups/usage-stats?samples&platform&max_rate`,platform ∈ {openai, anthropic}(`claude` 返回空)
- 账号侧(Bearer):`POST /api/v1/auth/login|refresh`、`GET /api/v1/auth/me`、`GET /api/v1/groups/available`、`GET /api/v1/groups/rates`、`GET /api/v1/keys`(分页)、`POST /api/v1/keys` {name,group_id}、`PUT /api/v1/keys/{id}` {group_id}、`DELETE /api/v1/keys/{id}`
- 参考算法(AIHubRouter docs/cross-platform-design.md):confidence = freshness(半衰 MaxAge/2)×volume(1−e^(−n/20))×stability(1/(1+CV));保守延迟 = avg×(2−confidence);score = wL×speedup − wP×premium;模式 Economy 0.8/0.2、Balanced 0.5/0.5、Speed 0.2/0.8;价格区间硬约束默认 0~0.15x;粘性 0.10

## 我们的算法增强(核心卖点,须全部落地)

1. **本地观测融合**:反代实测 TTFT/错误率(EWMA)按本地置信度与公开统计线性混合
2. **缓存感知切换成本**:切组=丢 prompt cache;有效切换门槛 = stickiness + cachePenalty×trafficRecency;空闲超过 cacheIdleMs(默认 5min,≈上游缓存 TTL)后惩罚归零;pending-switch 机制空闲时兑现;切换后最短驻留 minDwellMs(默认 90s);故障转移无视一切门槛
3. **熔断器**:按组 closed/open/half-open,指数退避冷却
4. **topN 推荐**(Koishi 用):按分数降序,截断于 bestScore−scoreWindow,1~6 条

## 完成定义

`bun test` 全绿、`tsc --noEmit` 干净、core 无运行时依赖、ALGORITHM.md 完整描述公式与默认参数。

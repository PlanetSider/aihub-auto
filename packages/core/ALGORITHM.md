# @aihub-auto/core 算法说明

数据源:`GET {base}/api/v1/public/groups/usage-stats?samples&platform&max_rate`(platform ∈ `openai` | `anthropic`),加反代自身实测(可选)。

## 1. 硬过滤(evaluate 第一段)

候选必须同时满足,否则带 `excludeReason` 进入排除列表(全程可解释):

| 条件 | excludeReason |
| --- | --- |
| 平台匹配 | `platform_mismatch` |
| 生效倍率有限且非负(用户专属倍率优先于公开倍率) | `invalid_rate` |
| 生效倍率 ∈ 价格区间 [min, max](含边界,硬约束) | `price_band` |
| 不在黑名单(含熔断临时排除) | `blacklisted` |
| 有样本(sampleCount > 0) | `no_samples` |
| 最后样本 ≤ maxStatusAge(默认 15 min),未来偏差 ≤ 1 min | `stale_sample` / `future_sample` |
| 平均 TTFT 有限且 > 0 | `invalid_latency` |
| 本地错误率 ≤ errorRateCap(默认 0.5,近 10 次,样本 ≥ 3 才生效) | `local_error_rate` |
| 置信度 ≥ 0.20 | `low_confidence` |

## 2. 置信度

```text
freshness = exp(−ln2 · age / (maxStatusAge / 2))     # 半衰期 7.5 min
volume    = 1 − exp(−sampleCount / 20)
stability = 1 / (1 + CV)                             # 无逐条样本时取 1;有本地 CV 用本地
confidence = freshness × volume × stability
```

## 3. 本地观测融合(超越 AIHubRouter 的第一点)

反代每个真实请求把 TTFT/成败写入 `LocalObservationStore`(EWMA α=0.3,窗口 10):

```text
localConfidence = (1 − e^(−n/5)) × exp(−ln2 · age / 5min)
blendedTtft     = localConfidence · localEwma + (1 − localConfidence) · publicAvg
```

公开统计反映"别人的体验",本地观测反映"自己的网络与账号",按本地置信度渐进接管。

## 4. 保守延迟与加权得分

```text
conservativeLatency = blendedTtft × (2 − confidence)
premium  = (rate − minRate) / minRate                # 基准 = 最低倍率候选,溢价 0
speedup  = baselineConservative / candidateConservative − 1
score    = latencyWeight × speedup − priceWeight × premium
```

minRate = 0 时仅零倍率候选按延迟竞争,非零倍率得分 −∞。

| 模式 | priceWeight | latencyWeight |
| --- | ---: | ---: |
| economy | 0.80 | 0.20 |
| balanced | 0.50 | 0.50 |
| speed | 0.20 | 0.80 |

排序:score ↓ → 倍率 ↑ → 保守延迟 ↑ → groupId ↑。

## 5. 缓存感知切换决策(超越 AIHubRouter 的第二点)

切分组 = 换上游账号 = prompt cache 全丢。AIHubRouter 只有固定粘性 0.10;我们把切换成本随流量显式建模:

```text
trafficRecency = activeStreams > 0 ? 1 : clamp01(1 − idle / cacheIdleMs)
threshold      = stickiness + cachePenaltyMax × trafficRecency
               # 默认 0.10 + 0.25 × recency,cacheIdleMs = 5 min ≈ 上游缓存 TTL
```

决策序(decide):

1. 无候选 → `no_candidate`
2. failover(当前组请求刚失败)→ 无视一切门槛切最优可用,排除失败组 → `failover`
3. 无当前组 → `initial_route`;当前组被硬过滤淘汰 → `current_invalid`
4. 当前 == top → `already_optimal`
5. 距上次切换 < minDwellMs(默认 90 s)→ `dwell`(防试探期抖动;分差 > stickiness 时记 pendingSwitch)
6. 分差 ≤ stickiness → `hold_sticky`
7. stickiness < 分差 ≤ threshold → `hold_cache` + 记 pendingSwitch。流量转冷后 recency→0、threshold 塌缩回 stickiness,同一分差自动兑现 → `pending_realized`
8. 分差 > threshold → 立即切换(`better_price` / `faster_weighted`)

效果:活跃会话期不为蝇头小利丢缓存;真正的大幅优势(> 0.35)仍然当场切;空闲窗口把挂起的优化免费兑现。

## 6. 熔断器(超越 AIHubRouter 的第三点)

按 groupId:

- closed → open:连续失败 ≥ 3,或 10 s 窗口失败率 ≥ 50% 且样本 ≥ 4
- open → half-open:冷却 30 s × 2^(openCount−1),封顶 10 min
- half-open:放 1 个探针;成功 → closed(退避复位),失败 → open
- 失败定义由调用方给:上游 5xx / 429 / 连接错误 / TTFB 超时;其余 4xx 不算

open/half-open 组通过 `trippedGroupIds()` 并入 evaluate 的 blacklist,不参与路由。

## 7. topN 推荐(Koishi)

```text
按 score 降序,保留 score ≥ best − scoreWindow(默认 0.15),1 ~ 6 条
```

分组彼此接近时多推荐,断层时只推荐头部——条数自适应。

## 8. 默认参数总表

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| priceBand | [0, 0.15] | 生效倍率硬约束(含边界) |
| maxStatusAgeMs | 15 min | 公开样本过期上限 |
| MIN_CONFIDENCE | 0.20 | 置信度下限 |
| errorRateCap | 0.5 | 本地错误率淘汰阈值 |
| stickiness | 0.10 | 基础切换门槛 |
| cachePenaltyMax | 0.25 | 缓存惩罚上限 |
| cacheIdleMs | 5 min | 缓存视为冷的空闲时长 |
| minDwellMs | 90 s | 切换后最短驻留 |
| scoreWindow / topN max | 0.15 / 6 | 推荐窗口与上限 |
| EWMA α / 窗口 | 0.3 / 10 | 本地观测 |
| 熔断 | 3 连败或 50%@10s,30s×2^n≤10min | 见上 |

## 9. 与 AIHubRouter 差异对照

| 维度 | AIHubRouter | @aihub-auto/core |
| --- | --- | --- |
| 数据 | 仅公开均值 | 公开 + 本地实测按置信度融合 |
| 切换成本 | 固定粘性 0.10 | 粘性 + 流量感知缓存惩罚 + pendingSwitch 空闲兑现 + minDwell |
| 故障 | 无(看不到流量) | 熔断器 + failover 无视门槛 + 请求内重试(app 层) |
| 推荐 | 单一目标 | topN 1~6 条自适应(Koishi) |
| 错误率 | 无 | 本地错误率硬淘汰 |

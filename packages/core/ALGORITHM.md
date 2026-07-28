# @aihub-auto/core 算法说明

AIHub 当前只提供 OpenAI 分组。路由器分成两个互不冲突的平面:

- **控制面**:定时读取公开统计,维护可解释评分与默认组
- **请求面**:仅在新会话或故障转移时做 P2C/Peak-EWMA 分配;已有会话保持原组

数据源为 `GET {base}/api/v1/public/groups/usage-stats?platform=openai&samples=...`,账号可用组/专属倍率,以及代理真实流量的本地观测。

## 1. 硬过滤

候选必须同时满足:

| 条件 | `excludeReason` |
| --- | --- |
| OpenAI 平台 | `platform_mismatch` |
| 属于账号可用组(成功取得账号列表时) | `unavailable_group` |
| 生效倍率有限、非负且位于 `[priceBand.min, priceBand.max]` | `invalid_rate` / `price_band` |
| 不在用户黑名单、熔断排除或本次请求排除集 | `blacklisted` |
| 公开或本地至少一方有可用延迟 | `no_samples` / `invalid_latency` |
| 公开样本不超过默认 15 分钟,未来偏差不超过 1 分钟 | `stale_sample` / `future_sample` |
| 无高置信度本地高错误率 | `local_error_rate` |
| 最终有足够置信度 | `low_confidence` |

用户专属倍率优先于公开倍率。公开样本过期时,新鲜本地延迟仍可让候选继续参与。

## 2. 公开置信度

```text
freshness = exp(-ln2 * age / (maxStatusAge / 2))
volume    = 1 - exp(-sampleCount / 20)
stability = 1 / (1 + CV)       # 有 CV 时
publicConfidence = freshness * volume * stability
```

公开统计是冷启动先验,不是永久真值。

## 3. 本地观测与 Peak EWMA

TTFT 与最终成败分开记录:

- 首个响应字节:`recordLatency(group, ttft)`
- 流正常结束:`recordSuccess(group)`
- 首字节前路由故障或可观测的中途断流:`recordFailure(group)`
- 客户端主动取消不算上游失败

每组保留最近 20 个 TTFT 和结果。普通 EWMA 的 `alpha=0.3`;Peak EWMA 对峰值立即响应,低值只按时间缓慢恢复:

```text
if ttft > peak:
  peak = ttft
else:
  w = exp(-ln2 * elapsed / 5min)
  peak = peak * w + ttft * (1 - w)
```

同时计算 P90、错误率和 CV。本地置信度为:

```text
localConfidence = (1 - exp(-recentSamples / 3)) * exp(-ln2 * age / 5min)
```

## 4. 公开/本地融合

更新的一方主导,较旧的一方只保留低权重先验。本地风险延迟优先使用 Peak EWMA,没有时才使用 `0.7 * EWMA + 0.3 * P90`。

```text
confidence = 1 - (1 - publicConfidence) * (1 - localConfidence)
effectiveError = min(0.95, localErrorRate * localConfidence)
conservativeLatency = blendedTtft * (2 - confidence) / max(1 - effectiveError, 0.2)
```

因此低置信度、尾延迟和失败重试成本都会提高候选延迟,但快速失败不会因响应快而获益;高错误率仍由熔断/硬过滤单独处理。

## 5. 价格与速度得分

```text
minimumRate = min(candidate.effectiveRate)
premium = (effectiveRate - minimumRate) / minimumRate
speedup = baselineConservative / candidateConservative - 1
score   = latencyWeight * speedup - priceWeight * premium
```

`minimumRate=0` 时仅零倍率候选按延迟竞争,非零倍率得分为负无穷。

| 模式 | 价格权重 | 延迟权重 |
| --- | ---: | ---: |
| `economy` | 0.8 | 0.2 |
| `balanced` | 0.5 | 0.5 |
| `speed` | 0.2 | 0.8 |

排序顺序为 score 降序、生效倍率升序、保守延迟升序、groupId 升序。

## 6. 控制面默认组

`decide()` 仍用于控制台、审计和默认组预热。正常优化门槛为:

```text
trafficRecency = activeStreams > 0 ? 1 : clamp01(1 - idle / cacheIdleMs)
threshold = stickiness + cachePenaltyMax * trafficRecency
```

它提供 `hold_sticky`、`hold_cache`、`pending_realized`、`minDwell` 等防抖语义。pool 模式下改变默认组不会迁移已绑定会话;single 兼容模式受上游单 Key 限制,仍是全局切组。

## 7. 请求面:会话亲和 + P2C

会话标识按以下优先级生成不可逆 SHA-256 摘要,并始终按模型隔离:

1. `x-aihub-auto-session`
2. Responses `conversation`
3. `previous_response_id` 响应别名;未知 ID 也有稳定回退摘要
4. `prompt_cache_key`
5. 模型、instructions、tools 与稳定提示前缀

已有绑定只检查硬约束、模型能力和熔断状态,不会因新评分变化而迁移。`previous_response_id` 会解析为 `sessionKey + preferredGroupId`(响应别名记录的实际上游组);该分支优先回到原组,但**不改写**会话主绑定,避免并发分支互相覆盖。新会话从 `score >= best - 0.15` 的近优候选中取最多 `poolMaxGroups` 个,用会话摘要稳定抽取两个不同候选(Power of Two Choices),再比较带在飞负载(含 route 期 reservation)的原策略得分:

```text
loadedLatency = conservativeLatency * (activeByGroup + 1)
loadedSpeedup = baselineConservative / loadedLatency - 1
loadedScore = latencyWeight * loadedSpeedup - priceWeight * premium
```

选择 `loadedScore` 较高者。这保留 economy/balanced/speed 的价格策略,同时采用 Finagle/Envoy Peak-EWMA 的核心负载形式 `latency * (pending + 1)`。会话绑定后不再参与动态重平衡。

## 8. 故障、熔断与模型能力

以下错误记为组健康失败并允许**首字节前**请求本地重试:连接错误、TTFB 超时(含“响应头已回但 body 首字节卡住”)、429、5xx。并发同会话请求用版本化绑定:旧请求失败回滚/迟到缓存证据不得覆盖较新主绑定。每个失败组每次尝试只记一次:

- 连续失败 3 次,或 10 秒窗口至少 4 个样本且失败率达到 50%:closed -> open
- 冷却为 `30s * 2^(openCount-1)`,上限 10 分钟
- 冷却后只允许一个请求面 half-open 探针;成功关闭,失败重新打开

普通 4xx 原样透传,不影响组健康。只有强模型能力信号才写入带 TTL 的 `(hash(model), groupId)` 负缓存:

- 结构化 code:`model_not_found`、`unsupported_model`、`model_not_supported`
- sub2api/Codex 确定性 `model is not supported when using codex` 响应
- 同等明确的中英文“不支持/未知模型”消息

模型不兼容只排除该 group/model,不惩罚该组的其他模型。故障转移通过会话锁与 CAS rebind 只更新失败会话;其他热会话不动。响应开始后绝不透明重放,避免重复输出和重复计费。

## 9. 自动 Key 池

pool 是默认模式。`ensureKey(groupId)` 使用同组 single-flight,不同组的提交/逐出串行化。LRU 删除必须同时满足:

- 超过 `poolMaxGroups`
- 不是本次目标或控制面默认组
- 没有有效会话绑定
- 没有在飞请求
- 距最后使用超过缓存宽限期(`decision.cacheIdleMs`)

若没有安全删除对象,池允许暂时超过上限。只管理 `aihub-auto-g{groupId}` 前缀 Key,不触碰用户 Key。`/ctl/status` 只返回 `keyId/lastUsedAt`,不返回 `sk`。

## 10. Koishi topN

```text
按 score 降序,保留 score >= best - scoreWindow(默认 0.15),最多 6 条
```

Koishi 只使用公开 OpenAI 统计,不参与请求面会话路由。

## 11. 默认参数

| 参数 | 默认值 |
| --- | ---: |
| `priceBand` | `[0, 0.15]` |
| `maxStatusAgeMs` | 15 分钟 |
| `errorRateCap` | 0.5 |
| `stickiness` / `cachePenaltyMax` | 0.10 / 0.25 |
| `cacheIdleMs` / `minDwellMs` | 5 分钟 / 90 秒 |
| `scoreWindow` / Koishi max | 0.15 / 6 |
| EWMA alpha / 本地窗口 | 0.3 / 20 |
| 会话 TTL / 上限 | 24 小时 / 10000 |
| pool 目标组数 | 4 |

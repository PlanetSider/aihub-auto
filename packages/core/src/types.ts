/** AIHub 平台标识。注意 usage-stats 的 platform 取值是 anthropic 而非 claude。 */
export type Platform = "openai" | "anthropic";

export const PLATFORMS: readonly Platform[] = ["openai", "anthropic"];

/** /api/v1/public/groups/usage-stats 单条分组统计 */
export interface GroupStat {
  code: string;
  platform: Platform;
  rateMultiplier: number;
  avgTtftMs: number;
  sampleCount: number;
  /** ISO 8601 */
  lastSampleAt: string;
  groupId: number;
}

export interface UsageStatsPage {
  items: GroupStat[];
  total: number;
  sampleLimit: number;
}

export interface GroupInfo {
  id: number;
  name: string;
  platform?: string;
  rateMultiplier?: number;
}

export interface ApiKeyInfo {
  id: number;
  name: string;
  /** sk- 明文,通常仅创建响应携带 */
  key?: string;
  groupId: number | null;
  status?: string;
  createdAt?: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
}

export type RoutingMode = "economy" | "balanced" | "speed";

export interface ModeWeights {
  priceWeight: number;
  latencyWeight: number;
}

/** 反代实测得到的单组本地观测(由 LocalObservationStore 提供) */
export interface LocalObservation {
  groupId: number;
  /** EWMA 首字延迟 */
  ewmaTtftMs: number;
  /** 近窗口错误率 0..1 */
  errorRate: number;
  /** 近窗口 TTFT 变异系数(std/mean),样本不足时为 undefined */
  cv?: number;
  sampleCount: number;
  /** epoch ms,最后一次观测 */
  lastAt: number;
  /** 0..1,由样本量与新鲜度得出 */
  confidence: number;
}

export interface ScoringOptions {
  mode: RoutingMode;
  /** 生效倍率硬约束区间(含边界) */
  priceBand: { min: number; max: number };
  /** groupId 黑名单(含临时熔断排除) */
  blacklist: number[];
  /** 公开统计样本过期上限 */
  maxStatusAgeMs: number;
  /** 本地错误率淘汰阈值 */
  errorRateCap: number;
  /** 目标平台 */
  platform: Platform;
  /** epoch ms */
  now: number;
}

export type ExcludeReason =
  | "platform_mismatch"
  | "invalid_rate"
  | "price_band"
  | "blacklisted"
  | "stale_sample"
  | "future_sample"
  | "no_samples"
  | "invalid_latency"
  | "low_confidence"
  | "local_error_rate";

export interface ScoredCandidate {
  stat: GroupStat;
  /** 0..1 */
  confidence: number;
  /** 本地融合后的延迟(未保守修正) */
  blendedTtftMs: number;
  /** 保守延迟 = blended × (2 − confidence) */
  conservativeLatencyMs: number;
  /** 相对最低倍率的溢价比;基准为 0 */
  premium: number;
  /** 相对基准的速度收益比 */
  speedup: number;
  /** 加权得分,基准为 0 */
  score: number;
  excluded: false;
}

export interface ExcludedCandidate {
  stat: GroupStat;
  excluded: true;
  excludeReason: ExcludeReason;
}

export type EvaluatedCandidate = ScoredCandidate | ExcludedCandidate;

export interface Evaluation {
  eligible: ScoredCandidate[];
  excluded: ExcludedCandidate[];
  /** 最低有效倍率(基准),无候选时 undefined */
  minimumRate?: number;
  /** 基准候选(最低倍率中保守延迟最低者) */
  baseline?: ScoredCandidate;
}

/** 反代当前流量情况(Koishi 等无流量场景传 idleTraffic()) */
export interface TrafficSnapshot {
  /** epoch ms,最近一次请求 */
  lastRequestAt?: number;
  activeStreams: number;
  requestsLast5m: number;
}

export interface RouteState {
  currentGroupId?: number;
  /** epoch ms */
  lastSwitchAt?: number;
  pendingSwitch?: { groupId: number; since: number };
}

export interface DecisionPolicy {
  /** 基础粘性:得分优势须超过它才考虑切换 */
  stickiness: number;
  /** 缓存惩罚上限,按流量新近度线性叠加到门槛 */
  cachePenaltyMax: number;
  /** 空闲超过该时长视为缓存已冷,惩罚归零 */
  cacheIdleMs: number;
  /** 切换后最短驻留 */
  minDwellMs: number;
}

export type DecisionReason =
  | "no_candidate"
  | "initial_route"
  | "current_invalid"
  | "failover"
  | "already_optimal"
  | "dwell"
  | "hold_sticky"
  | "hold_cache"
  | "better_price"
  | "faster_weighted"
  | "pending_realized";

export interface Decision {
  targetGroupId?: number;
  shouldSwitch: boolean;
  reason: DecisionReason;
  currentScore?: number;
  targetScore?: number;
  /** targetScore − currentScore */
  advantage?: number;
  /** 本次实际生效的切换门槛 */
  effectiveThreshold: number;
  nextState: RouteState;
}

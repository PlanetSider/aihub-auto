import type { DecisionPolicy, ModeWeights, RoutingMode } from "./types.ts";

export const MODE_WEIGHTS: Record<RoutingMode, ModeWeights> = {
  economy: { priceWeight: 0.8, latencyWeight: 0.2 },
  balanced: { priceWeight: 0.5, latencyWeight: 0.5 },
  speed: { priceWeight: 0.2, latencyWeight: 0.8 },
};

export const DEFAULT_PRICE_BAND = { min: 0, max: 0.15 };

/** 公开统计样本过期上限 */
export const DEFAULT_MAX_STATUS_AGE_MS = 15 * 60_000;

/** 未来时间容忍(时钟偏差) */
export const FUTURE_SKEW_TOLERANCE_MS = 60_000;

/** 置信度下限,低于淘汰 */
export const MIN_CONFIDENCE = 0.2;

/** 本地观测错误率淘汰阈值 */
export const DEFAULT_ERROR_RATE_CAP = 0.5;

/** topN 推荐:与最优分差窗口 / 最大条数 */
export const DEFAULT_SCORE_WINDOW = 0.15;
export const DEFAULT_TOPN_MAX = 6;

export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  stickiness: 0.1,
  cachePenaltyMax: 0.25,
  /** ≈ 上游 prompt cache TTL(OpenAI/Anthropic 均 ~5min) */
  cacheIdleMs: 5 * 60_000,
  minDwellMs: 90_000,
};

/** 本地观测 EWMA 系数 */
export const LOCAL_EWMA_ALPHA = 0.3;
/** 本地观测结果环形缓冲大小(错误率/CV 窗口) */
export const LOCAL_WINDOW_SIZE = 10;
/** 本地置信度半衰期 */
export const LOCAL_CONFIDENCE_HALF_LIFE_MS = 5 * 60_000;

/** 熔断器默认参数 */
export const BREAKER_DEFAULTS = {
  consecutiveFailureThreshold: 3,
  windowMs: 10_000,
  windowFailureRate: 0.5,
  windowMinSamples: 4,
  baseCooldownMs: 30_000,
  maxCooldownMs: 10 * 60_000,
};

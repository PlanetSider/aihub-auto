import { MIN_CONFIDENCE, MODE_WEIGHTS, FUTURE_SKEW_TOLERANCE_MS, DEFAULT_SCORE_WINDOW, DEFAULT_TOPN_MAX } from "./defaults.ts";
import type {
  EvaluatedCandidate,
  Evaluation,
  ExcludedCandidate,
  GroupStat,
  LocalObservation,
  ScoredCandidate,
  ScoringOptions,
} from "./types.ts";

const LN2 = Math.LN2;

/**
 * 公开统计置信度:freshness × volume × stability。
 * - freshness: 指数衰减,半衰期 = maxStatusAge/2
 * - volume: 1 − e^(−n/20)
 * - stability: 1/(1+CV)。公开接口只给均值 ⇒ 无 CV 时取 1;有本地 CV 用本地。
 */
export function computeConfidence(
  ageMs: number,
  sampleCount: number,
  cv: number | undefined,
  maxStatusAgeMs: number,
): number {
  const freshness = Math.exp((-LN2 * Math.max(ageMs, 0)) / (maxStatusAgeMs / 2));
  const volume = 1 - Math.exp(-sampleCount / 20);
  const stability = cv !== undefined && Number.isFinite(cv) && cv >= 0 ? 1 / (1 + cv) : 1;
  return freshness * volume * stability;
}

function exclude(stat: GroupStat, reason: ExcludedCandidate["excludeReason"]): ExcludedCandidate {
  return { stat, excluded: true, excludeReason: reason };
}

/**
 * 硬过滤 + 置信度 + 本地融合 + 保守延迟 + 相对基准加权评分。
 * 纯函数;localObs 缺省即纯公开统计模式(Koishi 场景)。
 */
export function evaluate(
  stats: GroupStat[],
  options: ScoringOptions,
  localObs?: ReadonlyMap<number, LocalObservation>,
  /** 用户专属倍率(优先于公开倍率) */
  userRates?: ReadonlyMap<number, number>,
): Evaluation {
  const excluded: ExcludedCandidate[] = [];
  interface Pre {
    stat: GroupStat;
    rate: number;
    confidence: number;
    blendedTtftMs: number;
    conservativeLatencyMs: number;
  }
  const pre: Pre[] = [];
  const blacklist = new Set(options.blacklist);

  for (const stat of stats) {
    if (stat.platform !== options.platform) {
      excluded.push(exclude(stat, "platform_mismatch"));
      continue;
    }
    const rate = userRates?.get(stat.groupId) ?? stat.rateMultiplier;
    if (!Number.isFinite(rate) || rate < 0) {
      excluded.push(exclude(stat, "invalid_rate"));
      continue;
    }
    if (rate < options.priceBand.min || rate > options.priceBand.max) {
      excluded.push(exclude(stat, "price_band"));
      continue;
    }
    if (blacklist.has(stat.groupId)) {
      excluded.push(exclude(stat, "blacklisted"));
      continue;
    }
    if (!Number.isFinite(stat.sampleCount) || stat.sampleCount <= 0) {
      excluded.push(exclude(stat, "no_samples"));
      continue;
    }
    const sampleTime = Date.parse(stat.lastSampleAt);
    if (!Number.isFinite(sampleTime)) {
      excluded.push(exclude(stat, "stale_sample"));
      continue;
    }
    const age = options.now - sampleTime;
    if (age > options.maxStatusAgeMs) {
      excluded.push(exclude(stat, "stale_sample"));
      continue;
    }
    if (age < -FUTURE_SKEW_TOLERANCE_MS) {
      excluded.push(exclude(stat, "future_sample"));
      continue;
    }
    if (!Number.isFinite(stat.avgTtftMs) || stat.avgTtftMs <= 0) {
      excluded.push(exclude(stat, "invalid_latency"));
      continue;
    }

    const obs = localObs?.get(stat.groupId);
    if (obs && obs.sampleCount >= 3 && obs.errorRate > options.errorRateCap) {
      excluded.push(exclude(stat, "local_error_rate"));
      continue;
    }

    const confidence = computeConfidence(Math.max(age, 0), stat.sampleCount, obs?.cv, options.maxStatusAgeMs);
    if (confidence < MIN_CONFIDENCE) {
      excluded.push(exclude(stat, "low_confidence"));
      continue;
    }

    // 本地融合:α = 本地置信度
    const alpha = obs ? Math.min(Math.max(obs.confidence, 0), 1) : 0;
    const blendedTtftMs =
      obs && alpha > 0 ? alpha * obs.ewmaTtftMs + (1 - alpha) * stat.avgTtftMs : stat.avgTtftMs;
    const conservativeLatencyMs = blendedTtftMs * (2 - confidence);

    pre.push({ stat, rate, confidence, blendedTtftMs, conservativeLatencyMs });
  }

  if (pre.length === 0) {
    return { eligible: [], excluded };
  }

  const minimumRate = Math.min(...pre.map((p) => p.rate));
  // 基准 = 最低倍率候选中保守延迟最低者
  const baselinePre = pre
    .filter((p) => p.rate === minimumRate)
    .reduce((a, b) => (b.conservativeLatencyMs < a.conservativeLatencyMs ? b : a));

  const weights = MODE_WEIGHTS[options.mode];
  const zeroBase = minimumRate <= 0;

  const eligible: ScoredCandidate[] = pre.map((p) => {
    let premium: number;
    let speedup: number;
    let score: number;
    if (zeroBase) {
      // 最低倍率为 0:非零倍率溢价无穷 ⇒ 仅零倍率候选按延迟竞争
      if (p.rate <= 0) {
        premium = 0;
        speedup = baselinePre.conservativeLatencyMs / p.conservativeLatencyMs - 1;
        score = weights.latencyWeight * speedup;
      } else {
        premium = Number.POSITIVE_INFINITY;
        speedup = baselinePre.conservativeLatencyMs / p.conservativeLatencyMs - 1;
        score = Number.NEGATIVE_INFINITY;
      }
    } else {
      premium = (p.rate - minimumRate) / minimumRate;
      speedup = baselinePre.conservativeLatencyMs / p.conservativeLatencyMs - 1;
      score = weights.latencyWeight * speedup - weights.priceWeight * premium;
    }
    return {
      stat: p.stat,
      confidence: p.confidence,
      blendedTtftMs: p.blendedTtftMs,
      conservativeLatencyMs: p.conservativeLatencyMs,
      premium,
      speedup,
      score,
      excluded: false as const,
    };
  });

  sortCandidates(eligible);
  const baseline = eligible.find((c) => c.stat.groupId === baselinePre.stat.groupId);

  return { eligible, excluded, minimumRate, baseline };
}

/** 降序:score → 倍率低 → 保守延迟低 → groupId 小 */
export function sortCandidates(list: ScoredCandidate[]): void {
  list.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ra = a.stat.rateMultiplier;
    const rb = b.stat.rateMultiplier;
    if (ra !== rb) return ra - rb;
    if (a.conservativeLatencyMs !== b.conservativeLatencyMs) {
      return a.conservativeLatencyMs - b.conservativeLatencyMs;
    }
    return a.stat.groupId - b.stat.groupId;
  });
}

/**
 * topN 推荐(Koishi 用):按分数降序,截断于 best − scoreWindow;至少 1 条(有候选时),至多 max。
 */
export function recommendTopN(
  evaluation: Evaluation,
  opts?: { scoreWindow?: number; max?: number },
): ScoredCandidate[] {
  const scoreWindow = opts?.scoreWindow ?? DEFAULT_SCORE_WINDOW;
  const max = opts?.max ?? DEFAULT_TOPN_MAX;
  const list = evaluation.eligible.filter((c) => Number.isFinite(c.score));
  if (list.length === 0) return [];
  const best = list[0]!.score;
  return list.filter((c) => c.score >= best - scoreWindow).slice(0, Math.max(1, max));
}

export function allCandidates(evaluation: Evaluation): EvaluatedCandidate[] {
  return [...evaluation.eligible, ...evaluation.excluded];
}

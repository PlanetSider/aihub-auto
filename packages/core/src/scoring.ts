import {
	DEFAULT_SCORE_WINDOW,
	DEFAULT_TOPN_MAX,
	MIN_CONFIDENCE,
	MODE_WEIGHTS,
} from "./defaults.ts";
import type {
	EvaluatedCandidate,
	Evaluation,
	ExcludedCandidate,
	GroupStat,
	LocalObservation,
	ScoredCandidate,
	ScoringOptions,
} from "./types.ts";

function exclude(
	stat: GroupStat,
	reason: ExcludedCandidate["excludeReason"],
	effectiveRate?: number,
): ExcludedCandidate {
	return effectiveRate === undefined
		? { stat, excluded: true, excludeReason: reason }
		: { stat, effectiveRate, excluded: true, excludeReason: reason };
}

function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}

/**
 * 硬约束 + 本地优先融合 + 失败/尾延迟风险修正。
 * 上游最新有效样本永不过期;高置信度且更快的本地 TTFT 才覆盖它。
 */
export function evaluate(
	stats: GroupStat[],
	options: ScoringOptions,
	localObs?: ReadonlyMap<number, LocalObservation>,
	/** 用户专属倍率(优先于公开倍率) */
	userRates?: ReadonlyMap<number, number>,
): Evaluation {
	const excluded: ExcludedCandidate[] = [];
	const blacklist = new Set(options.blacklist);
	const allowed = options.allowedGroupIds
		? new Set(options.allowedGroupIds)
		: undefined;

	interface Pre {
		stat: GroupStat;
		rate: number;
		publicConfidence: number;
		localConfidence: number;
		localSampleCount: number;
		successRate: number;
		errorRate: number;
		confidence: number;
		blendedTtftMs: number;
		conservativeLatencyMs: number;
	}
	const pre: Pre[] = [];

	for (const stat of stats) {
		if (stat.platform !== options.platform) {
			excluded.push(exclude(stat, "platform_mismatch"));
			continue;
		}
		if (allowed && !allowed.has(stat.groupId)) {
			excluded.push(exclude(stat, "unavailable_group"));
			continue;
		}

		const rate = userRates?.get(stat.groupId) ?? stat.rateMultiplier;
		if (!Number.isFinite(rate) || rate < 0) {
			excluded.push(exclude(stat, "invalid_rate"));
			continue;
		}
		if (rate < options.priceBand.min || rate > options.priceBand.max) {
			excluded.push(exclude(stat, "price_band", rate));
			continue;
		}
		if (blacklist.has(stat.groupId)) {
			excluded.push(exclude(stat, "blacklisted", rate));
			continue;
		}

		const observation = localObs?.get(stat.groupId);
		const recentSamples =
			observation?.recentSamples ?? observation?.sampleCount ?? 0;
		const outcomeConfidence =
			observation?.outcomeConfidence ?? observation?.confidence ?? 0;
		const successRate = observation?.successRate ??
			(observation ? 1 - observation.errorRate : 1);
		if (
			observation &&
			outcomeConfidence >= MIN_CONFIDENCE &&
			recentSamples >= 3 &&
			observation.errorRate > options.errorRateCap
		) {
			excluded.push(exclude(stat, "local_error_rate", rate));
			continue;
		}

		const publicLatencyValid =
			Number.isFinite(stat.avgTtftMs) && stat.avgTtftMs > 0;
		const publicConfidence = publicLatencyValid ? 1 : 0;

		const localLatencyConfidence =
			observation?.latencyConfidence ?? observation?.confidence ?? 0;
		const localLatencyValid =
			observation?.ewmaTtftMs !== undefined &&
			Number.isFinite(observation.ewmaTtftMs) &&
			observation.ewmaTtftMs > 0 &&
			localLatencyConfidence >= MIN_CONFIDENCE;

		if (!publicLatencyValid && !localLatencyValid) {
			excluded.push(exclude(stat, "invalid_latency", rate));
			continue;
		}

		const localConfidence = localLatencyValid
			? clamp01(localLatencyConfidence)
			: 0;
		const localRiskLatency = localLatencyValid
			? (observation!.peakEwmaTtftMs ??
				0.7 * observation!.ewmaTtftMs! +
					0.3 * (observation!.p90TtftMs ?? observation!.ewmaTtftMs!))
			: undefined;
		const useLocal =
			localRiskLatency !== undefined &&
			(!publicLatencyValid || localRiskLatency < stat.avgTtftMs);
		const blendedTtftMs = useLocal ? localRiskLatency : stat.avgTtftMs;
		const confidence = useLocal ? localConfidence : publicConfidence;
		const errorRate = observation
			? Math.min(0.95, observation.errorRate * clamp01(outcomeConfidence))
			: 0;
		// 失败会带来重试成本;低置信度和 P90 抖动会抬高保守延迟。
		const conservativeLatencyMs =
			(blendedTtftMs * (2 - confidence)) / Math.max(1 - errorRate, 0.2);

		pre.push({
			stat,
			rate,
			publicConfidence,
			localConfidence,
			localSampleCount: recentSamples,
			successRate,
			errorRate,
			confidence,
			blendedTtftMs,
			conservativeLatencyMs,
		});
	}

	if (pre.length === 0) return { eligible: [], excluded };

	const minimumRate = Math.min(...pre.map((candidate) => candidate.rate));
	const cheapest = pre.filter((candidate) => candidate.rate === minimumRate);
	const baselinePre = cheapest.reduce((left, right) =>
		right.conservativeLatencyMs < left.conservativeLatencyMs ? right : left,
	);
	const strictEconomy = options.mode === "economy";
	const selectable = strictEconomy ? cheapest : pre;
	if (strictEconomy) {
		for (const candidate of pre) {
			if (candidate.rate > minimumRate)
				excluded.push(
					exclude(candidate.stat, "economy_price_tier", candidate.rate),
				);
		}
	}
	const weights = MODE_WEIGHTS[options.mode];
	const zeroBase = minimumRate <= 0;

	const eligible: ScoredCandidate[] = selectable.map((candidate) => {
		const speedup =
			baselinePre.conservativeLatencyMs / candidate.conservativeLatencyMs - 1;
		const premium = zeroBase
			? candidate.rate <= 0
				? 0
				: Number.POSITIVE_INFINITY
			: (candidate.rate - minimumRate) / minimumRate;
		const score =
			zeroBase && candidate.rate > 0
				? Number.NEGATIVE_INFINITY
				: weights.latencyWeight * speedup - weights.priceWeight * premium;

		return {
			stat: candidate.stat,
			effectiveRate: candidate.rate,
			publicConfidence: candidate.publicConfidence,
			localConfidence: candidate.localConfidence,
			localSampleCount: candidate.localSampleCount,
			outcomeSampleCount: candidate.localSampleCount,
			successRate: candidate.successRate,
			errorRate: candidate.errorRate,
			confidence: candidate.confidence,
			blendedTtftMs: candidate.blendedTtftMs,
			conservativeLatencyMs: candidate.conservativeLatencyMs,
			premium,
			speedup,
			score,
			excluded: false,
		};
	});

	sortCandidates(eligible);
	const baseline = eligible.find(
		(candidate) => candidate.stat.groupId === baselinePre.stat.groupId,
	);
	return { eligible, excluded, minimumRate, baseline };
}

/** 降序:score -> 生效倍率低 -> 保守延迟低 -> groupId 小 */
export function sortCandidates(list: ScoredCandidate[]): void {
	list.sort((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		if (left.effectiveRate !== right.effectiveRate) {
			return left.effectiveRate - right.effectiveRate;
		}
		if (left.conservativeLatencyMs !== right.conservativeLatencyMs) {
			return left.conservativeLatencyMs - right.conservativeLatencyMs;
		}
		return left.stat.groupId - right.stat.groupId;
	});
}

export function recommendTopN(
	evaluation: Evaluation,
	opts?: { scoreWindow?: number; max?: number },
): ScoredCandidate[] {
	const scoreWindow = opts?.scoreWindow ?? DEFAULT_SCORE_WINDOW;
	const max = opts?.max ?? DEFAULT_TOPN_MAX;
	const list = evaluation.eligible.filter((candidate) =>
		Number.isFinite(candidate.score),
	);
	if (list.length === 0) return [];
	const best = list[0]!.score;
	return list
		.filter((candidate) => candidate.score >= best - scoreWindow)
		.slice(0, Math.max(1, max));
}

export function allCandidates(evaluation: Evaluation): EvaluatedCandidate[] {
	return [...evaluation.eligible, ...evaluation.excluded];
}

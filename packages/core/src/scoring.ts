import {
	DEFAULT_SCORE_WINDOW,
	DEFAULT_TOPN_MAX,
	FUTURE_SKEW_TOLERANCE_MS,
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

const LN2 = Math.LN2;

/** 公开统计置信度;它只作为会随延迟快速衰减的冷启动先验。 */
export function computeConfidence(
	ageMs: number,
	sampleCount: number,
	cv: number | undefined,
	maxStatusAgeMs: number,
): number {
	const freshness = Math.exp(
		(-LN2 * Math.max(ageMs, 0)) / (maxStatusAgeMs / 2),
	);
	const volume = 1 - Math.exp(-sampleCount / 20);
	const stability =
		cv !== undefined && Number.isFinite(cv) && cv >= 0 ? 1 / (1 + cv) : 1;
	return freshness * volume * stability;
}

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
 * 公开样本过期时,只要本地仍有新鲜 TTFT,候选不会被延迟的公开数据误杀。
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
		if (
			observation &&
			outcomeConfidence >= MIN_CONFIDENCE &&
			recentSamples >= 3 &&
			observation.errorRate > options.errorRateCap
		) {
			excluded.push(exclude(stat, "local_error_rate", rate));
			continue;
		}

		const sampleTime = Date.parse(stat.lastSampleAt);
		const age = options.now - sampleTime;
		const publicHasSamples =
			Number.isFinite(stat.sampleCount) && stat.sampleCount > 0;
		const publicLatencyValid =
			Number.isFinite(stat.avgTtftMs) && stat.avgTtftMs > 0;
		const publicTimeValid = Number.isFinite(sampleTime);
		const publicNotFuture = publicTimeValid && age >= -FUTURE_SKEW_TOLERANCE_MS;
		const publicFresh = publicNotFuture && age <= options.maxStatusAgeMs;
		const publicUsable = publicHasSamples && publicLatencyValid && publicFresh;
		const publicConfidence = publicUsable
			? computeConfidence(
					Math.max(age, 0),
					stat.sampleCount,
					undefined,
					options.maxStatusAgeMs,
				)
			: 0;

		const localLatencyConfidence =
			observation?.latencyConfidence ?? observation?.confidence ?? 0;
		const localLatencyValid =
			observation?.ewmaTtftMs !== undefined &&
			Number.isFinite(observation.ewmaTtftMs) &&
			observation.ewmaTtftMs > 0 &&
			localLatencyConfidence >= MIN_CONFIDENCE;

		if (!publicUsable && !localLatencyValid) {
			const reason: ExcludedCandidate["excludeReason"] = !publicHasSamples
				? "no_samples"
				: !publicLatencyValid
					? "invalid_latency"
					: !publicTimeValid || age > options.maxStatusAgeMs
						? "stale_sample"
						: "future_sample";
			excluded.push(exclude(stat, reason, rate));
			continue;
		}
		if (publicConfidence < MIN_CONFIDENCE && !localLatencyValid) {
			excluded.push(exclude(stat, "low_confidence", rate));
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
		// 时间戳仲裁:更新的一方主导,较旧的一方只作低权重先验。
		const localIsNewer =
			localRiskLatency !== undefined &&
			(!publicUsable ||
				(observation!.latencyLastAt ?? observation!.lastAt) >= sampleTime);
		const localWeight =
			localRiskLatency === undefined
				? 0
				: localIsNewer
					? localConfidence
					: localConfidence * (1 - publicConfidence);
		const publicWeight = !publicUsable
			? 0
			: localIsNewer
				? publicConfidence * (1 - localConfidence)
				: publicConfidence;
		const totalWeight = localWeight + publicWeight;
		const blendedTtftMs =
			totalWeight > 0
				? ((localRiskLatency ?? 0) * localWeight +
						stat.avgTtftMs * publicWeight) /
					totalWeight
				: localRiskLatency!;

		const confidence = localLatencyValid
			? 1 - (1 - publicConfidence) * (1 - localConfidence)
			: publicConfidence;
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

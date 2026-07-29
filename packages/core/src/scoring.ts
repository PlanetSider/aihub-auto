import {
	DEFAULT_ECONOMY_POLICY,
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
 * 硬约束 + 云端/本地加权融合 + 失败/尾延迟风险修正。
 * 无本地 TTFT 时只用云端;有本地样本时按实时置信度加权。
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
	const circuitOpen = new Set(options.circuitOpenGroupIds);
	const allowed = options.allowedGroupIds
		? new Set(options.allowedGroupIds)
		: undefined;

	interface Pre {
		stat: GroupStat;
		rate: number;
		publicConfidence: number;
		localConfidence: number;
		localSampleCount: number;
		outcomeSampleCount: number;
		successRate: number;
		errorRate: number;
		confidence: number;
		blendedTtftMs: number;
		conservativeLatencyMs: number;
	}
	const pre: Pre[] = [];
	const economyExclude = (
		candidate: Pre,
		reason: "economy_unstable" | "economy_too_slow",
	): ExcludedCandidate => ({
		...exclude(candidate.stat, reason, candidate.rate),
		evidence: {
			localConfidence: candidate.localConfidence,
			localSampleCount: candidate.localSampleCount,
			outcomeSampleCount: candidate.outcomeSampleCount,
			successRate: candidate.successRate,
			confidence: candidate.confidence,
			blendedTtftMs: candidate.blendedTtftMs,
			conservativeLatencyMs: candidate.conservativeLatencyMs,
		},
	});

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
		if (circuitOpen.has(stat.groupId)) {
			excluded.push(exclude(stat, "circuit_open", rate));
			continue;
		}

		const observation = localObs?.get(stat.groupId);
		const outcomeSampleCount =
			observation?.recentSamples ?? (observation ? observation.sampleCount : 0);
		const outcomeConfidence =
			observation?.outcomeConfidence ?? observation?.confidence ?? 0;
		const successRate =
			observation?.successRate ?? (observation ? 1 - observation.errorRate : 1);
		if (
			observation &&
			outcomeConfidence >= MIN_CONFIDENCE &&
			outcomeSampleCount >= 3 &&
			observation.errorRate > options.errorRateCap
		) {
			excluded.push(exclude(stat, "local_error_rate", rate));
			continue;
		}

		const publicLatencyValid =
			Number.isFinite(stat.avgTtftMs) && stat.avgTtftMs > 0;
		const publicConfidence = publicLatencyValid ? 1 : 0;
		const localSampleCount =
			observation?.latencySampleCount ??
			(observation?.ewmaTtftMs !== undefined ? observation.sampleCount : 0);
		const localLatencyConfidence =
			observation?.latencyConfidence ?? observation?.confidence ?? 0;
		const localLatencyAvailable =
			localSampleCount > 0 &&
			observation?.ewmaTtftMs !== undefined &&
			Number.isFinite(observation.ewmaTtftMs) &&
			observation.ewmaTtftMs > 0;
		const localConfidence = localLatencyAvailable
			? clamp01(localLatencyConfidence)
			: 0;
		const localRiskLatency = localLatencyAvailable
			? (observation.peakEwmaTtftMs ??
				0.7 * observation.ewmaTtftMs! +
					0.3 * (observation.p90TtftMs ?? observation.ewmaTtftMs!))
			: undefined;

		if (
			!publicLatencyValid &&
			(localRiskLatency === undefined || localConfidence < MIN_CONFIDENCE)
		) {
			excluded.push(exclude(stat, "invalid_latency", rate));
			continue;
		}

		const blendedTtftMs = publicLatencyValid
			? localRiskLatency === undefined
				? stat.avgTtftMs
				: stat.avgTtftMs * (1 - localConfidence) +
					localRiskLatency * localConfidence
			: localRiskLatency!;
		const confidence = publicLatencyValid ? publicConfidence : localConfidence;
		const errorRate = observation
			? Math.min(0.95, observation.errorRate * clamp01(outcomeConfidence))
			: 0;
		const conservativeLatencyMs =
			(blendedTtftMs * (2 - confidence)) / Math.max(1 - errorRate, 0.2);

		pre.push({
			stat,
			rate,
			publicConfidence,
			localConfidence,
			localSampleCount,
			outcomeSampleCount,
			successRate,
			errorRate,
			confidence,
			blendedTtftMs,
			conservativeLatencyMs,
		});
	}

	if (pre.length === 0) return { eligible: [], standby: [], excluded };

	const strictEconomy = options.mode === "economy";
	const economyPolicy = options.economyPolicy ?? DEFAULT_ECONOMY_POLICY;
	const priceCandidates = strictEconomy
		? pre.filter((candidate) => {
				if (
					candidate.outcomeSampleCount >= economyPolicy.minOutcomeSamples &&
					candidate.successRate < economyPolicy.minSuccessRate
				) {
					excluded.push(economyExclude(candidate, "economy_unstable"));
					return false;
				}
				if (
					candidate.conservativeLatencyMs >
					economyPolicy.maxConservativeLatencyMs
				) {
					excluded.push(economyExclude(candidate, "economy_too_slow"));
					return false;
				}
				return true;
			})
		: pre;
	if (priceCandidates.length === 0) {
		return { eligible: [], standby: [], excluded };
	}

	const minimumRate = Math.min(
		...priceCandidates.map((candidate) => candidate.rate),
	);
	const cheapest = priceCandidates.filter(
		(candidate) => candidate.rate === minimumRate,
	);
	const baselinePre = cheapest.reduce((left, right) =>
		right.conservativeLatencyMs < left.conservativeLatencyMs ? right : left,
	);
	const weights = MODE_WEIGHTS[options.mode];
	const zeroBase = minimumRate <= 0;

	const scored: ScoredCandidate[] = priceCandidates.map((candidate) => {
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
			outcomeSampleCount: candidate.outcomeSampleCount,
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

	sortCandidates(scored);
	const eligible = strictEconomy
		? scored.filter((candidate) => candidate.effectiveRate === minimumRate)
		: scored;
	const standby = strictEconomy
		? scored
				.filter((candidate) => candidate.effectiveRate > minimumRate)
				.sort(
					(left, right) =>
						left.effectiveRate - right.effectiveRate ||
						left.conservativeLatencyMs - right.conservativeLatencyMs,
				)
		: [];
	const baseline = eligible.find(
		(candidate) => candidate.stat.groupId === baselinePre.stat.groupId,
	);
	return { eligible, standby, excluded, minimumRate, baseline };
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
	return [
		...evaluation.eligible,
		...evaluation.standby,
		...evaluation.excluded,
	];
}

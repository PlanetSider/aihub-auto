import {
	LOCAL_CONFIDENCE_HALF_LIFE_MS,
	LOCAL_EWMA_ALPHA,
	LOCAL_OUTCOME_MAX_SAMPLES,
	LOCAL_OUTCOME_WINDOW_MS,
	LOCAL_WINDOW_SIZE,
} from "./defaults.ts";
import type { LocalObservation } from "./types.ts";

interface Outcome {
	ok: boolean;
	at: number;
}

interface GroupObs {
	ewmaTtftMs?: number;
	peakEwmaTtftMs?: number;
	peakUpdatedAt?: number;
	ttfts: number[];
	outcomes: Outcome[];
	sampleCount: number;
	lastAt: number;
	latencyLastAt?: number;
	outcomeLastAt?: number;
}

interface SerializedObs {
	groupId: number;
	ewmaTtftMs?: number;
	peakEwmaTtftMs?: number;
	peakUpdatedAt?: number;
	ttfts?: number[];
	/** v0.2.1+:带时间戳的近 3 小时结果;旧版 boolean 数组仍可恢复。 */
	outcomes?: Array<boolean | Outcome>;
	/** 旧版兼容 */
	ring?: { ok: boolean; ttftMs?: number }[];
	sampleCount: number;
	lastAt: number;
	latencyLastAt?: number;
	outcomeLastAt?: number;
}

/**
 * 反代实测观测存储。TTFT 与最终成败分开记录:流式响应首字节先更新延迟,
 * 完成/断流后再更新可靠性,避免把“已出首字但中途断流”误算成成功。
 */
export class LocalObservationStore {
	private readonly groups = new Map<number, GroupObs>();
	private readonly alpha: number;
	private readonly windowSize: number;
	private readonly halfLifeMs: number;

	private readonly outcomeWindowMs: number;
	private readonly outcomeMaxSamples: number;

	constructor(opts?: {
		alpha?: number;
		windowSize?: number;
		halfLifeMs?: number;
		outcomeWindowMs?: number;
		outcomeMaxSamples?: number;
	}) {
		this.alpha = opts?.alpha ?? LOCAL_EWMA_ALPHA;
		this.windowSize = opts?.windowSize ?? LOCAL_WINDOW_SIZE;
		this.halfLifeMs = opts?.halfLifeMs ?? LOCAL_CONFIDENCE_HALF_LIFE_MS;
		this.outcomeWindowMs = opts?.outcomeWindowMs ?? LOCAL_OUTCOME_WINDOW_MS;
		this.outcomeMaxSamples = opts?.outcomeMaxSamples ?? LOCAL_OUTCOME_MAX_SAMPLES;
	}

	private group(groupId: number): GroupObs {
		let group = this.groups.get(groupId);
		if (!group) {
			group = { ttfts: [], outcomes: [], sampleCount: 0, lastAt: 0 };
			this.groups.set(groupId, group);
		}
		return group;
	}

	private pruneOutcomes(group: GroupObs, now: number): void {
		const cutoff = now - this.outcomeWindowMs;
		group.outcomes = group.outcomes
			.filter((outcome) => outcome.at >= cutoff && outcome.at <= now)
			.slice(-this.outcomeMaxSamples);
	}

	/** 首个响应字节到达时调用,不提前把整次请求判为成功。 */
	recordLatency(groupId: number, ttftMs: number, now = Date.now()): void {
		if (!Number.isFinite(ttftMs) || ttftMs <= 0) return;
		const group = this.group(groupId);
		group.ewmaTtftMs =
			group.ewmaTtftMs === undefined
				? ttftMs
				: this.alpha * ttftMs + (1 - this.alpha) * group.ewmaTtftMs;
		if (group.peakEwmaTtftMs === undefined || ttftMs > group.peakEwmaTtftMs) {
			group.peakEwmaTtftMs = ttftMs;
		} else {
			const elapsed = Math.max(now - (group.peakUpdatedAt ?? now), 0);
			const weight = Math.exp((-Math.LN2 * elapsed) / this.halfLifeMs);
			group.peakEwmaTtftMs =
				group.peakEwmaTtftMs * weight + ttftMs * (1 - weight);
		}
		group.peakUpdatedAt = now;
		group.ttfts.push(ttftMs);
		if (group.ttfts.length > this.windowSize) group.ttfts.shift();
		group.latencyLastAt = now;
		group.lastAt = now;
	}

	/** 兼容便捷方法:可一次记录成功结果及 TTFT。 */
	recordSuccess(groupId: number, ttftMs?: number, now = Date.now()): void {
		if (ttftMs !== undefined) {
			if (!Number.isFinite(ttftMs) || ttftMs <= 0) return;
			this.recordLatency(groupId, ttftMs, now);
		}
		const group = this.group(groupId);
		group.outcomes.push({ ok: true, at: now });
		this.pruneOutcomes(group, now);
		group.sampleCount++;
		group.outcomeLastAt = now;
		group.lastAt = now;
	}

	recordFailure(groupId: number, now = Date.now()): void {
		const group = this.group(groupId);
		group.outcomes.push({ ok: false, at: now });
		this.pruneOutcomes(group, now);
		group.sampleCount++;
		group.outcomeLastAt = now;
		group.lastAt = now;
	}

	getObservation(
		groupId: number,
		now = Date.now(),
	): LocalObservation | undefined {
		const group = this.groups.get(groupId);
		if (!group) return undefined;
		this.pruneOutcomes(group, now);
		if (group.outcomes.length === 0 && group.ttfts.length === 0)
			return undefined;

		const failures = group.outcomes.filter((outcome) => !outcome.ok).length;
		const errorRate =
			group.outcomes.length > 0 ? failures / group.outcomes.length : 0;
		const successRate = group.outcomes.length > 0 ? 1 - errorRate : 1;
		const sorted = [...group.ttfts].sort((a, b) => a - b);
		const p90TtftMs =
			sorted.length > 0
				? sorted[Math.ceil(sorted.length * 0.9) - 1]
				: undefined;

		let cv: number | undefined;
		if (group.ttfts.length >= 3) {
			const mean =
				group.ttfts.reduce((sum, value) => sum + value, 0) / group.ttfts.length;
			if (mean > 0) {
				const variance =
					group.ttfts.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
					group.ttfts.length;
				cv = Math.sqrt(variance) / mean;
			}
		}

		const latencyAge = Math.max(now - (group.latencyLastAt ?? group.lastAt), 0);
		const outcomeAge = Math.max(now - (group.outcomeLastAt ?? group.lastAt), 0);
		const latencyConfidence =
			(1 - Math.exp(-group.ttfts.length / 3)) *
			Math.exp((-Math.LN2 * latencyAge) / this.halfLifeMs);
		const outcomeConfidence =
			(1 - Math.exp(-group.outcomes.length / 3)) *
			Math.exp((-Math.LN2 * outcomeAge) / this.halfLifeMs);
		const recentSamples = Math.max(group.outcomes.length, group.ttfts.length);
		const age = Math.max(now - group.lastAt, 0);
		const confidence =
			(1 - Math.exp(-recentSamples / 3)) *
			Math.exp((-Math.LN2 * age) / this.halfLifeMs);
		const peakAge = Math.max(now - (group.peakUpdatedAt ?? now), 0);
		const decayedPeak =
			group.peakEwmaTtftMs === undefined
				? undefined
				: group.peakEwmaTtftMs *
					Math.exp((-Math.LN2 * peakAge) / this.halfLifeMs);

		return {
			groupId,
			ewmaTtftMs: group.ewmaTtftMs,
			peakEwmaTtftMs:
				decayedPeak === undefined
					? undefined
					: Math.max(decayedPeak, group.ewmaTtftMs ?? 0),
			p90TtftMs,
			errorRate,
			successRate,
			cv,
			sampleCount: group.sampleCount,
			recentSamples: group.outcomes.length,
			latencySampleCount: group.ttfts.length,
			lastAt: group.lastAt,
			latencyLastAt: group.latencyLastAt,
			outcomeLastAt: group.outcomeLastAt,
			latencyConfidence,
			outcomeConfidence,
			confidence,
		};
	}

	asMap(now = Date.now()): Map<number, LocalObservation> {
		const out = new Map<number, LocalObservation>();
		for (const [groupId] of this.groups) {
			const observation = this.getObservation(groupId, now);
			if (observation) out.set(groupId, observation);
		}
		return out;
	}

	toJSON(now = Date.now()): SerializedObs[] {
		return [...this.groups.entries()].map(([groupId, group]) => {
			this.pruneOutcomes(group, now);
			return {
				groupId,
				ewmaTtftMs: group.ewmaTtftMs,
				peakEwmaTtftMs: group.peakEwmaTtftMs,
				peakUpdatedAt: group.peakUpdatedAt,
				ttfts: group.ttfts,
				outcomes: group.outcomes,
				sampleCount: group.sampleCount,
				lastAt: group.lastAt,
				latencyLastAt: group.latencyLastAt,
				outcomeLastAt: group.outcomeLastAt,
			};
		});
	}

	static fromJSON(
		data: unknown,
		opts?: {
			alpha?: number;
			windowSize?: number;
			halfLifeMs?: number;
			outcomeWindowMs?: number;
			outcomeMaxSamples?: number;
		},
	): LocalObservationStore {
		const store = new LocalObservationStore(opts);
		if (!Array.isArray(data)) return store;
		for (const raw of data) {
			if (typeof raw !== "object" || raw === null) continue;
			const serialized = raw as Partial<SerializedObs>;
			if (typeof serialized.groupId !== "number") continue;
			const group = store.group(serialized.groupId);
			group.ewmaTtftMs =
				typeof serialized.ewmaTtftMs === "number"
					? serialized.ewmaTtftMs
					: undefined;
			group.peakEwmaTtftMs =
				typeof serialized.peakEwmaTtftMs === "number"
					? serialized.peakEwmaTtftMs
					: group.ewmaTtftMs;
			group.peakUpdatedAt =
				typeof serialized.peakUpdatedAt === "number"
					? serialized.peakUpdatedAt
					: serialized.lastAt;

			if (
				Array.isArray(serialized.ttfts) ||
				Array.isArray(serialized.outcomes)
			) {
				group.ttfts = Array.isArray(serialized.ttfts)
					? serialized.ttfts.filter(
							(value): value is number => Number.isFinite(value) && value > 0,
						)
					: [];
				const legacyOutcomeAt =
					typeof serialized.outcomeLastAt === "number"
						? serialized.outcomeLastAt
						: typeof serialized.lastAt === "number"
							? serialized.lastAt
							: 0;
				group.outcomes = Array.isArray(serialized.outcomes)
					? serialized.outcomes.flatMap((value): Outcome[] => {
							if (typeof value === "boolean")
								return [{ ok: value, at: legacyOutcomeAt }];
							if (typeof value !== "object" || value === null) return [];
							const outcome = value as Partial<Outcome>;
							return typeof outcome.ok === "boolean" &&
								Number.isFinite(outcome.at)
								? [{ ok: outcome.ok, at: outcome.at! }]
								: [];
						})
					: [];
			} else if (Array.isArray(serialized.ring)) {
				const ring = serialized.ring.filter(
					(entry): entry is { ok: boolean; ttftMs?: number } =>
						typeof entry === "object" &&
						entry !== null &&
						typeof entry.ok === "boolean",
				);
				group.outcomes = ring.map((entry) => ({
					ok: entry.ok,
						at:
							typeof serialized.outcomeLastAt === "number"
								? serialized.outcomeLastAt
								: typeof serialized.lastAt === "number"
									? serialized.lastAt
									: 0,
				}));
				group.ttfts = ring
					.map((entry) => entry.ttftMs)
					.filter(
						(value): value is number => Number.isFinite(value) && value! > 0,
					);
			}

			group.ttfts = group.ttfts.slice(-store.windowSize);
			group.outcomes.sort((left, right) => left.at - right.at);
			store.pruneOutcomes(group, Date.now());
			group.sampleCount =
				typeof serialized.sampleCount === "number"
					? serialized.sampleCount
					: group.outcomes.length;
			group.lastAt =
				typeof serialized.lastAt === "number" ? serialized.lastAt : 0;
			group.latencyLastAt =
				typeof serialized.latencyLastAt === "number"
					? serialized.latencyLastAt
					: group.ttfts.length > 0
						? group.lastAt
						: undefined;
			group.outcomeLastAt =
				typeof serialized.outcomeLastAt === "number"
					? serialized.outcomeLastAt
					: group.outcomes.at(-1)?.at;
		}
		return store;
	}
}

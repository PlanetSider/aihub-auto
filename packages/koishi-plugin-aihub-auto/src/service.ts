import {
	evaluate,
	parseGroupStat,
	recommendTopN,
	type Evaluation,
	type GroupStat,
	type Platform,
	type RoutingMode,
	type ScoredCandidate,
} from "@aihub-auto/core";
import {
	DEFAULT_ERROR_RATE_CAP,
	PLATFORMS,
} from "@aihub-auto/core";

export interface RecommendOptions {
	baseUrl: string;
	mode: RoutingMode;
	maxRate: number;
	samples: number;
	scoreWindow: number;
	cacheTtlMs: number;
	/** JSON GET(由 ctx.http 适配注入) */
	getJson: (url: string) => Promise<unknown>;
}

export interface PlatformRecommendation {
	platform: Platform;
	items: ScoredCandidate[];
}

export type RecommendationKind = "best" | "worst";

interface PlatformEvaluation {
	platform: Platform;
	evaluation: Evaluation;
	worstEvaluation: Evaluation;
}

interface CacheEntry {
	at: number;
	data: PlatformEvaluation[];
}

function recommendWorst(evaluation: Evaluation): ScoredCandidate[] {
	const worst = evaluation.eligible.reduce<ScoredCandidate | undefined>(
		(selected, candidate) => {
			if (!selected) return candidate;
			if (candidate.effectiveRate !== selected.effectiveRate) {
				return candidate.effectiveRate > selected.effectiveRate
					? candidate
					: selected;
			}
			if (candidate.conservativeLatencyMs !== selected.conservativeLatencyMs) {
				return candidate.conservativeLatencyMs > selected.conservativeLatencyMs
					? candidate
					: selected;
			}
			return candidate.stat.groupId > selected.stat.groupId
				? candidate
				: selected;
		},
		undefined,
	);
	return worst ? [worst] : [];
}

/** 推荐服务:评分结果 TTL 缓存 + in-flight 单飞,最优/最烂共享一次上游请求。 */
export class RecommendService {
	private cache = new Map<string, CacheEntry>();
	private inflight = new Map<string, Promise<PlatformEvaluation[]>>();

	async recommend(
		opts: RecommendOptions,
		kind: RecommendationKind = "best",
	): Promise<PlatformRecommendation[]> {
		const data = await this.evaluations(opts);
		return data
			.map(({ platform, evaluation, worstEvaluation }) => ({
				platform,
				items:
					kind === "worst"
						? recommendWorst(worstEvaluation)
						: recommendTopN(evaluation, {
								scoreWindow: opts.scoreWindow,
								max: 6,
							}),
			}))
			.filter((result) => result.items.length > 0);
	}

	private evaluations(opts: RecommendOptions): Promise<PlatformEvaluation[]> {
		const cacheKey = `${opts.baseUrl}|${opts.mode}|${opts.maxRate}|${opts.samples}`;
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.at < opts.cacheTtlMs) {
			return Promise.resolve(cached.data);
		}

		const existing = this.inflight.get(cacheKey);
		if (existing) return existing;

		const task = this.fetchAll(opts)
			.then((data) => {
				this.cache.set(cacheKey, { at: Date.now(), data });
				return data;
			})
			.finally(() => this.inflight.delete(cacheKey));
		this.inflight.set(cacheKey, task);
		return task;
	}

	private async fetchAll(
		opts: RecommendOptions,
	): Promise<PlatformEvaluation[]> {
		const now = Date.now();
		const results = await Promise.allSettled(
			PLATFORMS.map(async (platform): Promise<PlatformEvaluation> => {
				const q = new URLSearchParams({
					samples: String(opts.samples),
					platform,
				});
				const raw = await opts.getJson(
					`${opts.baseUrl.replace(/\/+$/, "")}/api/v1/public/groups/usage-stats?${q}`,
				);
				const stats = parseStatsResponse(raw);
				const evaluationOptions = {
					priceBand: { min: 0, max: opts.maxRate },
					blacklist: [],
					errorRateCap: DEFAULT_ERROR_RATE_CAP,
					platform,
					now,
				};
				const evaluation = evaluate(stats, {
					...evaluationOptions,
					mode: opts.mode,
				});
				const worstEvaluation = evaluate(stats, {
					...evaluationOptions,
					mode: "balanced",
				});
				return { platform, evaluation, worstEvaluation };
			}),
		);
		const ok = results
			.filter(
				(r): r is PromiseFulfilledResult<PlatformEvaluation> =>
					r.status === "fulfilled",
			)
			.map((r) => r.value);
		if (ok.length === 0 && results.every((r) => r.status === "rejected")) {
			throw new Error("usage-stats 全部平台拉取失败");
		}
		return ok;
	}
}

export function parseStatsResponse(raw: unknown): GroupStat[] {
	const root =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	// 兼容带 envelope({code,data:{items}})与裸 {items}
	const data =
		typeof root["data"] === "object" && root["data"] !== null
			? (root["data"] as Record<string, unknown>)
			: root;
	const items = Array.isArray(data["items"])
		? (data["items"] as unknown[])
		: [];
	return items
		.map(parseGroupStat)
		.filter((s): s is GroupStat => s !== undefined);
}

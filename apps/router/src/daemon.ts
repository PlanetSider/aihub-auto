import {
	DEFAULT_SCORE_WINDOW,
	MODE_WEIGHTS,
	type AIHubClient,
	type CircuitBreaker,
	type Decision,
	type Evaluation,
	type GroupStat,
	type LocalObservationStore,
	type Platform,
	type RouteState,
	type ScoredCandidate,
	type ScoringOptions,
	decide,
	evaluate,
	recommendTopN,
} from "@aihub-auto/core";
import { randomUUID } from "node:crypto";
import type { AppConfig, AppState, Credentials } from "./config.ts";
import type { ActiveKey, RouteExecutor } from "./executor.ts";
import type { AuditLog, Logger } from "./logger.ts";
import {
	hashIdentity,
	stableUnitInterval,
	type SessionAffinity,
} from "./session.ts";
import type { TrafficTracker } from "./traffic.ts";

export interface DaemonDeps {
	config: AppConfig;
	state: AppState;
	credentials: Credentials;
	client: AIHubClient;
	executor: RouteExecutor;
	breaker: CircuitBreaker;
	observations: LocalObservationStore;
	affinity: SessionAffinity;
	traffic: TrafficTracker;
	logger: Logger;
	audit: AuditLog;
	persistState: () => Promise<void>;
	persistStateSoon: () => void;
	persistCredentials: () => Promise<void>;
}

export interface RoundResult {
	platform: Platform;
	evaluation: Evaluation;
	decision: Decision;
	executed: boolean;
	stale: boolean;
}

export interface RouteRequest {
	sessionKey?: string;
	model?: string;
	preferredGroupId?: number;
	cacheEvidence?: boolean;
	continuity?: boolean;
	/** false 表示并发旧请求只可自选备用组,不得覆盖更新的会话主绑定。 */
	updateBinding?: boolean;
	failedGroupIds?: readonly number[];
}

/** 公开统计控制面 + 请求本地 P2C/Peak-EWMA 路由面。 */
export class RouteDaemon {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = false;
	private readonly lastStats = new Map<
		Platform,
		{ items: GroupStat[]; at: number }
	>();
	private statsInflight:
		| Promise<{ items: GroupStat[]; stale: boolean }>
		| undefined;
	private allowedGroupIds: number[] | undefined;
	private userRates: Map<number, number> | undefined;
	private readonly routeLocks = new Map<
		string,
		Promise<ActiveKey | undefined>
	>();
	private singleRoute: Promise<unknown> = Promise.resolve();
	needsReauth = false;
	lastRound: RoundResult | undefined;

	constructor(private readonly deps: DaemonDeps) {}

	async fetchStats(
		platform: Platform,
	): Promise<{ items: GroupStat[]; stale: boolean }> {
		if (this.statsInflight) return this.statsInflight;
		const pending = (async () => {
			try {
				const page = await this.deps.client.getUsageStats({
					platform,
					samples: this.deps.config.samples,
				});
				this.lastStats.set(platform, { items: page.items, at: Date.now() });
				return { items: page.items, stale: false };
			} catch (err) {
				const cached = this.lastStats.get(platform);
				this.deps.logger.warn(
					`usage-stats 拉取失败(${platform}),${cached ? "使用上轮缓存" : "无缓存可用"}:${err instanceof Error ? err.message : ""}`,
				);
				return { items: cached?.items ?? [], stale: true };
			}
		})();
		this.statsInflight = pending;
		return pending.finally(() => {
			if (this.statsInflight === pending) this.statsInflight = undefined;
		});
	}

	private async refreshAccountData(): Promise<void> {
		if (!this.deps.credentials.accessToken) return;
		const [groups, rates] = await Promise.allSettled([
			this.deps.client.getAvailableGroups(),
			this.deps.client.getUserGroupRates(),
		]);
		if (groups.status === "fulfilled") {
			this.allowedGroupIds = groups.value
				.filter((group) => !group.platform || group.platform === "openai")
				.map((group) => group.id)
				.filter((id) => Number.isInteger(id) && id > 0);
		}
		if (rates.status === "fulfilled") this.userRates = rates.value;
	}

	private breakerGroupIds(now: number, allowHalfOpen: boolean): number[] {
		return this.deps.breaker
			.snapshot(now)
			.filter(
				(entry) =>
					entry.state === "open" ||
					(!allowHalfOpen && entry.state === "half-open"),
			)
			.map((entry) => entry.groupId);
	}

	scoringOptions(
		platform: Platform,
		now: number,
		extraBlacklist: readonly number[] = [],
		allowHalfOpen = false,
	): ScoringOptions {
		const config = this.deps.config;
		return {
			mode: config.mode,
			priceBand: config.priceBand,
			blacklist: [
				...config.blacklist,
				...this.breakerGroupIds(now, allowHalfOpen),
				...extraBlacklist,
			],
			allowedGroupIds: this.allowedGroupIds,
			maxStatusAgeMs: config.maxStatusAgeMs,
			errorRateCap: config.errorRateCap,
			platform,
			now,
		};
	}

	private evaluate(
		items: GroupStat[],
		now: number,
		extraBlacklist: readonly number[] = [],
		allowHalfOpen = false,
	): Evaluation {
		return evaluate(
			items,
			this.scoringOptions("openai", now, extraBlacklist, allowHalfOpen),
			this.deps.observations.asMap(now),
			this.userRates,
		);
	}

	/** 公开统计轮:维护默认组并预热它的 Key;已绑定会话不会随之迁移。 */
	async runOnce(opts?: {
		dryRun?: boolean;
		platform?: Platform;
	}): Promise<RoundResult> {
		const now = Date.now();
		const platform = opts?.platform ?? "openai";
		const [{ items, stale }] = await Promise.all([
			this.fetchStats(platform),
			this.refreshAccountData(),
		]);
		const evaluation = this.evaluate(items, now);
		const routeState: RouteState = {
			currentGroupId: this.deps.state.currentGroupId,
			lastSwitchAt: this.deps.state.lastSwitchAt,
			pendingSwitch: this.deps.state.pendingSwitch,
		};
		const decision = decide(
			evaluation,
			routeState,
			this.deps.config.decision,
			this.deps.traffic.snapshot(now),
			now,
		);

		let executed = false;
		if (
			!opts?.dryRun &&
			decision.shouldSwitch &&
			decision.targetGroupId !== undefined
		) {
			try {
				await this.deps.executor.switchTo(decision.targetGroupId);
				executed = true;
				this.deps.state.lastSwitchAt = decision.nextState.lastSwitchAt;
				this.deps.state.pendingSwitch = decision.nextState.pendingSwitch;
			} catch (err) {
				this.deps.logger.error(
					`切换执行失败:${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else if (!opts?.dryRun) {
			this.deps.state.pendingSwitch = decision.nextState.pendingSwitch;
		}
		if (!opts?.dryRun) {
			this.deps.state.breaker = this.deps.breaker.toJSON();
			this.deps.state.observations = this.deps.observations.toJSON();
			await this.deps.persistState();
		}

		await this.deps.audit.append({
			platform,
			stale,
			decision: {
				reason: decision.reason,
				shouldSwitch: decision.shouldSwitch,
				target: decision.targetGroupId,
				advantage: decision.advantage,
				threshold: decision.effectiveThreshold,
			},
			candidates: evaluation.eligible.map((candidate) => ({
				group: candidate.stat.groupId,
				code: candidate.stat.code,
				rate: candidate.effectiveRate,
				ttft: Math.round(candidate.blendedTtftMs),
				conservative: Math.round(candidate.conservativeLatencyMs),
				confidence: Number(candidate.confidence.toFixed(3)),
				premium: Number.isFinite(candidate.premium)
					? Number(candidate.premium.toFixed(3))
					: "inf",
				score: Number.isFinite(candidate.score)
					? Number(candidate.score.toFixed(4))
					: "-inf",
			})),
			excluded: evaluation.excluded.map((candidate) => ({
				group: candidate.stat.groupId,
				reason: candidate.excludeReason,
			})),
		});

		const result: RoundResult = {
			platform,
			evaluation,
			decision,
			executed,
			stale,
		};
		this.lastRound = result;
		return result;
	}

	/** 请求本地路由;同一会话的选择/迁移串行化,其他会话互不影响。 */
	async route(request: RouteRequest): Promise<ActiveKey | undefined> {
		if (this.deps.config.keyMode === "single") {
			const pending = this.singleRoute
				.catch(() => undefined)
				.then(() => this.routeSingle(request));
			this.singleRoute = pending;
			return pending;
		}
		if (!request.sessionKey) return this.routePool(request);
		const previous =
			this.routeLocks.get(request.sessionKey) ?? Promise.resolve(undefined);
		const pending = previous
			.catch(() => undefined)
			.then(() => this.routePool(request));
		this.routeLocks.set(request.sessionKey, pending);
		return pending.finally(() => {
			if (this.routeLocks.get(request.sessionKey!) === pending) {
				this.routeLocks.delete(request.sessionKey!);
			}
		});
	}

	private async routeSingle(
		request: RouteRequest,
	): Promise<ActiveKey | undefined> {
		const now = Date.now();
		const items = await this.routingItems();
		const blocked = new Set(request.failedGroupIds ?? []);
		for (const groupId of this.modelBlockedGroupIds(request.model, now)) {
			blocked.add(groupId);
		}
		const current = this.deps.executor.currentKey();
		if (
			current &&
			this.hardEligible(current.groupId, items, blocked, now) &&
			this.deps.breaker.allowRequest(current.groupId, now)
		) {
			return current;
		}

		for (;;) {
			const evaluation = this.evaluate(items, now, [...blocked], true);
			const target = evaluation.eligible.find((candidate) =>
				Number.isFinite(candidate.score),
			);
			if (!target) return undefined;
			if (!this.deps.breaker.allowRequest(target.stat.groupId, now)) {
				blocked.add(target.stat.groupId);
				continue;
			}
			try {
				return await this.deps.executor.switchTo(target.stat.groupId);
			} catch (err) {
				this.deps.breaker.releaseRequest(target.stat.groupId, now);
				throw err;
			}
		}
	}

	private async routePool(
		request: RouteRequest,
	): Promise<ActiveKey | undefined> {
		const now = Date.now();
		const items = await this.routingItems();
		const failed = new Set(request.failedGroupIds ?? []);
		for (const groupId of this.modelBlockedGroupIds(request.model, now)) {
			failed.add(groupId);
		}
		const cacheLikelyHot = Boolean(
			request.sessionKey &&
				request.cacheEvidence &&
				this.deps.affinity.cacheLikelyHot(
					request.sessionKey,
					this.deps.config.decision.cacheIdleMs,
					now,
				),
		);
		const previousGroupId = request.sessionKey
			? this.deps.affinity.resolve(request.sessionKey, now)
			: undefined;
		const affinityGroupId = request.preferredGroupId ?? previousGroupId;
		const preserveBinding = Boolean(request.continuity || cacheLikelyHot);

		if (
			preserveBinding &&
			affinityGroupId !== undefined &&
			this.hardEligible(affinityGroupId, items, failed, now) &&
			this.deps.breaker.allowRequest(affinityGroupId, now)
		) {
			return this.prepareRequestKey(
				affinityGroupId,
				request,
				previousGroupId,
				now,
			);
		}

		const blocked = new Set(failed);
		const probe = this.halfOpenProbe(items, blocked, now, request.sessionKey);
		if (probe !== undefined && this.deps.breaker.allowRequest(probe, now)) {
			return this.prepareRequestKey(probe, request, previousGroupId, now);
		}

		let target: ScoredCandidate | undefined;
		for (;;) {
			const evaluation = this.evaluate(items, now, [...blocked]);
			target = this.selectP2c(evaluation, request.sessionKey ?? randomUUID());
			if (!target) break;
			if (this.deps.breaker.allowRequest(target.stat.groupId, now)) break;
			blocked.add(target.stat.groupId);
		}

		let groupId = target?.stat.groupId;
		if (groupId === undefined) {
			const fallback = this.deps.state.currentGroupId;
			if (
				fallback === undefined ||
				!this.hardEligible(fallback, items, blocked, now) ||
				!this.deps.breaker.allowRequest(fallback, now)
			) {
				return undefined;
			}
			groupId = fallback;
		}
		return this.prepareRequestKey(groupId, request, previousGroupId, now);
	}

	private async routingItems(): Promise<GroupStat[]> {
		const cached = this.lastStats.get("openai")?.items;
		if (cached?.length) return cached;
		return (await this.fetchStats("openai")).items;
	}

	private hardEligible(
		groupId: number,
		items: readonly GroupStat[],
		blocked: ReadonlySet<number>,
		now: number,
		probe = false,
	): boolean {
		const observations = this.deps.observations.asMap(now);
		if (probe) {
			const observation = observations.get(groupId);
			if (observation) {
				observations.set(groupId, {
					...observation,
					errorRate: 0,
					outcomeConfidence: 0,
				});
			}
		}
		return evaluate(
			[...items],
			this.scoringOptions("openai", now, [...blocked], true),
			observations,
			this.userRates,
		).eligible.some(
			(candidate) =>
				candidate.stat.groupId === groupId && Number.isFinite(candidate.score),
		);
	}

	private async prepareRequestKey(
		groupId: number,
		request: RouteRequest,
		_previousGroupId: number | undefined,
		now: number,
	): Promise<ActiveKey> {
		const releasePending = this.deps.traffic.reserve(groupId);
		let key: ActiveKey;
		try {
			key = await this.deps.executor.acquireKey(groupId);
		} catch (err) {
			releasePending();
			this.deps.breaker.releaseRequest(groupId, now);
			throw err;
		}
		const releaseKey = key.release;
		const release = () => {
			releaseKey?.();
			releasePending();
		};
		if (
			!request.sessionKey ||
			request.updateBinding === false ||
			request.preferredGroupId !== undefined
		) {
			return { ...key, release };
		}
		const binding = this.deps.affinity.bindForRoute(
			request.sessionKey,
			groupId,
			now,
		);
		return {
			...key,
			release,
			rollback: binding.rollback,
			invalidate: binding.invalidate,
			isCurrentBinding: binding.isCurrent,
		};
	}

	private selectP2c(
		evaluation: Evaluation,
		seed: string,
	): ScoredCandidate | undefined {
		const candidates = recommendTopN(evaluation, {
			scoreWindow: DEFAULT_SCORE_WINDOW,
			max: this.deps.config.poolMaxGroups,
		});
		if (candidates.length <= 1) return candidates[0];

		const firstIndex = Math.floor(
			stableUnitInterval(`${seed}:p2c:0`) * candidates.length,
		);
		let secondIndex = Math.floor(
			stableUnitInterval(`${seed}:p2c:1`) * (candidates.length - 1),
		);
		if (secondIndex >= firstIndex) secondIndex++;
		const first = candidates[firstIndex]!;
		const second = candidates[secondIndex]!;
		const active = this.deps.traffic.snapshot().activeByGroup ?? {};
		const weights = MODE_WEIGHTS[this.deps.config.mode];
		const baselineLatency = evaluation.baseline?.conservativeLatencyMs ?? 1;
		const adjustedScore = (candidate: ScoredCandidate): number => {
			if (!Number.isFinite(candidate.premium)) return Number.NEGATIVE_INFINITY;
			const pending = active[String(candidate.stat.groupId)] ?? 0;
			const loadedLatency = candidate.conservativeLatencyMs * (pending + 1);
			const speedup = baselineLatency / loadedLatency - 1;
			return (
				weights.latencyWeight * speedup -
				weights.priceWeight * candidate.premium
			);
		};
		const firstScore = adjustedScore(first);
		const secondScore = adjustedScore(second);
		if (firstScore !== secondScore)
			return firstScore > secondScore ? first : second;
		// first 由会话哈希均匀抽样;按 groupId 打破平局会令两候选时永久扎堆小 ID。
		return first;
	}

	private halfOpenProbe(
		items: readonly GroupStat[],
		blocked: ReadonlySet<number>,
		now: number,
		seed: string = randomUUID(),
	): number | undefined {
		const candidates = this.deps.breaker
			.snapshot(now)
			.filter(
				(entry) =>
					entry.state === "half-open" &&
					!blocked.has(entry.groupId) &&
					this.hardEligible(entry.groupId, items, blocked, now, true),
			)
			.sort(
				(left, right) =>
					stableUnitInterval(`${seed}:half-open:${left.groupId}`) -
					stableUnitInterval(`${seed}:half-open:${right.groupId}`),
			);
		return candidates[0]?.groupId;
	}

	private modelBlockedGroupIds(
		model: string | undefined,
		now: number,
	): number[] {
		if (!model) return [];
		const modelKey = hashIdentity(`v1:model:${model.toLowerCase()}`);
		const bucket = this.deps.state.modelBlocks[modelKey];
		if (!bucket) return [];
		const blocked: number[] = [];
		for (const [groupId, expiresAt] of Object.entries(bucket)) {
			if (expiresAt <= now) delete bucket[groupId];
			else blocked.push(Number(groupId));
		}
		if (Object.keys(bucket).length === 0)
			delete this.deps.state.modelBlocks[modelKey];
		return blocked;
	}

	reportModelIncompatible(groupId: number, model: string): void {
		const modelKey = hashIdentity(`v1:model:${model.toLowerCase()}`);
		const bucket = (this.deps.state.modelBlocks[modelKey] ??= {});
		bucket[String(groupId)] = Date.now() + this.deps.config.sessionTtlMs;
		this.trimModelBlocks();
		this.deps.logger.info(
			`模型不兼容:group=${groupId} modelHash=${modelKey.slice(0, 8)}`,
		);
		this.deps.persistStateSoon();
	}

	reportModelSupported(groupId: number, model: string | undefined): void {
		if (!model) return;
		const modelKey = hashIdentity(`v1:model:${model.toLowerCase()}`);
		const bucket = this.deps.state.modelBlocks[modelKey];
		if (!bucket) return;
		delete bucket[String(groupId)];
		if (Object.keys(bucket).length === 0)
			delete this.deps.state.modelBlocks[modelKey];
		this.deps.persistStateSoon();
	}

	private trimModelBlocks(): void {
		const entries = Object.entries(this.deps.state.modelBlocks).flatMap(
			([modelKey, groups]) =>
				Object.entries(groups).map(([groupId, expiresAt]) => ({
					modelKey,
					groupId,
					expiresAt,
				})),
		);
		const extra = entries.length - this.deps.config.sessionMaxEntries;
		if (extra <= 0) return;
		for (const entry of entries
			.sort((left, right) => left.expiresAt - right.expiresAt)
			.slice(0, extra)) {
			delete this.deps.state.modelBlocks[entry.modelKey]?.[entry.groupId];
		}
	}

	modelBlockStats(now = Date.now()): { models: number; pairs: number } {
		for (const modelKey of Object.keys(this.deps.state.modelBlocks)) {
			const bucket = this.deps.state.modelBlocks[modelKey]!;
			for (const [groupId, expiresAt] of Object.entries(bucket)) {
				if (expiresAt <= now) delete bucket[groupId];
			}
			if (Object.keys(bucket).length === 0)
				delete this.deps.state.modelBlocks[modelKey];
		}
		return {
			models: Object.keys(this.deps.state.modelBlocks).length,
			pairs: Object.values(this.deps.state.modelBlocks).reduce(
				(sum, groups) => sum + Object.keys(groups).length,
				0,
			),
		};
	}

	private persistRuntimeStateSoon(): void {
		this.deps.state.breaker = this.deps.breaker.toJSON();
		this.deps.state.observations = this.deps.observations.toJSON();
		this.deps.persistStateSoon();
	}

	reportFailure(groupId: number): void {
		this.deps.breaker.recordFailure(groupId);
		this.persistRuntimeStateSoon();
	}

	reportSuccess(groupId: number): void {
		this.deps.breaker.recordSuccess(groupId);
		this.persistRuntimeStateSoon();
	}

	reportNeutral(groupId: number): void {
		this.deps.breaker.releaseRequest(groupId);
		this.persistRuntimeStateSoon();
	}

	/** 旧调用兼容;pool 下只为本次请求选择备用组。 */
	async failover(
		failedGroupIds: number[],
		_platform: Platform,
	): Promise<ActiveKey | undefined> {
		return this.route({ failedGroupIds });
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.stopped = false;
		const loop = async () => {
			if (this.stopped) return;
			try {
				await this.runOnce();
			} catch (err) {
				this.deps.logger.error(
					`路由轮失败:${err instanceof Error ? err.message : String(err)}`,
				);
			}
			if (!this.stopped) {
				this.timer = setTimeout(loop, this.deps.config.pollIntervalMs);
			}
		};
		this.timer = setTimeout(loop, 0);
	}

	stop(): void {
		this.stopped = true;
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
	}
}

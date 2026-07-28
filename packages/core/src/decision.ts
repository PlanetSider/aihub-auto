import type {
	Decision,
	DecisionPolicy,
	Evaluation,
	RouteState,
	ScoredCandidate,
	TrafficSnapshot,
} from "./types.ts";

function clamp01(v: number): number {
	return Math.min(Math.max(v, 0), 1);
}

/** Koishi 等无流量场景 */
export function idleTraffic(): TrafficSnapshot {
	return { activeStreams: 0, requestsLast5m: 0 };
}

/**
 * 流量新近度 0..1:决定缓存惩罚强度。
 * - 有活跃流 ⇒ 1(切换必然打断缓存)
 * - 空闲时间线性衰减,超过 cacheIdleMs(≈上游缓存 TTL)⇒ 0
 */
export function trafficRecency(
	traffic: TrafficSnapshot,
	policy: DecisionPolicy,
	now: number,
): number {
	if (traffic.activeStreams > 0) return 1;
	if (traffic.lastRequestAt === undefined) return 0;
	const idle = Math.max(now - traffic.lastRequestAt, 0);
	return clamp01(1 - idle / policy.cacheIdleMs);
}

export interface DecideOptions {
	/** 故障转移:无视粘性/缓存惩罚/驻留,且排除 failedGroupIds */
	failover?: boolean;
	failedGroupIds?: number[];
}

/**
 * 缓存感知切换决策(纯函数)。
 *
 * 有效门槛 = stickiness + cachePenaltyMax × trafficRecency
 * - 分差 ≤ stickiness            → hold_sticky(不值得切)
 * - stickiness < 分差 ≤ 门槛      → hold_cache + 记 pendingSwitch(流量转冷后 recency→0,门槛塌缩到 stickiness,自然兑现)
 * - 分差 > 门槛                  → 切换
 * - minDwellMs 内             → dwell(防抖,failover 除外)
 */
export function decide(
	evaluation: Evaluation,
	state: RouteState,
	policy: DecisionPolicy,
	traffic: TrafficSnapshot,
	now: number,
	opts?: DecideOptions,
): Decision {
	const failover = opts?.failover ?? false;
	const failed = new Set(opts?.failedGroupIds ?? []);
	const eligible = failover
		? evaluation.eligible.filter((c) => !failed.has(c.stat.groupId))
		: evaluation.eligible;

	const top = eligible.find((c) => Number.isFinite(c.score));
	const current: ScoredCandidate | undefined =
		state.currentGroupId === undefined
			? undefined
			: eligible.find((c) => c.stat.groupId === state.currentGroupId);

	if (!top) {
		return {
			shouldSwitch: false,
			reason: "no_candidate",
			effectiveThreshold: 0,
			nextState: { ...state, pendingSwitch: undefined },
		};
	}

	const switchTo = (
		target: ScoredCandidate,
		reason: Decision["reason"],
		threshold: number,
	): Decision => ({
		targetGroupId: target.stat.groupId,
		shouldSwitch: true,
		reason,
		currentScore: current?.score,
		targetScore: target.score,
		advantage: current ? target.score - current.score : undefined,
		effectiveThreshold: threshold,
		nextState: {
			currentGroupId: target.stat.groupId,
			lastSwitchAt: now,
			pendingSwitch: undefined,
		},
	});

	if (failover) {
		// 当前组已失败:立刻切到最优可用,无视一切门槛
		return switchTo(top, "failover", 0);
	}

	if (state.currentGroupId === undefined) {
		return switchTo(top, "initial_route", 0);
	}

	if (!current) {
		const leftEconomyTier = evaluation.excluded.some(
			(candidate) =>
				candidate.stat.groupId === state.currentGroupId &&
				candidate.excludeReason === "economy_price_tier",
		);
		// economy 的高价旧默认组仍有效,但应直接降到最低价层;其他排除才是失效。
		return switchTo(
			top,
			leftEconomyTier ? "better_price" : "current_invalid",
			0,
		);
	}

	if (current.stat.groupId === top.stat.groupId) {
		return {
			targetGroupId: current.stat.groupId,
			shouldSwitch: false,
			reason: "already_optimal",
			currentScore: current.score,
			targetScore: top.score,
			advantage: 0,
			effectiveThreshold: policy.stickiness,
			nextState: { ...state, pendingSwitch: undefined },
		};
	}

	const advantage = top.score - current.score;
	const recency = trafficRecency(traffic, policy, now);
	const threshold = policy.stickiness + policy.cachePenaltyMax * recency;

	const hold = (
		reason: Decision["reason"],
		pending?: RouteState["pendingSwitch"],
	): Decision => ({
		targetGroupId: current.stat.groupId,
		shouldSwitch: false,
		reason,
		currentScore: current.score,
		targetScore: top.score,
		advantage,
		effectiveThreshold: threshold,
		nextState: { ...state, pendingSwitch: pending },
	});

	// 最短驻留:刚切过就别再切(即便分差很大),防止试探期抖动
	if (
		state.lastSwitchAt !== undefined &&
		now - state.lastSwitchAt < policy.minDwellMs
	) {
		const pending =
			advantage > policy.stickiness
				? {
						groupId: top.stat.groupId,
						since: state.pendingSwitch?.since ?? now,
					}
				: undefined;
		return hold("dwell", pending);
	}

	if (advantage <= policy.stickiness) {
		return hold("hold_sticky");
	}

	if (advantage <= threshold) {
		// 值得切但缓存还热:挂起,空闲后门槛塌缩自然兑现
		return hold("hold_cache", {
			groupId: top.stat.groupId,
			since: state.pendingSwitch?.since ?? now,
		});
	}

	const wasPending = state.pendingSwitch?.groupId === top.stat.groupId;
	const reason = wasPending
		? "pending_realized"
		: top.stat.rateMultiplier < current.stat.rateMultiplier
			? "better_price"
			: "faster_weighted";
	return switchTo(top, reason, threshold);
}

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DECISION_POLICY,
	decide,
	evaluate,
	idleTraffic,
	trafficRecency,
} from "../src/index.ts";
import type {
	DecisionPolicy,
	RouteState,
	TrafficSnapshot,
} from "../src/index.ts";
import { NOW, opts, stat } from "./helpers.ts";

const policy: DecisionPolicy = { ...DEFAULT_DECISION_POLICY };

/** 两组:1 便宜慢(top with economy)、2 贵快 */
function ev(mode: "economy" | "balanced" | "speed" = "balanced") {
	return evaluate(
		[
			stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 3000 }),
			stat({ groupId: 2, rateMultiplier: 0.08, avgTtftMs: 800 }),
		],
		opts({ mode }),
	);
}

function activeTraffic(): TrafficSnapshot {
	return { lastRequestAt: NOW - 1000, activeStreams: 2, requestsLast5m: 50 };
}

describe("trafficRecency", () => {
	test("活跃流 ⇒ 1", () => {
		expect(trafficRecency(activeTraffic(), policy, NOW)).toBe(1);
	});
	test("从未有请求 ⇒ 0", () => {
		expect(trafficRecency(idleTraffic(), policy, NOW)).toBe(0);
	});
	test("空闲线性衰减,超 cacheIdleMs 归零", () => {
		const half: TrafficSnapshot = {
			lastRequestAt: NOW - policy.cacheIdleMs / 2,
			activeStreams: 0,
			requestsLast5m: 0,
		};
		expect(trafficRecency(half, policy, NOW)).toBeCloseTo(0.5, 5);
		const cold: TrafficSnapshot = {
			lastRequestAt: NOW - policy.cacheIdleMs - 1,
			activeStreams: 0,
			requestsLast5m: 0,
		};
		expect(trafficRecency(cold, policy, NOW)).toBe(0);
	});
});

describe("decide 基本路径", () => {
	test("无候选 ⇒ no_candidate", () => {
		const d = decide(evaluate([], opts()), {}, policy, idleTraffic(), NOW);
		expect(d.reason).toBe("no_candidate");
		expect(d.shouldSwitch).toBe(false);
	});

	test("初次路由:直切 top,无门槛", () => {
		const d = decide(ev(), {}, policy, activeTraffic(), NOW);
		expect(d.reason).toBe("initial_route");
		expect(d.shouldSwitch).toBe(true);
		expect(d.nextState.currentGroupId).toBeDefined();
		expect(d.nextState.lastSwitchAt).toBe(NOW);
	});

	test("当前组被淘汰 ⇒ current_invalid 直切", () => {
		const d = decide(
			ev(),
			{ currentGroupId: 999 },
			policy,
			activeTraffic(),
			NOW,
		);
		expect(d.reason).toBe("current_invalid");
		expect(d.shouldSwitch).toBe(true);
	});

	test("已是最优 ⇒ already_optimal,清 pendingSwitch", () => {
		const e = ev();
		const top = e.eligible[0]!.stat.groupId;
		const d = decide(
			e,
			{ currentGroupId: top, pendingSwitch: { groupId: 2, since: NOW - 1000 } },
			policy,
			idleTraffic(),
			NOW,
		);
		expect(d.reason).toBe("already_optimal");
		expect(d.nextState.pendingSwitch).toBeUndefined();
	});
});

describe("粘性与缓存感知", () => {
	// economy 下 top=1(便宜),当前=2:优势很大
	test("空闲 + 大分差 ⇒ 切换", () => {
		const e = ev("economy");
		const d = decide(e, { currentGroupId: 2 }, policy, idleTraffic(), NOW);
		expect(d.shouldSwitch).toBe(true);
		expect(d.reason).toBe("better_price");
	});

	test("小分差 ≤ stickiness ⇒ hold_sticky(即便空闲)", () => {
		// 构造两组分差极小
		const e = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.05, avgTtftMs: 3000 }),
				stat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 3050 }),
			],
			opts(),
		);
		const d = decide(e, { currentGroupId: 2 }, policy, idleTraffic(), NOW);
		expect(d.shouldSwitch).toBe(false);
		expect(d.reason).toBe("hold_sticky");
		expect(d.nextState.pendingSwitch).toBeUndefined();
	});

	test("中分差 + 活跃流量 ⇒ hold_cache + pendingSwitch;空闲后同分差兑现", () => {
		// 分差要落在 (stickiness, stickiness+cachePenaltyMax] = (0.10, 0.35]
		const e = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.05, avgTtftMs: 2400 }),
				stat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 3300 }),
			],
			opts(),
		);
		const top = e.eligible[0]!;
		const cur = e.eligible[1]!;
		const adv = top.score - cur.score;
		expect(adv).toBeGreaterThan(policy.stickiness);
		expect(adv).toBeLessThanOrEqual(policy.stickiness + policy.cachePenaltyMax);

		// 活跃流量:держ
		const hot = decide(
			e,
			{ currentGroupId: cur.stat.groupId },
			policy,
			activeTraffic(),
			NOW,
		);
		expect(hot.shouldSwitch).toBe(false);
		expect(hot.reason).toBe("hold_cache");
		expect(hot.nextState.pendingSwitch?.groupId).toBe(top.stat.groupId);

		// 空闲后:同一分差 ⇒ pending_realized
		const later = NOW + policy.cacheIdleMs + 1000;
		const e2 = evaluate(
			[
				stat({
					groupId: 1,
					rateMultiplier: 0.05,
					avgTtftMs: 2400,
					lastSampleAt: new Date(later - 60_000).toISOString(),
				}),
				stat({
					groupId: 2,
					rateMultiplier: 0.05,
					avgTtftMs: 3300,
					lastSampleAt: new Date(later - 60_000).toISOString(),
				}),
			],
			opts({ now: later }),
		);
		const idle: TrafficSnapshot = {
			lastRequestAt: NOW,
			activeStreams: 0,
			requestsLast5m: 0,
		};
		const cold = decide(e2, hot.nextState, policy, idle, later);
		expect(cold.shouldSwitch).toBe(true);
		expect(cold.reason).toBe("pending_realized");
	});

	test("大分差压过缓存惩罚 ⇒ 活跃期也切换", () => {
		const e = ev("speed"); // 分差远超 0.35
		const top = e.eligible[0]!;
		const cur = e.eligible[1]!;
		expect(top.score - cur.score).toBeGreaterThan(
			policy.stickiness + policy.cachePenaltyMax,
		);
		const d = decide(
			e,
			{ currentGroupId: cur.stat.groupId },
			policy,
			activeTraffic(),
			NOW,
		);
		expect(d.shouldSwitch).toBe(true);
	});

	test("minDwell 内不切换(dwell),但记 pendingSwitch", () => {
		const e = ev("speed");
		const cur = e.eligible[1]!;
		const d = decide(
			e,
			{ currentGroupId: cur.stat.groupId, lastSwitchAt: NOW - 10_000 },
			policy,
			idleTraffic(),
			NOW,
		);
		expect(d.shouldSwitch).toBe(false);
		expect(d.reason).toBe("dwell");
		expect(d.nextState.pendingSwitch?.groupId).toBe(
			e.eligible[0]!.stat.groupId,
		);
	});
});

describe("故障转移", () => {
	test("failover 无视门槛/驻留,排除失败组", () => {
		const e = ev();
		const top = e.eligible[0]!.stat.groupId;
		const second = e.eligible[1]!.stat.groupId;
		const state: RouteState = { currentGroupId: top, lastSwitchAt: NOW - 1000 };
		const d = decide(e, state, policy, activeTraffic(), NOW, {
			failover: true,
			failedGroupIds: [top],
		});
		expect(d.shouldSwitch).toBe(true);
		expect(d.reason).toBe("failover");
		expect(d.targetGroupId).toBe(second);
	});

	test("economy 当前价层全失败 ⇒ 升档到 standby", () => {
		const e = ev("economy");
		const currentTier = e.eligible.map((candidate) => candidate.stat.groupId);
		expect(e.standby).toHaveLength(1);
		const d = decide(
			e,
			{ currentGroupId: currentTier[0] },
			policy,
			idleTraffic(),
			NOW,
			{ failover: true, failedGroupIds: currentTier },
		);
		expect(d.reason).toBe("failover");
		expect(d.targetGroupId).toBe(e.standby[0]!.stat.groupId);
	});

	test("failover 全部失败 ⇒ no_candidate", () => {
		const e = ev();
		const ids = e.eligible.map((c) => c.stat.groupId);
		const d = decide(
			e,
			{ currentGroupId: ids[0] },
			policy,
			idleTraffic(),
			NOW,
			{
				failover: true,
				failedGroupIds: ids,
			},
		);
		expect(d.reason).toBe("no_candidate");
	});
});

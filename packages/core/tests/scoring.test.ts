import { describe, expect, test } from "bun:test";
import { evaluate, recommendTopN } from "../src/index.ts";
import type { LocalObservation } from "../src/index.ts";
import { NOW, opts, stat } from "./helpers.ts";

describe("硬过滤", () => {
	test("平台不匹配被排除", () => {
		const ev = evaluate(
			[stat({ groupId: 1, platform: "invalid" as never })],
			opts(),
		);
		expect(ev.eligible).toHaveLength(0);
		expect(ev.excluded[0]?.excludeReason).toBe("platform_mismatch");
	});

	test("价格区间硬边界:0.15 含,0.151 排除", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.15 }),
				stat({ groupId: 2, rateMultiplier: 0.151 }),
			],
			opts(),
		);
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([1]);
		expect(ev.excluded[0]?.excludeReason).toBe("price_band");
	});

	test("倍率非法(负/NaN)排除", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: -0.1 }),
				stat({ groupId: 2, rateMultiplier: NaN }),
			],
			opts(),
		);
		expect(ev.eligible).toHaveLength(0);
		expect(ev.excluded.every((e) => e.excludeReason === "invalid_rate")).toBe(
			true,
		);
	});

	test("黑名单排除", () => {
		const ev = evaluate([stat({ groupId: 7 })], opts({ blacklist: [7] }));
		expect(ev.excluded[0]?.excludeReason).toBe("blacklisted");
	});

	test("过期样本排除(>15min),未来偏差>1min 排除", () => {
		const ev = evaluate(
			[
				stat({
					groupId: 1,
					lastSampleAt: new Date(NOW - 16 * 60_000).toISOString(),
				}),
				stat({
					groupId: 2,
					lastSampleAt: new Date(NOW + 2 * 60_000).toISOString(),
				}),
				stat({
					groupId: 3,
					lastSampleAt: new Date(NOW + 30_000).toISOString(),
				}),
			],
			opts(),
		);
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([3]);
		expect(ev.excluded.map((e) => e.excludeReason).sort()).toEqual([
			"future_sample",
			"stale_sample",
		]);
	});

	test("无样本/非法延迟排除", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, sampleCount: 0 }),
				stat({ groupId: 2, avgTtftMs: 0 }),
			],
			opts(),
		);
		expect(ev.eligible).toHaveLength(0);
		expect(ev.excluded.map((e) => e.excludeReason).sort()).toEqual([
			"invalid_latency",
			"no_samples",
		]);
	});

	test("低置信度排除:样本极少且很旧", () => {
		const ev = evaluate(
			[
				stat({
					groupId: 1,
					sampleCount: 1,
					lastSampleAt: new Date(NOW - 14 * 60_000).toISOString(),
				}),
			],
			opts(),
		);
		expect(ev.excluded[0]?.excludeReason).toBe("low_confidence");
	});

	test("本地错误率超阈直接淘汰", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 500,
					errorRate: 0.8,
					sampleCount: 10,
					lastAt: NOW,
					confidence: 0.9,
				},
			],
		]);
		const ev = evaluate(
			[stat({ groupId: 1 }), stat({ groupId: 2 })],
			opts(),
			obs,
		);
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([2]);
		expect(ev.excluded[0]?.excludeReason).toBe("local_error_rate");
	});
});

describe("评分与模式", () => {
	// 便宜慢组 vs 贵快组;快组足够快时,旧版 economy 也会选它。
	const cheap = stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 5000 });
	const fast = stat({ groupId: 2, rateMultiplier: 0.08, avgTtftMs: 200 });

	test("economy 锁定最低有效倍率层,speed 仍可选极快高价组", () => {
		const eco = evaluate([cheap, fast], opts({ mode: "economy" }));
		expect(eco.eligible.map((candidate) => candidate.stat.groupId)).toEqual([
			1,
		]);
		expect(eco.excluded).toContainEqual({
			stat: fast,
			effectiveRate: 0.08,
			excluded: true,
			excludeReason: "economy_price_tier",
		});
		const spd = evaluate([cheap, fast], opts({ mode: "speed" }));
		expect(spd.eligible[0]?.stat.groupId).toBe(2);
	});

	test("基准溢价为 0,溢价按最低倍率计算", () => {
		const ev = evaluate([cheap, fast], opts());
		const base = ev.eligible.find((c) => c.stat.groupId === 1)!;
		const other = ev.eligible.find((c) => c.stat.groupId === 2)!;
		expect(base.premium).toBe(0);
		expect(other.premium).toBeCloseTo((0.08 - 0.02) / 0.02, 5);
		expect(ev.minimumRate).toBe(0.02);
	});

	test("零倍率基准:非零倍率得分 −∞,零倍率按延迟竞争", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0, avgTtftMs: 4000 }),
				stat({ groupId: 2, rateMultiplier: 0, avgTtftMs: 2000 }),
				stat({ groupId: 3, rateMultiplier: 0.05, avgTtftMs: 500 }),
			],
			opts(),
		);
		expect(ev.eligible[0]?.stat.groupId).toBe(2);
		const paid = ev.eligible.find((c) => c.stat.groupId === 3)!;
		expect(paid.score).toBe(Number.NEGATIVE_INFINITY);
	});

	test("tie-break:同分时倍率低→延迟低→groupId 小", () => {
		const a = stat({ groupId: 9, rateMultiplier: 0.05, avgTtftMs: 3000 });
		const b = stat({ groupId: 3, rateMultiplier: 0.05, avgTtftMs: 3000 });
		const ev = evaluate([a, b], opts());
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([3, 9]);
	});

	test("用户专属倍率覆盖公开倍率", () => {
		const ev = evaluate(
			[stat({ groupId: 1, rateMultiplier: 0.5 })],
			opts(),
			undefined,
			new Map([[1, 0.03]]),
		);
		expect(ev.eligible).toHaveLength(1);
		expect(ev.minimumRate).toBe(0.03);
	});

	test("本地融合:高置信度本地观测拉动 blended 延迟", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 1000,
					errorRate: 0,
					sampleCount: 20,
					lastAt: NOW,
					confidence: 1,
				},
			],
		]);
		const ev = evaluate([stat({ groupId: 1, avgTtftMs: 5000 })], opts(), obs);
		expect(ev.eligible[0]?.blendedTtftMs).toBeCloseTo(1000, 0);
	});

	test("本地融合:更新的本地观测主导旧公开先验", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 1000,
					errorRate: 0,
					sampleCount: 5,
					lastAt: NOW,
					confidence: 0.5,
				},
			],
		]);
		const ev = evaluate([stat({ groupId: 1, avgTtftMs: 3000 })], opts(), obs);
		expect(ev.eligible[0]?.blendedTtftMs).toBeGreaterThan(1000);
		expect(ev.eligible[0]?.blendedTtftMs).toBeLessThan(2000);
	});

	test("保守延迟:低置信度放大延迟", () => {
		const freshStat = stat({ groupId: 1, avgTtftMs: 1000, sampleCount: 100 });
		const ev = evaluate([freshStat], opts());
		const c = ev.eligible[0]!;
		expect(c.conservativeLatencyMs).toBeGreaterThan(c.blendedTtftMs);
		expect(c.conservativeLatencyMs).toBeLessThan(c.blendedTtftMs * 2);
	});
});

describe("recommendTopN", () => {
	test("窗口截断:仅保留 best−window 内候选", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
				stat({ groupId: 2, rateMultiplier: 0.02, avgTtftMs: 1050 }),
				stat({ groupId: 3, rateMultiplier: 0.14, avgTtftMs: 9000 }),
			],
			opts(),
		);
		const top = recommendTopN(ev, { scoreWindow: 0.15, max: 6 });
		expect(top.map((c) => c.stat.groupId)).toEqual([1, 2]);
	});

	test("至少 1 条(有候选时)", () => {
		const ev = evaluate([stat({ groupId: 1 })], opts());
		expect(recommendTopN(ev, { scoreWindow: 0 })).toHaveLength(1);
	});

	test("至多 max 条", () => {
		const stats = Array.from({ length: 10 }, (_, i) =>
			stat({ groupId: i + 1, rateMultiplier: 0.05, avgTtftMs: 3000 + i }),
		);
		const ev = evaluate(stats, opts());
		expect(recommendTopN(ev, { scoreWindow: 10, max: 6 })).toHaveLength(6);
		expect(recommendTopN(ev, { scoreWindow: 10 })).toHaveLength(6);
	});

	test("无候选返回空", () => {
		const ev = evaluate([], opts());
		expect(recommendTopN(ev)).toHaveLength(0);
	});

	test("−∞ 分不进推荐", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0 }),
				stat({ groupId: 2, rateMultiplier: 0.05 }),
			],
			opts(),
		);
		const top = recommendTopN(ev, { scoreWindow: 100 });
		expect(top.map((c) => c.stat.groupId)).toEqual([1]);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { CircuitBreaker, LocalObservationStore } from "@aihub-auto/core";
import { handleProxy } from "../src/proxy.ts";
import { createHarness, type Harness } from "./harness.ts";
import { makeStat } from "./mock-upstream.ts";

let h: Harness;
afterEach(() => h?.dispose());

function proxyReq(): Request {
	return new Request("http://localhost/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
}

describe("守护循环", () => {
	test("冷启动:选最优组并执行(pool 建 Key)", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.1, avgTtftMs: 5000 }),
		];
		const round = await h.daemon.runOnce();
		expect(round.decision.reason).toBe("initial_route");
		expect(round.executed).toBe(true);
		expect(h.state.currentGroupId).toBe(1);
		expect([...h.mock.keys.values()][0]!.name).toBe("aihub-auto-g1");
		// 反代立即可用
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200);
	});

	test("统计拉取失败:容忍并用上轮缓存(标 stale)", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		await h.daemon.runOnce();
		// 模拟上游统计接口挂掉:换成无效 baseUrl 的新 client 不好搞,直接清 stats 并让接口 500 更真实——
		// 这里用行为等价方式:关掉 mock server 后 fetch 失败
		const round1 = h.daemon.lastRound!;
		expect(round1.stale).toBe(false);
		h.mock.stop();
		const round2 = await h.daemon.runOnce();
		expect(round2.stale).toBe(true);
		// 缓存候选仍在(样本时间还新鲜)
		expect(round2.evaluation.eligible.length).toBeGreaterThan(0);
	});

	test("dry-run 不执行切换", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		const round = await h.daemon.runOnce({ dryRun: true });
		expect(round.decision.shouldSwitch).toBe(true);
		expect(round.executed).toBe(false);
		expect(h.state.currentGroupId).toBeUndefined();
		expect(h.mock.keys.size).toBe(0);
	});

	test("熔断组并入黑名单:open 组不参与决策", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 2000 }),
		];
		for (let i = 0; i < 3; i++) h.breaker.recordFailure(1);
		const round = await h.daemon.runOnce();
		expect(h.state.currentGroupId).toBe(2);
		const excludedIds = round.evaluation.excluded.map((e) => e.stat.groupId);
		expect(excludedIds).toContain(1);
	});
});

describe("缓存感知端到端", () => {
	test("持续流量中小幅更优 ⇒ 不切(hold_cache);流量停止后 ⇒ pending_realized", async () => {
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				decision: {
					stickiness: 0.1,
					cachePenaltyMax: 0.25,
					cacheIdleMs: 1_000,
					minDwellMs: 0,
				},
			},
		});
		// 先路由到组 2
		h.mock.stats = [
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 3000 }),
		];
		await h.daemon.runOnce();
		expect(h.state.currentGroupId).toBe(2);

		// 出现小幅更优的组 1(分差落在 stickiness ~ stickiness+penalty 之间)
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.05, avgTtftMs: 2400 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 3300 }),
		];
		// 制造活跃流量(直接打点,不走真实代理以免污染本地观测延迟)
		h.traffic.begin();
		h.traffic.end();

		const hot = await h.daemon.runOnce();
		expect(hot.decision.reason).toBe("hold_cache");
		expect(h.state.currentGroupId).toBe(2);
		expect(h.state.pendingSwitch?.groupId).toBe(1);

		// 等流量转冷(cacheIdleMs=1s)
		await Bun.sleep(1_100);
		const cold = await h.daemon.runOnce();
		expect(cold.decision.reason).toBe("pending_realized");
		expect(h.state.currentGroupId).toBe(1);
	}, 10_000);

	test("活跃流量中大幅优势 ⇒ 当场切换", async () => {
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				decision: {
					stickiness: 0.1,
					cachePenaltyMax: 0.25,
					cacheIdleMs: 300_000,
					minDwellMs: 0,
				},
			},
		});
		h.mock.stats = [
			makeStat({ groupId: 2, rateMultiplier: 0.12, avgTtftMs: 6000 }),
		];
		await h.daemon.runOnce();
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.12, avgTtftMs: 6000 }),
		];
		await (await handleProxy(proxyReq(), h.proxyDeps)).text();
		const round = await h.daemon.runOnce();
		expect(round.decision.shouldSwitch).toBe(true);
		expect(h.state.currentGroupId).toBe(1);
	});
});

describe("状态持久化与恢复", () => {
	test("breaker/observations 序列化进 state,重建后语义保留", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		for (let i = 0; i < 3; i++) h.breaker.recordFailure(9);
		h.observations.recordSuccess(1, 1234);
		await h.daemon.runOnce();

		// 模拟重启:从序列化数据重建
		const b2 = CircuitBreaker.fromJSON(
			JSON.parse(JSON.stringify(h.state.breaker)),
		);
		const o2 = LocalObservationStore.fromJSON(
			JSON.parse(JSON.stringify(h.state.observations)),
		);
		expect(b2.isTripped(9)).toBe(true);
		expect(o2.getObservation(1)?.ewmaTtftMs).toBe(1234);
	});

	test("401 全链路:token 过期 → refresh → 路由继续", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		h.mock.expireToken = true; // 业务接口 401,refresh 后复位
		const round = await h.daemon.runOnce();
		expect(round.executed).toBe(true);
		expect(h.mock.refreshCalls).toBe(1);
		expect(h.state.currentGroupId).toBe(1);
	});
});

describe("控制台 API", () => {
	test("status/config/route-once/login 全链路", async () => {
		h = createHarness({ withServer: true, configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.2, avgTtftMs: 900 }), // 出价格区间 ⇒ excluded
		];
		const base = h.serverUrl!;

		// route-once
		const routeRes = await fetch(`${base}/ctl/route-once`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dryRun: false }),
		});
		const route = (await routeRes.json()) as {
			shouldSwitch: boolean;
			targetGroupId: number;
		};
		expect(route.shouldSwitch).toBe(true);
		expect(route.targetGroupId).toBe(1);

		// status 含候选与排除原因
		const statusRes = await fetch(`${base}/ctl/status`);
		const statusText = await statusRes.text();
		expect(statusText).not.toContain("sk-mock");
		expect(statusText).not.toMatch(/"sk"\s*:/);
		const status = JSON.parse(statusText) as {
			currentGroupId: number;
			candidates: {
				groupId: number;
				excluded: boolean;
				excludeReason?: string;
			}[];
			pool: Record<string, { keyId: number; lastUsedAt: number }>;
			affinity: { sessions: number };
			hasToken: boolean;
		};
		expect(status.currentGroupId).toBe(1);
		expect(status.pool["1"]?.keyId).toBeDefined();
		expect(status.affinity.sessions).toBe(0);
		expect(status.hasToken).toBe(true);
		const excluded = status.candidates.find((c) => c.groupId === 2);
		expect(excluded?.excluded).toBe(true);
		expect(excluded?.excludeReason).toBe("price_band");

		// config 热更新
		const cfgRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "speed", priceBand: { min: 0, max: 0.3 } }),
		});
		expect(cfgRes.status).toBe(200);
		expect(h.config.mode).toBe("speed");
		expect(h.config.priceBand.max).toBe(0.3);

		const restartRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyMode: "single" }),
		});
		expect(restartRes.status).toBe(409);
		expect(h.config.keyMode).toBe("pool");

		// 非法配置被拒
		const badRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "warp-speed" }),
		});
		expect(badRes.status).toBe(400);

		// login(email+password)
		const loginRes = await fetch(`${base}/ctl/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "a@b.c", password: "pw" }),
		});
		expect(loginRes.status).toBe(200);
		expect(h.credentials.accessToken).toBe("mock-at");
	});

	test("uiPassword 配置后:无口令 401,带口令通过;/healthz 与 /ui 开放", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { uiPassword: "console-pass-123" },
		});
		const base = h.serverUrl!;
		expect((await fetch(`${base}/ctl/status`)).status).toBe(401);
		expect(
			(
				await fetch(`${base}/ctl/status`, {
					headers: { "x-ui-password": "console-pass-123" },
				})
			).status,
		).toBe(200);
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		const ui = await fetch(`${base}/ui`);
		expect(ui.status).toBe(200);
		expect(await ui.text()).toContain("aihub-auto");
	});
});

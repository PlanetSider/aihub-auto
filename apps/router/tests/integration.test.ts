import { afterEach, describe, expect, test } from "bun:test";
import { CircuitBreaker, LocalObservationStore } from "@aihub-auto/core";
import { handleProxy } from "../src/proxy.ts";
import { browserRequestProblem } from "../src/server.ts";
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

	test("熔断冷却独立于用户黑名单:open 组不参与决策", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 2000 }),
		];
		for (let i = 0; i < 3; i++) h.breaker.recordFailure(1);
		const round = await h.daemon.runOnce();
		expect(h.state.currentGroupId).toBe(2);
		expect(
			round.evaluation.excluded.find(
				(candidate) => candidate.stat.groupId === 1,
			)?.excludeReason,
		).toBe("circuit_open");
		expect(h.config.blacklist).toEqual([]);
	});

	test("超出价格区间的闲置池组会在守护轮回收并清理亲和", async () => {
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				priceBand: { min: 0, max: 0.05 },
				decision: {
					stickiness: 0.1,
					cachePenaltyMax: 0.25,
					cacheIdleMs: 0,
					minDwellMs: 0,
				},
			},
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02 }),
			makeStat({ groupId: 2, rateMultiplier: 0.2 }),
		];
		await h.executor.ensureKey(1);
		await h.executor.ensureKey(2);
		h.affinity.bind("stale-session", 2);
		h.affinity.bindResponse("resp_stale", "stale-session", 2);
		h.state.pool["2"]!.lastUsedAt = 0;

		const round = await h.daemon.runOnce();
		expect(
			round.evaluation.excluded.find(
				(candidate) => candidate.stat.groupId === 2,
			)?.excludeReason,
		).toBe("price_band");
		expect(h.state.pool["2"]).toBeUndefined();
		expect(h.affinity.resolve("stale-session")).toBeUndefined();
		expect(h.affinity.resolveResponse("resp_stale")).toBeUndefined();
	});
});

describe("省钱优先", () => {
	test("新会话只选最低价层,该层失败后才升档,连续会话仍回原组", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool", mode: "economy" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 4_000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.02, avgTtftMs: 5_000 }),
			makeStat({ groupId: 3, rateMultiplier: 0.03, avgTtftMs: 100 }),
		];
		const round = await h.daemon.runOnce();
		expect(round.evaluation.eligible.map((c) => c.stat.groupId).sort()).toEqual(
			[1, 2],
		);
		expect(round.evaluation.standby.map((c) => c.stat.groupId)).toEqual([3]);
		expect(round.evaluation.excluded).toHaveLength(0);

		for (let index = 0; index < 8; index++) {
			const key = await h.daemon.route({ sessionKey: `new-${index}` });
			expect(key?.groupId === 1 || key?.groupId === 2).toBe(true);
			key?.release?.();
		}

		const fallback = await h.daemon.route({
			sessionKey: "fallback",
			failedGroupIds: [1, 2],
		});
		expect(fallback?.groupId).toBe(3);
		fallback?.release?.();

		h.affinity.bind("continued", 3);
		const continued = await h.daemon.route({
			sessionKey: "continued",
			continuity: true,
		});
		expect(continued?.groupId).toBe(3);
		continued?.release?.();
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
		// 只制造缓存/流量热度,不写入组 2 的本地 TTFT,否则会改变本用例的公开延迟前提。
		h.traffic.begin();
		h.traffic.end();
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
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", mode: "economy" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.2, avgTtftMs: 900 }), // 出价格区间 ⇒ excluded
			makeStat({ groupId: 3, rateMultiplier: 0.01, avgTtftMs: 30_000 }), // 超过省钱延迟门槛
		];
		h.observations.recordSuccess(1, 1_000);
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

		// status 含候选、排除原因和逐组使用状态
		h.affinity.bind("session-1", 1);
		h.affinity.bindResponse("resp_1", "session-1", 1);
		h.traffic.begin(1);
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
				ttft?: number;
				conservative?: number;
				successRate?: number;
				outcomeSamples?: number;
			}[];
			pool: Record<string, { keyId: number; lastUsedAt: number }>;
			affinity: { sessions: number; responseAliases: number };
			groups: Array<{
				groupId: number;
				keyId: number | null;
				sessions: number;
				responseAliases: number;
				activeRequests: number;
			}>;
			hasToken: boolean;
		};
		expect(status.currentGroupId).toBe(1);
		expect(status.pool["1"]?.keyId).toBeDefined();
		expect(status.affinity.sessions).toBe(1);
		expect(status.affinity.responseAliases).toBe(1);
		expect(status.groups.find((group) => group.groupId === 1)).toMatchObject({
			keyId: status.pool["1"]?.keyId,
			sessions: 1,
			responseAliases: 1,
			activeRequests: 1,
		});
		h.traffic.end(1);
		expect(status.hasToken).toBe(true);
		const eligible = status.candidates.find((c) => c.groupId === 1);
		expect(eligible?.successRate).toBe(1);
		expect(eligible?.outcomeSamples).toBe(1);
		const excluded = status.candidates.find((c) => c.groupId === 2);
		expect(excluded?.excluded).toBe(true);
		expect(excluded?.excludeReason).toBe("price_band");
		const tooSlow = status.candidates.find((c) => c.groupId === 3);
		expect(tooSlow).toMatchObject({
			excluded: true,
			excludeReason: "economy_too_slow",
			ttft: 30_000,
			conservative: 30_000,
		});

		// config 热更新
		const cfgRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "speed", priceBand: { min: 0, max: 0.3 } }),
		});
		expect(cfgRes.status).toBe(200);
		expect(h.config.mode).toBe("speed");
		expect(h.config.priceBand.max).toBe(0.3);

		h.config.economyPolicy = {
			minOutcomeSamples: 9,
			minSuccessRate: 0.9,
			maxConservativeLatencyMs: 40_000,
		};
		const partialCfgRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				priceBand: { max: 0.25 },
				economyPolicy: { minSuccessRate: 0.85 },
			}),
		});
		expect(partialCfgRes.status).toBe(200);
		expect(h.config.priceBand).toEqual({ min: 0, max: 0.25 });
		expect(h.config.economyPolicy).toEqual({
			minOutcomeSamples: 9,
			minSuccessRate: 0.85,
			maxConservativeLatencyMs: 40_000,
		});

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
		const apiRoot = await fetch(`${base}/v1`);
		expect(apiRoot.status).toBe(200);
		expect(await apiRoot.json()).toMatchObject({
			name: "aihub-auto",
			status: "ok",
			ui: "/ui",
		});
		const ui = await fetch(`${base}/ui`);
		expect(ui.status).toBe(200);
		const html = await ui.text();
		const csp = ui.headers.get("content-security-policy") ?? "";
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
		expect(nonce).toBeTruthy();
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toContain("'unsafe-inline'");
		expect(html).toContain(`<style nonce="${nonce}">`);
		expect(html).toContain(`<script nonce="${nonce}">`);
		expect(ui.headers.get("cache-control")).toBe("no-store");
		expect(ui.headers.get("x-content-type-options")).toBe("nosniff");
		expect(ui.headers.get("referrer-policy")).toBe("no-referrer");
		expect(html).toContain("aihub-auto");
		expect(html).not.toContain("localStorage");
		expect(html).not.toContain("sessionStorage");

		const ctl = await fetch(`${base}/ctl/status`, {
			headers: { "x-ui-password": "console-pass-123" },
		});
		expect(ctl.headers.get("cache-control")).toBe("no-store");
	});
});

describe("浏览器请求边界", () => {
	test("允许同源浏览器和无 Origin 客户端", async () => {
		h = createHarness({ withServer: true });
		const base = h.serverUrl!;
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		expect(
			(
				await fetch(`${base}/healthz`, {
					headers: { Origin: base },
				})
			).status,
		).toBe(200);
	});

	test("拒绝跨站 Origin、null Origin 和 Sec-Fetch-Site", async () => {
		h = createHarness({ withServer: true });
		const base = h.serverUrl!;
		expect(
			(
				await fetch(`${base}/ctl/status`, {
					headers: { Origin: "https://attacker.example" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${base}/ctl/status`, {
					headers: { Origin: "null" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${base}/v1/models`, {
					headers: { "Sec-Fetch-Site": "cross-site" },
				})
			).status,
		).toBe(403);
	});

	test("loopback 监听拒绝 rebound Host 并接受本机 Host", () => {
		h = createHarness();
		expect(
			browserRequestProblem(
				new Request("http://attacker.example/ctl/status"),
				h.config,
			),
		).toMatchObject({ status: 421 });
		for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
			expect(
				browserRequestProblem(
					new Request(`http://${host}:8787/ctl/status`),
					h.config,
				),
			).toBeUndefined();
		}
	});

	test("TLS 反向代理只接受受限 forwarded proto 的同 Host Origin", () => {
		h = createHarness({
			configPatch: {
				listen: { host: "0.0.0.0", port: 8787 },
				proxyToken: "proxy-token-123456",
				uiPassword: "console-pass-123",
			},
		});
		const proxied = new Request("http://router.example/ctl/status", {
			headers: {
				Origin: "https://router.example",
				"X-Forwarded-Proto": "https",
			},
		});
		expect(browserRequestProblem(proxied, h.config)).toBeUndefined();
		expect(
			browserRequestProblem(
				new Request("http://router.example/ctl/status", {
					headers: { Origin: "https://router.example" },
				}),
				h.config,
			),
		).toMatchObject({ status: 403 });
		expect(
			browserRequestProblem(
				new Request("http://router.example/ctl/status", {
					headers: {
						Origin: "https://attacker.example",
						"X-Forwarded-Proto": "https",
					},
				}),
				h.config,
			),
		).toMatchObject({ status: 403 });
	});
});

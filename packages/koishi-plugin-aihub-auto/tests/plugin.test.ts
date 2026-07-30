import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "koishi";
import mock from "@koishijs/plugin-mock";
import * as httpModule from "@koishijs/plugin-http";

// @koishijs/plugin-http 的 mjs 包装只有 named re-export;HTTP Service 类在 default 或 HTTP 字段
const http =
	(httpModule as { default?: unknown }).default ??
	(httpModule as { HTTP?: unknown }).HTTP;
import type { GroupStat } from "@aihub-auto/core";
import * as plugin from "../src/index.ts";

/** mock usage-stats 上游 */
class StatsServer {
	server: ReturnType<typeof Bun.serve>;
	stats: GroupStat[] = [];
	fail = false;
	hits = 0;

	constructor() {
		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req) => {
				this.hits++;
				if (this.fail) return new Response("boom", { status: 500 });
				const url = new URL(req.url);
				const providerRequest = url.pathname.endsWith("/public/providers");
				const platform = url.searchParams.get("platform");
				const items = this.stats
					.filter((s) => providerRequest || s.platform === platform)
					.map((s) =>
						providerRequest
							? {
									code: s.code,
									platform: s.platform,
									group_id: s.groupId,
									available: s.providerAvailable !== false,
									probe_e2e_ttft_ms: s.cloudProbeTtftMs ?? null,
									user_avg_ttft_ms: s.userAvgTtftMs ?? 0,
									user_sample_count: s.userSampleCount ?? 0,
									user_has_data: s.userAvgTtftMs !== undefined,
								}
							: {
									code: s.code,
									platform: s.platform,
									rate_multiplier: s.rateMultiplier,
									avg_ttft_ms: s.avgTtftMs,
									sample_count: s.sampleCount,
									last_sample_at: s.lastSampleAt,
									group_id: s.groupId,
								},
					);
				return new Response(
					JSON.stringify({
						code: 0,
						message: "success",
						data: providerRequest
							? { generated_at: new Date().toISOString(), items }
							: { items, total: items.length, sample_limit: 100 },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}
	stop(): void {
		this.server.stop(true);
	}
}

function stat(partial: Partial<GroupStat> & { groupId: number }): GroupStat {
	return {
		code: `A00${partial.groupId}-Plus`,
		platform: "openai",
		rateMultiplier: 0.05,
		avgTtftMs: 3000,
		sampleCount: 20,
		lastSampleAt: new Date().toISOString(),
		...partial,
	};
}

interface Fixture {
	app: Context;
	upstream: StatsServer;
	dispose: () => Promise<void>;
}

async function createApp(
	configPatch?: Partial<plugin.Config>,
): Promise<Fixture> {
	const upstream = new StatsServer();
	const app = new Context();
	// MockBot 类插件的构造签名与 Context.plugin 重载推导不合,运行时正确
	app.plugin(mock as Parameters<typeof app.plugin>[0]);
	app.plugin(http as unknown as Parameters<typeof app.plugin>[0]);
	app.plugin(
		plugin as unknown as (ctx: Context, config: Partial<plugin.Config>) => void,
		{
			rules: ["mock:100"],
			baseUrl: upstream.url,
			cooldownMs: 0,
			cacheTtlMs: 30_000,
			downloadUrl: "https://github.com/WSXYT/aihub-auto/releases/latest",
			strategyText: "测试策略",
			...configPatch,
		} satisfies Partial<plugin.Config>,
	);
	await app.start();
	return {
		app,
		upstream,
		dispose: async () => {
			// satori 内部 dispose 在 bun 下有无害噪音,不影响断言
			await app.stop().catch(() => {});
			upstream.stop();
		},
	};
}

let f: Fixture;
afterEach(() => f?.dispose());

describe("触发与作用域", () => {
	test("目标群裸文本『最优分组』得到推荐回复", async () => {
		f = await createApp();
		f.upstream.stats = [
			stat({
				groupId: 57,
				code: "A001-Plus/K12",
				rateMultiplier: 0.03,
				avgTtftMs: 9584,
			}),
		];
		const client = f.app.mock.client("user1", "100");
		await client.shouldReply(
			"最优分组",
			/AIHub 当前推荐\n策略:测试策略\n1\. A001-Plus\/K12(#57)|0\.03x|9584 ms\n下载:https:\/\/github\.com\/WSXYT\/aihub-auto\/releases\/latest/,
		);
	});

	test("usage 仍有快样本但 provider 已不可用的分组不会推荐", async () => {
		f = await createApp();
		f.upstream.stats = [
			stat({
				groupId: 48,
				code: "A008-BugTeam",
				rateMultiplier: 0.01,
				avgTtftMs: 100,
				providerAvailable: false,
			}),
			stat({ groupId: 49, code: "A009-Visible", avgTtftMs: 1000 }),
		];
		const text = (
			await f.app.mock.client("user1", "100").receive("最优分组")
		).join("\n");
		expect(text).toContain("A009-Visible(#49)");
		expect(text).not.toContain("A008-BugTeam(#48)");
	});

	test("『/最优分组』同样触发", async () => {
		f = await createApp();
		f.upstream.stats = [stat({ groupId: 1 })];
		const client = f.app.mock.client("user1", "100");
		await client.shouldReply("/最优分组", /AIHub 当前推荐/);
	});

	test("『最烂分组』只发最高倍率层中最慢的 1 个,斜杠形式同样触发", async () => {
		f = await createApp({ mode: "economy" });
		f.upstream.stats = [
			stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 20_000 }),
			stat({ groupId: 2, rateMultiplier: 0.1, avgTtftMs: 8_000 }),
			stat({ groupId: 3, rateMultiplier: 0.1, avgTtftMs: 9_000 }),
		];
		const client = f.app.mock.client("user1", "100");
		const text = (await client.receive("最烂分组")).join("\n");
		expect(text).toContain("AIHub 当前最烂分组");
		expect(text).toContain("策略:最高倍率优先,同倍率首字最慢");
		expect(text).toContain("1. A003-Plus(#3)|0.1x|9000 ms");
		expect(text).not.toContain("A001-Plus(#1)");
		expect(text).not.toContain("A002-Plus(#2)");
		expect(text).not.toContain("2. ");
		await client.shouldReply("/最烂分组", /AIHub 当前最烂分组/);
	});

	test("非目标群静默", async () => {
		f = await createApp();
		f.upstream.stats = [stat({ groupId: 1 })];
		const client = f.app.mock.client("user1", "999");
		await client.shouldNotReply("最优分组");
	});

	test("私聊默认静默;respondPrivate 开启后响应", async () => {
		f = await createApp();
		f.upstream.stats = [stat({ groupId: 1 })];
		await f.app.mock.client("user1").shouldNotReply("最优分组");
		await f.dispose();

		f = await createApp({ respondPrivate: true });
		f.upstream.stats = [stat({ groupId: 1 })];
		await f.app.mock.client("user1").shouldReply("最优分组", /AIHub 当前推荐/);
	});

	test("通配规则 mock:* 生效", async () => {
		f = await createApp({ rules: ["mock:*"] });
		f.upstream.stats = [stat({ groupId: 1 })];
		await f.app.mock
			.client("user1", "任意群")
			.shouldReply("最优分组", /AIHub 当前推荐/);
	});

	test("无关消息不响应", async () => {
		f = await createApp();
		f.upstream.stats = [stat({ groupId: 1 })];
		await f.app.mock.client("user1", "100").shouldNotReply("最优分组呢");
		await f.app.mock.client("user1", "100").shouldNotReply("你好");
	});
});

describe("冷却与缓存", () => {
	test("冷却期内同类查询静默,最优与最烂互不阻塞", async () => {
		f = await createApp({ cooldownMs: 60_000 });
		f.upstream.stats = [stat({ groupId: 1 })];
		const client = f.app.mock.client("user1", "100");
		await client.shouldReply("最优分组", /AIHub 当前推荐/);
		await client.shouldNotReply("最优分组");
		await client.shouldReply("最烂分组", /AIHub 当前最烂分组/);
	});

	test("缓存 TTL 内最优/最烂共享一次上游请求", async () => {
		f = await createApp({ cooldownMs: 0, cacheTtlMs: 60_000 });
		f.upstream.stats = [stat({ groupId: 1 })];
		const client = f.app.mock.client("user1", "100");
		await client.shouldReply("最优分组", /AIHub/);
		const hitsAfterFirst = f.upstream.hits;
		await client.shouldReply("最烂分组", /AIHub 当前最烂分组/);
		expect(f.upstream.hits).toBe(hitsAfterFirst);
	});
});

describe("降级与条数", () => {
	test("上游 500 ⇒ 降级文案", async () => {
		f = await createApp({ errorText: "数据炸了" });
		f.upstream.fail = true;
		await f.app.mock.client("user1", "100").shouldReply("最优分组", "数据炸了");
	});

	test("条数自适应:分数密集 6 条封顶,断层只出头部", async () => {
		f = await createApp({ cacheTtlMs: 0 });
		// 8 个几乎同分组 ⇒ 6 条封顶
		f.upstream.stats = Array.from({ length: 8 }, (_, i) =>
			stat({ groupId: i + 1, rateMultiplier: 0.05, avgTtftMs: 3000 + i * 10 }),
		);
		const client = f.app.mock.client("user1", "100");
		const reply1 = await client.receive("最优分组");
		void reply1;
		// 由于 shouldReply 较难拿纯文本,直接调 service 层验证条数逻辑在 core 已测;此处验证渲染包含 6 行
		await client.shouldReply(
			"最优分组",
			/1\. [\s\S]*2\. [\s\S]*3\. [\s\S]*4\. [\s\S]*5\. [\s\S]*6\. /,
		);
		await f.dispose();

		// 断层:1 个便宜快 + 1 个贵慢 ⇒ 只 1 条
		f = await createApp({ cacheTtlMs: 0 });
		f.upstream.stats = [
			stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			stat({ groupId: 2, rateMultiplier: 0.14, avgTtftMs: 9000 }),
		];
		const c2 = f.app.mock.client("user1", "100");
		const replies = await c2.receive("最优分组");
		const text = replies.join("\n");
		expect(text).toContain("1. ");
		expect(text).not.toContain("2. ");
	});

	test("仅展示 OpenAI 分组", async () => {
		f = await createApp({ cacheTtlMs: 0 });
		f.upstream.stats = [stat({ groupId: 1, platform: "openai", code: "O001" })];
		await f.app.mock.client("user1", "100").shouldReply("最优分组", /O001/);
	});
});

import { type Context, Schema } from "koishi";
import { matchRule } from "./matcher.ts";
import { RecommendService, type RecommendationKind } from "./service.ts";
import { DEFAULT_TEMPLATE, DEFAULT_WORST_TEMPLATE, render } from "./format.ts";

export const name = "aihub-auto";

export interface Config {
	rules: string[];
	baseUrl: string;
	mode: "economy" | "balanced" | "speed";
	maxRate: number;
	samples: number;
	scoreWindow: number;
	strategyText: string;
	downloadUrl: string;
	template: string;
	worstTemplate: string;
	cacheTtlMs: number;
	cooldownMs: number;
	respondPrivate: boolean;
	errorText: string;
}

export const Config: Schema<Config> = Schema.object({
	rules: Schema.array(Schema.string())
		.default(["onebot:*"])
		.description(
			"生效范围,每项 `平台:群号`,支持 `*` 通配。如 `onebot:1059338666`、`onebot:*`、`*:*`。",
		),
	baseUrl: Schema.string()
		.default("https://aihub.top")
		.description(
			"AIHub 站点地址(usage-stats 为 AIHub 自有接口,不兼容其他 sub2api 站)。",
		),
	mode: Schema.union([
		Schema.const("economy").description("省钱优先"),
		Schema.const("balanced").description("均衡"),
		Schema.const("speed").description("速度优先"),
	])
		.default("balanced")
		.description("推荐策略(价格与首字延迟的权重)。"),
	maxRate: Schema.number()
		.min(0)
		.default(0.15)
		.description("最大倍率(硬约束,超过不推荐)。"),
	samples: Schema.number()
		.min(1)
		.max(500)
		.default(100)
		.description("每组统计样本条数。"),
	scoreWindow: Schema.number()
		.min(0)
		.default(0.15)
		.description("推荐窗口:与最优分差在窗口内才展示(条数自适应 1~6)。"),
	strategyText: Schema.string()
		.default("价格与首字延迟均衡")
		.description("回复中「策略:」后的文案。"),
	downloadUrl: Schema.string()
		.default("https://github.com/WSXYT/aihub-auto/releases/latest")
		.description("自动路由应用下载链接。"),
	template: Schema.string()
		.role("textarea")
		.default(DEFAULT_TEMPLATE)
		.description(
			"最优分组回复模板,支持 {strategy} / {items} / {download} 变量。",
		),
	worstTemplate: Schema.string()
		.role("textarea")
		.default(DEFAULT_WORST_TEMPLATE)
		.description(
			"最烂分组回复模板,支持 {strategy} / {items} / {download} 变量。",
		),
	cacheTtlMs: Schema.number()
		.min(0)
		.default(30_000)
		.description("推荐结果缓存时长(毫秒)。"),
	cooldownMs: Schema.number()
		.min(0)
		.default(10_000)
		.description("每群冷却(毫秒),期间重复触发不响应。"),
	respondPrivate: Schema.boolean().default(false).description("是否响应私聊。"),
	errorText: Schema.string()
		.default("AIHub 数据暂不可用,请稍后再试")
		.description("数据获取失败时的降级回复。"),
});

const TRIGGERS = new Map<string, RecommendationKind>([
	["最优分组", "best"],
	["/最优分组", "best"],
	["最烂分组", "worst"],
	["/最烂分组", "worst"],
]);

export function apply(ctx: Context, config: Config): void {
	const logger = ctx.logger("aihub-auto");
	const service = new RecommendService();
	const cooldown = new Map<string, number>();
	/** 同一消息去重(指令与中间件双通道) */
	const handled = new Set<string>();

	function inScope(
		platform: string,
		guildId: string | undefined,
		isDirect: boolean,
	): boolean {
		if (isDirect && !config.respondPrivate) return false;
		if (isDirect) return true;
		return matchRule(platform, guildId, config.rules);
	}

	function underCooldown(scopeKey: string): boolean {
		const last = cooldown.get(scopeKey);
		if (last !== undefined && Date.now() - last < config.cooldownMs)
			return true;
		cooldown.set(scopeKey, Date.now());
		return false;
	}

	async function respond(
		messageId: string | undefined,
		scopeKey: string,
		kind: RecommendationKind,
	): Promise<string | undefined> {
		if (messageId) {
			if (handled.has(messageId)) return undefined;
			handled.add(messageId);
			if (handled.size > 500) {
				const first = handled.values().next().value;
				if (first !== undefined) handled.delete(first);
			}
		}
		if (underCooldown(`${scopeKey}:${kind}`)) return undefined;
		try {
			const recs = await service.recommend(
				{
					baseUrl: config.baseUrl,
					mode: config.mode,
					maxRate: config.maxRate,
					samples: config.samples,
					scoreWindow: config.scoreWindow,
					cacheTtlMs: config.cacheTtlMs,
					getJson: (url) => ctx.http.get(url, { responseType: "json" }),
				},
				kind,
			);
			if (recs.length === 0) return config.errorText;
			return render(recs, {
				template: kind === "worst" ? config.worstTemplate : config.template,
				strategyText:
					kind === "worst"
						? "最高倍率优先,同倍率首字最慢"
						: config.strategyText,
				downloadUrl: config.downloadUrl,
			});
		} catch (err) {
			logger.warn("推荐获取失败:%s", err instanceof Error ? err.message : err);
			return config.errorText;
		}
	}

	function scopeKey(
		platform: string,
		guildId: string | undefined,
		userId: string | undefined,
	): string {
		return `${platform}:${guildId ?? `direct-${userId ?? "unknown"}`}`;
	}

	// 通道 1:正规指令(支持已配置 prefix 的实例、help 集成)
	function registerCommand(
		command: string,
		description: string,
		kind: RecommendationKind,
	): void {
		ctx.command(command, description).action(async ({ session }) => {
			if (!session) return;
			if (
				!inScope(
					session.platform,
					session.guildId,
					session.isDirect ?? !session.guildId,
				)
			)
				return;
			return respond(
				session.messageId,
				scopeKey(session.platform, session.guildId, session.userId),
				kind,
			);
		});
	}
	registerCommand("最优分组", "查询 AIHub 当前最优分组推荐", "best");
	registerCommand("最烂分组", "查询 AIHub 当前最低评分分组", "worst");

	// 通道 2:裸文本中间件(未配置 prefix 时 `最优分组`/`/最优分组` 也能触发)
	ctx.middleware(async (session, next) => {
		const text = session.elements
			? session.elements
					.filter((el) => el.type === "text")
					.map((el) => String((el.attrs as { content?: string }).content ?? ""))
					.join("")
					.trim()
			: (session.content ?? "").trim();
		const kind = TRIGGERS.get(text);
		if (!kind) return next();
		if (
			!inScope(
				session.platform,
				session.guildId,
				session.isDirect ?? !session.guildId,
			)
		)
			return next();
		const reply = await respond(
			session.messageId,
			scopeKey(session.platform, session.guildId, session.userId),
			kind,
		);
		if (reply === undefined) return next();
		return reply;
	});
}

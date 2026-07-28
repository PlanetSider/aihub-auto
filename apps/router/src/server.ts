import type { AIHubClient } from "@aihub-auto/core";
import type { AppConfig, AppState, Credentials, FileStore } from "./config.ts";
import { ConfigSchema } from "./config.ts";
import type { RouteDaemon } from "./daemon.ts";
import type { RouteExecutor } from "./executor.ts";
import { handleProxy, type ProxyDeps } from "./proxy.ts";
import type { Logger } from "./logger.ts";
import { UI_HTML } from "./ui.ts";

export interface ServerDeps {
	config: AppConfig;
	state: AppState;
	credentials: Credentials;
	client: AIHubClient;
	daemon: RouteDaemon;
	executor: RouteExecutor;
	proxyDeps: ProxyDeps;
	store: FileStore;
	logger: Logger;
	persistConfig: () => Promise<void>;
	persistCredentials: () => Promise<void>;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** /ctl 鉴权:配置了 uiPassword 则必须携带(常数时间比较防时序侧信道) */
function ctlAuthorized(req: Request, config: AppConfig): boolean {
	if (!config.uiPassword) return true;
	const given = req.headers.get("x-ui-password") ?? "";
	const want = config.uiPassword;
	if (given.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < want.length; i++)
		diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
	return diff === 0;
}

export async function handleControl(
	req: Request,
	url: URL,
	deps: ServerDeps,
): Promise<Response> {
	if (!ctlAuthorized(req, deps.config)) {
		return json({ error: "需要控制台口令(x-ui-password)" }, 401);
	}
	const path = url.pathname;

	if (path === "/ctl/status" && req.method === "GET") {
		const now = Date.now();
		const round = deps.daemon.lastRound;
		const candidates: Array<{
			groupId: number;
			code: string;
			rate: number;
			ttft?: number;
			conservative?: number;
			confidence?: number;
			score?: number | string;
			excluded: boolean;
			excludeReason?: string;
		}> = [];
		if (round) {
			for (const c of round.evaluation.eligible) {
				candidates.push({
					groupId: c.stat.groupId,
					code: c.stat.code,
					rate: c.effectiveRate,
					ttft: Math.round(c.blendedTtftMs),
					conservative: Math.round(c.conservativeLatencyMs),
					confidence: Number(c.confidence.toFixed(2)),
					score: Number.isFinite(c.score) ? c.score : String(c.score),
					excluded: false,
				});
			}
			for (const e of round.evaluation.excluded) {
				candidates.push({
					groupId: e.stat.groupId,
					code: e.stat.code,
					rate: e.effectiveRate ?? e.stat.rateMultiplier,
					excluded: true,
					excludeReason: e.excludeReason,
				});
			}
		}
		const affinity = deps.proxyDeps.affinity.stats(now);
		const traffic = deps.proxyDeps.traffic.snapshot(now);
		const candidateByGroup = new Map(
			candidates.map((candidate) => [candidate.groupId, candidate]),
		);
		const groupIds = new Set([
			...(deps.state.currentGroupId === undefined
				? []
				: [deps.state.currentGroupId]),
			...Object.keys(deps.state.pool).map(Number),
			...Object.keys(affinity.byGroup).map(Number),
			...Object.keys(affinity.aliasesByGroup).map(Number),
			...Object.keys(traffic.activeByGroup ?? {}).map(Number),
		]);
		const poolSize = Object.keys(deps.state.pool).length;
		const groups = [...groupIds]
			.sort((left, right) => left - right)
			.map((groupId) => {
				const candidate = candidateByGroup.get(groupId);
				const key = deps.state.pool[String(groupId)];
				const sessions = affinity.byGroup[String(groupId)] ?? 0;
				const responseAliases = affinity.aliasesByGroup[String(groupId)] ?? 0;
				const activeRequests = traffic.activeByGroup?.[String(groupId)] ?? 0;
				const idleMs = key ? Math.max(now - key.lastUsedAt, 0) : undefined;
				const protectedGroup =
					groupId === deps.state.currentGroupId ||
					sessions > 0 ||
					responseAliases > 0 ||
					activeRequests > 0;
				return {
					groupId,
					code: candidate?.code ?? null,
					rate: candidate?.rate ?? null,
					current: groupId === deps.state.currentGroupId,
					keyId: key?.keyId ?? null,
					keyLastUsedAt: key?.lastUsedAt ?? null,
					idleMs: idleMs ?? null,
					sessions,
					responseAliases,
					activeRequests,
					reclaimable: Boolean(
						key &&
							poolSize > deps.config.poolMaxGroups &&
							!protectedGroup &&
							idleMs !== undefined &&
							idleMs >= deps.config.decision.cacheIdleMs,
					),
				};
			});
		const currentCode = candidateByGroup.get(
			deps.state.currentGroupId ?? -1,
		)?.code;
		return json({
			currentGroupId: deps.state.currentGroupId ?? null,
			currentCode: currentCode ?? null,
			config: {
				mode: deps.config.mode,
				keyMode: deps.config.keyMode,
				poolMaxGroups: deps.config.poolMaxGroups,
				priceBand: deps.config.priceBand,
				cacheIdleMs: deps.config.decision.cacheIdleMs,
				blacklist: deps.config.blacklist,
			},
			pool: Object.fromEntries(
				Object.entries(deps.state.pool).map(([groupId, entry]) => [
					groupId,
					{ keyId: entry.keyId, lastUsedAt: entry.lastUsedAt },
				]),
			),
			groups,
			affinity,
			modelBlocks: deps.daemon.modelBlockStats(),
			hasToken: Boolean(deps.credentials.accessToken),
			needsReauth: deps.daemon.needsReauth,
			traffic,
			stale: round?.stale ?? false,
			candidates,
		});
	}

	if (path === "/ctl/config" && req.method === "POST") {
		let patch: Record<string, unknown>;
		try {
			patch = (await req.json()) as Record<string, unknown>;
		} catch {
			return json({ error: "非法 JSON" }, 400);
		}
		const restartRequired = ["keyMode", "poolMaxGroups"].filter(
			(key) => key in patch,
		);
		if (restartRequired.length > 0) {
			return json(
				{ error: `${restartRequired.join(", ")} 只能修改配置文件并重启生效` },
				409,
			);
		}
		const allowed = [
			"mode",
			"priceBand",
			"blacklist",
			"pollIntervalMs",
			"samples",
		];
		const merged: Record<string, unknown> = { ...deps.config };
		for (const k of allowed) {
			if (k in patch) merged[k] = patch[k];
		}
		const parsed = ConfigSchema.safeParse(merged);
		if (!parsed.success) {
			return json(
				{
					error: `配置校验失败:${parsed.error.issues.map((i) => i.message).join("; ")}`,
				},
				400,
			);
		}
		Object.assign(deps.config, parsed.data);
		await deps.persistConfig();
		return json({ ok: true });
	}

	if (path === "/ctl/login" && req.method === "POST") {
		let body: { email?: string; password?: string; token?: string };
		try {
			body = (await req.json()) as typeof body;
		} catch {
			return json({ error: "非法 JSON" }, 400);
		}
		try {
			if (body.token) {
				deps.credentials.accessToken = body.token.trim();
			} else if (body.email && body.password) {
				const session = await deps.client.login(body.email, body.password);
				deps.credentials.accessToken = session.accessToken;
				deps.credentials.refreshToken = session.refreshToken;
				deps.credentials.expiresAt = session.expiresAt;
			} else {
				return json({ error: "需要 email+password 或 token" }, 400);
			}
			await deps.persistCredentials();
			deps.daemon.needsReauth = false;
			// 登录后立刻验证 + 触发一轮路由
			await deps.client.me();
			return json({ ok: true });
		} catch (err) {
			return json(
				{ error: err instanceof Error ? err.message : "登录失败" },
				400,
			);
		}
	}

	if (path === "/ctl/route-once" && req.method === "POST") {
		let body: { dryRun?: boolean } = {};
		try {
			body = (await req.json()) as typeof body;
		} catch {
			/* 允许空 body */
		}
		const round = await deps.daemon.runOnce({ dryRun: body.dryRun ?? false });
		const d = round.decision;
		return json({
			reason: d.reason,
			shouldSwitch: d.shouldSwitch,
			targetGroupId: d.targetGroupId ?? null,
			advantage: d.advantage ?? null,
			effectiveThreshold: d.effectiveThreshold,
			executed: round.executed,
			stale: round.stale,
		});
	}

	return json({ error: "未知控制路径" }, 404);
}

export function createServer(deps: ServerDeps): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: deps.config.listen.host,
		port: deps.config.listen.port,
		idleTimeout: 0,
		fetch: async (req) => {
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return json({ error: "非法 URL" }, 400);
			}
			const path = url.pathname;

			if (path === "/" || path === "/ui" || path === "/ui/") {
				return new Response(UI_HTML, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}
			if (path.startsWith("/ctl/")) {
				return handleControl(req, url, deps);
			}
			if (path === "/healthz") {
				return json({ ok: true, group: deps.state.currentGroupId ?? null });
			}
			if (path === "/v1" || path === "/v1/") {
				return json(
					{
						name: "aihub-auto",
						status: "ok",
						message: "OpenAI-compatible API proxy. Use a concrete /v1 endpoint.",
						ui: "/ui",
					},
					req.method === "GET" || req.method === "HEAD" ? 200 : 404,
				);
			}
			// 其余全部按上游 API 反代
			return handleProxy(req, deps.proxyDeps);
		},
		error: (err) => {
			deps.logger.error(`服务器错误:${err.message}`);
			return json({ error: "内部错误" }, 500);
		},
	});
}

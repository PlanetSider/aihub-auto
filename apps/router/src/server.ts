import type { AIHubClient, ExcludeReason } from "@aihub-auto/core";
import type { AppConfig, AppState, Credentials, FileStore } from "./config.ts";
import { ConfigSchema } from "./config.ts";
import type { RouteDaemon } from "./daemon.ts";
import type { RouteExecutor } from "./executor.ts";
import { handleProxy, type ProxyDeps } from "./proxy.ts";
import type { Logger } from "./logger.ts";
import { captureRouterException } from "./sentry.ts";
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
	persistState: () => Promise<void>;
	persistCredentials: () => Promise<void>;
	/** 实际使用的公共 DSN(可能来自 SENTRY_DSN 环境变量)。 */
	sentryDsn: string;
	syncSentryUser: (email?: string) => void;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const MANUAL_LOCK_OVERRIDE_REASONS = new Set<ExcludeReason>([
	"economy_unstable",
	"economy_too_slow",
]);

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
			cloudProbeTtft?: number;
			userTtft?: number;
			userSamples?: number;
			upstreamTtft?: number;
			localTtft?: number;
			localWeight?: number;
			localSamples?: number;
			successRate?: number;
			outcomeSamples?: number;
			score?: number | string;
			standby?: boolean;
			excluded: boolean;
			excludeReason?: string;
			forceable: boolean;
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
					cloudProbeTtft: c.cloudProbeTtftMs
						? Math.round(c.cloudProbeTtftMs)
						: undefined,
					userTtft: c.userTtftMs ? Math.round(c.userTtftMs) : undefined,
					userSamples: c.userSampleCount,
					upstreamTtft: c.upstreamTtftMs
						? Math.round(c.upstreamTtftMs)
						: undefined,
					localTtft: c.localTtftMs ? Math.round(c.localTtftMs) : undefined,
					localWeight: Number(c.localConfidence.toFixed(2)),
					localSamples: c.localSampleCount,
					successRate: Number(c.successRate.toFixed(3)),
					outcomeSamples: c.outcomeSampleCount,
					score: Number.isFinite(c.score) ? c.score : String(c.score),
					excluded: false,
					forceable: true,
				});
			}
			for (const c of round.evaluation.standby) {
				candidates.push({
					groupId: c.stat.groupId,
					code: c.stat.code,
					rate: c.effectiveRate,
					ttft: Math.round(c.blendedTtftMs),
					conservative: Math.round(c.conservativeLatencyMs),
					confidence: Number(c.confidence.toFixed(2)),
					cloudProbeTtft: c.cloudProbeTtftMs
						? Math.round(c.cloudProbeTtftMs)
						: undefined,
					userTtft: c.userTtftMs ? Math.round(c.userTtftMs) : undefined,
					userSamples: c.userSampleCount,
					upstreamTtft: c.upstreamTtftMs
						? Math.round(c.upstreamTtftMs)
						: undefined,
					localTtft: c.localTtftMs ? Math.round(c.localTtftMs) : undefined,
					localWeight: Number(c.localConfidence.toFixed(2)),
					localSamples: c.localSampleCount,
					successRate: Number(c.successRate.toFixed(3)),
					outcomeSamples: c.outcomeSampleCount,
					score: Number.isFinite(c.score) ? c.score : String(c.score),
					standby: true,
					excluded: false,
					forceable: true,
				});
			}
			for (const e of round.evaluation.excluded) {
				candidates.push({
					groupId: e.stat.groupId,
					code: e.stat.code,
					rate: e.effectiveRate ?? e.stat.rateMultiplier,
					ttft: e.evidence ? Math.round(e.evidence.blendedTtftMs) : undefined,
					conservative: e.evidence
						? Math.round(e.evidence.conservativeLatencyMs)
						: undefined,
					confidence: e.evidence
						? Number(e.evidence.confidence.toFixed(2))
						: undefined,
					cloudProbeTtft: e.evidence?.cloudProbeTtftMs
						? Math.round(e.evidence.cloudProbeTtftMs)
						: undefined,
					userTtft: e.evidence?.userTtftMs
						? Math.round(e.evidence.userTtftMs)
						: undefined,
					userSamples: e.evidence?.userSampleCount,
					upstreamTtft: e.evidence?.upstreamTtftMs
						? Math.round(e.evidence.upstreamTtftMs)
						: undefined,
					localTtft: e.evidence?.localTtftMs
						? Math.round(e.evidence.localTtftMs)
						: undefined,
					localWeight: e.evidence
						? Number(e.evidence.localConfidence.toFixed(2))
						: undefined,
					localSamples: e.evidence?.localSampleCount,
					successRate: e.evidence
						? Number(e.evidence.successRate.toFixed(3))
						: undefined,
					outcomeSamples: e.evidence?.outcomeSampleCount,
					excluded: true,
					excludeReason: e.excludeReason,
					forceable: MANUAL_LOCK_OVERRIDE_REASONS.has(e.excludeReason),
				});
			}
		}
		const affinity = deps.proxyDeps.affinity.stats(now);
		const cacheProtectedGroups = deps.proxyDeps.affinity.protectedGroupIds(
			deps.config.decision.cacheIdleMs,
			now,
		);
		const traffic = deps.proxyDeps.traffic.snapshot(now);
		const candidateByGroup = new Map(
			candidates.map((candidate) => [candidate.groupId, candidate]),
		);
		const groupIds = new Set([
			...(deps.state.currentGroupId === undefined
				? []
				: [deps.state.currentGroupId]),
			...(deps.state.manualLock.groupId === null
				? []
				: [deps.state.manualLock.groupId]),
			...Object.keys(deps.state.pool).map(Number),
			...Object.keys(affinity.byGroup).map(Number),
			...Object.keys(affinity.aliasesByGroup).map(Number),
			...Object.keys(traffic.activeByGroup ?? {}).map(Number),
		]);
		const poolSize = Object.keys(deps.state.pool).length;
		const forceReclaimReasons = new Set([
			"platform_mismatch",
			"unavailable_group",
			"invalid_rate",
			"price_band",
			"blacklisted",
			"invalid_latency",
			"local_error_rate",
		]);
		const groups = [...groupIds]
			.sort((left, right) => left - right)
			.map((groupId) => {
				const candidate = candidateByGroup.get(groupId);
				const key = deps.state.pool[String(groupId)];
				const sessions = affinity.byGroup[String(groupId)] ?? 0;
				const responseAliases = affinity.aliasesByGroup[String(groupId)] ?? 0;
				const activeRequests = traffic.activeByGroup?.[String(groupId)] ?? 0;
				const idleMs = key ? Math.max(now - key.lastUsedAt, 0) : undefined;
				const hardProtected =
					groupId === deps.state.currentGroupId || activeRequests > 0;
				const cacheProtected = cacheProtectedGroups.has(groupId);
				const forceReclaim = Boolean(
					key &&
						!round?.stale &&
						(candidate
							? candidate.excluded &&
								forceReclaimReasons.has(candidate.excludeReason ?? "")
							: Boolean(round)),
				);
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
					forceReclaim,
					reclaimable: Boolean(
						key &&
							!hardProtected &&
							((forceReclaim &&
								idleMs !== undefined &&
								idleMs >= deps.config.decision.cacheIdleMs) ||
								(poolSize > deps.config.poolMaxGroups && !cacheProtected)),
					),
					cacheProtected,
				};
			})
			.filter(
				(group) =>
					group.current ||
					group.keyId !== null ||
					group.activeRequests > 0 ||
					group.groupId === deps.state.manualLock.groupId,
			);
		const currentCode = candidateByGroup.get(
			deps.state.currentGroupId ?? -1,
		)?.code;
		const lockedCandidate =
			deps.state.manualLock.groupId === null
				? undefined
				: candidateByGroup.get(deps.state.manualLock.groupId);
		return json({
			currentGroupId: deps.state.currentGroupId ?? null,
			currentCode: currentCode ?? null,
			config: {
				mode: deps.config.mode,
				keyMode: deps.config.keyMode,
				poolMaxGroups: deps.config.poolMaxGroups,
				priceBand: deps.config.priceBand,
				economyPolicy: deps.config.economyPolicy,
				upstreamUserAgent: deps.config.upstreamUserAgent,
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
			manualLock: {
				...deps.state.manualLock,
				effective:
					deps.state.manualLock.groupId !== null &&
					Boolean(lockedCandidate?.forceable),
				reason:
					deps.state.manualLock.groupId === null || lockedCandidate?.forceable
						? null
						: (lockedCandidate?.excludeReason ?? "missing_group"),
			},
			affinity,
			modelBlocks: deps.daemon.modelBlockStats(),
			sentry: {
				dsn: deps.sentryDsn,
				userEmail: deps.credentials.accessToken
					? (deps.credentials.email ?? null)
					: null,
			},
			hasToken: Boolean(deps.credentials.accessToken),
			needsReauth: deps.daemon.needsReauth,
			traffic,
			stale: round?.stale ?? false,
			candidates,
		});
	}

	if (path === "/ctl/route-lock" && req.method === "PUT") {
		let body: Record<string, unknown>;
		try {
			body = (await req.json()) as Record<string, unknown>;
		} catch {
			return json({ error: "非法 JSON" }, 400);
		}
		if (
			typeof body !== "object" ||
			body === null ||
			Object.keys(body).some(
				(key) => key !== "groupId" && key !== "expectedRevision",
			)
		) {
			return json(
				{ error: "锁定请求只能包含 groupId 和 expectedRevision" },
				400,
			);
		}
		const groupId = body["groupId"];
		const expectedRevision = body["expectedRevision"];
		if (
			(groupId !== null &&
				(!Number.isSafeInteger(groupId) || Number(groupId) <= 0)) ||
			!Number.isSafeInteger(expectedRevision) ||
			Number(expectedRevision) < 0
		) {
			return json(
				{
					error: "groupId 必须为正整数或 null，expectedRevision 必须为非负整数",
				},
				400,
			);
		}
		const update = await deps.daemon.updateManualLock(
			groupId === null ? null : Number(groupId),
			Number(expectedRevision),
		);
		if (!update.updated) {
			const error =
				update.conflict === "revision"
					? "锁定状态已被其他操作更新，请刷新后重试"
					: update.conflict === "not_found"
						? "当前统计中找不到该分组，请先刷新路由数据"
						: `该分组当前不可锁定:${update.reason ?? "unknown"}`;
			return json(
				{
					error,
					manualLock: update.lock,
					reason: update.reason,
				},
				409,
			);
		}
		const round = await deps.daemon.runOnce();
		return json({
			ok: true,
			manualLock: update.lock,
			currentGroupId: deps.state.currentGroupId ?? null,
			executed: round.executed,
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
			"economyPolicy",
			"upstreamUserAgent",
			"blacklist",
			"pollIntervalMs",
			"samples",
		];
		const configUpdate = await deps.daemon.runControlMutation(async () => {
			const merged: Record<string, unknown> = { ...deps.config };
			for (const k of allowed) {
				if (k in patch) merged[k] = patch[k];
			}
			if (
				patch.priceBand &&
				typeof patch.priceBand === "object" &&
				!Array.isArray(patch.priceBand)
			) {
				merged.priceBand = { ...deps.config.priceBand, ...patch.priceBand };
			}
			if (
				patch.economyPolicy &&
				typeof patch.economyPolicy === "object" &&
				!Array.isArray(patch.economyPolicy)
			) {
				merged.economyPolicy = {
					...deps.config.economyPolicy,
					...patch.economyPolicy,
				};
			}
			const parsed = ConfigSchema.safeParse(merged);
			if (!parsed.success) {
				return {
					ok: false as const,
					error: `配置校验失败:${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
				};
			}
			Object.assign(deps.config, parsed.data);
			await deps.persistConfig();
			return { ok: true as const };
		});
		if (!configUpdate.ok) return json({ error: configUpdate.error }, 400);
		const round = await deps.daemon.runOnce();
		return json({
			ok: true,
			decision: round.decision,
			executed: round.executed,
		});
	}

	if (path === "/ctl/login" && req.method === "POST") {
		let body: { email?: string; password?: string; token?: string };
		try {
			body = (await req.json()) as typeof body;
		} catch {
			return json({ error: "非法 JSON" }, 400);
		}
		const previousCredentials = { ...deps.credentials };
		try {
			if (body.token) {
				deps.credentials.accessToken = body.token.trim();
				deps.credentials.refreshToken = undefined;
				deps.credentials.expiresAt = undefined;
			} else if (body.email && body.password) {
				const session = await deps.client.login(body.email, body.password);
				deps.credentials.accessToken = session.accessToken;
				deps.credentials.refreshToken = session.refreshToken;
				deps.credentials.expiresAt = session.expiresAt;
			} else {
				return json({ error: "需要 email+password 或 token" }, 400);
			}
			// 登录后立刻验证身份;只有验证成功才覆盖持久化凭据和 Sentry user。
			const me = await deps.client.me();
			const value = typeof me["email"] === "string" ? me["email"].trim() : "";
			const fallback = body.email?.trim() ?? "";
			const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
				? value
				: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fallback)
					? fallback
					: undefined;
			deps.credentials.email = email;
			await deps.persistCredentials();
			deps.syncSentryUser(email);
			deps.daemon.needsReauth = false;
			return json({ ok: true });
		} catch (err) {
			for (const key of Object.keys(deps.credentials)) {
				delete deps.credentials[key as keyof Credentials];
			}
			Object.assign(deps.credentials, previousCredentials);
			deps.syncSentryUser(previousCredentials.email);
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
						message:
							"OpenAI-compatible API proxy. Use a concrete /v1 endpoint.",
						ui: "/ui",
					},
					req.method === "GET" || req.method === "HEAD" ? 200 : 404,
				);
			}
			// 其余全部按上游 API 反代
			return handleProxy(req, deps.proxyDeps);
		},
		error: (err) => {
			captureRouterException(err, "bun_server");
			deps.logger.error(`服务器错误:${err.message}`);
			return json({ error: "内部错误" }, 500);
		},
	});
}

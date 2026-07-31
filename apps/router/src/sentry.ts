import * as Sentry from "@sentry/bun";
import { AIHubApiError } from "@aihub-auto/core";
import packageJson from "../package.json" with { type: "json" };

const UPSTREAM_ERROR =
	/\b(OpenAI|AIHub) API error\b|\b(?:401|408|409|429|5\d\d) status code\b|TTFB timeout|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket (?:closed|hang up)|client aborted|AbortError|TimeoutError/i;
const NON_ERROR_INTEGRATIONS = new Set([
	"BunServer",
	"Console",
	"ContextLines",
	"Http",
	"NodeFetch",
	"OnUncaughtException",
	"OnUnhandledRejection",
	"ProcessSession",
	"RequestData",
]);

let enabled = false;

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return typeof error === "string" ? error : "";
}

/** AIHub/OpenAI 响应、网络失败和主动取消是路由输入,不是应用异常。 */
export function isExpectedUpstreamError(error: unknown): boolean {
	return (
		error instanceof AIHubApiError || UPSTREAM_ERROR.test(errorText(error))
	);
}

function eventErrorText(event: Sentry.Event): string {
	return [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	]
		.filter((value): value is string => Boolean(value))
		.join(" ");
}

export interface RouterSentryOptions {
	dsn: string;
	upstreamBaseUrl: string;
}

export function initRouterSentry(options: RouterSentryOptions): boolean {
	const dsn = options.dsn.trim();
	if (!dsn) return false;
	const upstreamBaseUrl = options.upstreamBaseUrl.replace(/\/$/, "");
	Sentry.init({
		dsn,
		release: `aihub-auto@${packageJson.version}`,
		environment: "production",
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: { request: false, response: false },
			httpBodies: [],
			urlQueryParams: false,
			graphQL: { document: false, variables: false },
			genAI: { inputs: false, outputs: false },
			databaseQueryData: false,
			stackFrameVariables: false,
			frameContextLines: 0,
		},
		// 只保留错误堆栈所需集成;请求跟踪、console、session 和性能事件全部关闭。
		integrations(defaultIntegrations) {
			return defaultIntegrations.filter(
				(integration) => !NON_ERROR_INTEGRATIONS.has(integration.name),
			);
		},
		beforeBreadcrumb(breadcrumb) {
			const url = breadcrumb.data?.["url"];
			if (typeof url === "string" && url.startsWith(upstreamBaseUrl))
				return null;
			return breadcrumb;
		},
		beforeSend(event, hint) {
			if (
				isExpectedUpstreamError(hint.originalException) ||
				UPSTREAM_ERROR.test(eventErrorText(event))
			)
				return null;
			return event;
		},
	});
	enabled = true;
	Sentry.setUser(null);
	Sentry.setTags({ component: "router", runtime: "bun" });
	return true;
}

export function syncSentryUser(email?: string): void {
	if (!enabled) return;
	Sentry.setUser(email ? { email } : null);
}

/** 只供已分类为路由器自身缺陷的显式捕获点使用。 */
export function captureRouterException(
	error: unknown,
	source: string,
): string | undefined {
	if (!enabled || isExpectedUpstreamError(error)) return undefined;
	return Sentry.captureException(error, { tags: { source } });
}

export async function flushRouterSentry(timeoutMs = 2_000): Promise<boolean> {
	return enabled ? Sentry.flush(timeoutMs) : true;
}

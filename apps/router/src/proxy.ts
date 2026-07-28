import type { LocalObservationStore, Platform } from "@aihub-auto/core";
import type { RouteRequest } from "./daemon.ts";
import type { ActiveKey } from "./executor.ts";
import type { Logger } from "./logger.ts";
import {
	findResponseId,
	requestRoutingContext,
	type SessionAffinity,
} from "./session.ts";
import type { TrafficTracker } from "./traffic.ts";

export interface ProxyDeps {
	baseUrl: string;
	keyMode: "single" | "pool";
	route: (request: RouteRequest) => Promise<ActiveKey | undefined>;
	reportFailure: (groupId: number) => void;
	reportSuccess: (groupId: number) => void;
	reportNeutral: (groupId: number) => void;
	reportModelIncompatible: (groupId: number, model: string) => void;
	reportModelSupported: (groupId: number, model: string | undefined) => void;
	affinity: SessionAffinity;
	observations: LocalObservationStore;
	traffic: TrafficTracker;
	logger: Logger;
	ttfbTimeoutMs: number;
	maxRetries?: number;
	/** 请求体缓冲上限(重试需要);超限直通不可重试 */
	maxBufferBytes?: number;
	proxyToken?: string;
	fetch?: typeof globalThis.fetch;
}

const MAX_ERROR_BYTES = 16 * 1024;
const MAX_RESPONSE_ID_BYTES = 16 * 1024;
const MAX_USAGE_BYTES = 64 * 1024;
const SINGLE_REQUESTS = new WeakMap<ProxyDeps, Promise<void>>();

interface ByteReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
}

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
	"authorization",
	"x-api-key",
]);

export function detectPlatform(_path: string, _headers: Headers): Platform {
	return "openai";
}

/** /openai/v1/... -> /v1/...;原生 /v1/... 不变。 */
export function upstreamPath(path: string): string {
	const match = path.match(/^\/openai(\/.*)$/);
	return match ? match[1]! : path;
}

function upstreamFailure(status: number): boolean {
	return status === 429 || status >= 500;
}

function errorResponse(status: number, message: string): Response {
	return new Response(
		JSON.stringify({ error: { message, type: "aihub_auto_proxy" } }),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function findCacheUsage(
	text: string,
): { cachedTokens: number; inputTokens?: number } | undefined {
	let cachedTokens: number | undefined;
	for (const match of text.matchAll(/"cached_tokens"\s*:\s*(\d+)/g)) {
		cachedTokens = Number(match[1]);
	}
	if (cachedTokens === undefined) return undefined;
	let inputTokens: number | undefined;
	for (const match of text.matchAll(
		/"(?:prompt_tokens|input_tokens)"\s*:\s*(\d+)/g,
	)) {
		inputTokens = Number(match[1]);
	}
	return { cachedTokens, inputTokens };
}

async function responsePrefix(
	response: Response,
	limit: number,
	timeoutMs = 250,
): Promise<string> {
	const reader = response.clone().body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	const deadline = Date.now() + timeoutMs;
	try {
		while (size < limit) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const result = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value?: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true }), remaining),
				),
			]);
			if (result.done || !result.value) break;
			const chunk = result.value.subarray(0, Math.max(limit - size, 0));
			chunks.push(chunk);
			size += chunk.byteLength;
			if (chunk.byteLength < result.value.byteLength) break;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}

/** 只学习强模型能力信号;普通 400/404 不得污染 capability cache。 */
export async function isModelIncompatibleResponse(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400 && response.status !== 404) return false;
	const text = await responsePrefix(response, MAX_ERROR_BYTES);
	if (!text) return false;
	let error: Record<string, unknown> = {};
	try {
		const body = record(JSON.parse(text));
		error = record(body?.["error"]) ?? body ?? {};
	} catch {
		// 某些兼容上游返回 text/plain;下方仍只匹配强语义短语。
	}
	const code = String(error["code"] ?? "")
		.toLowerCase()
		.replaceAll("-", "_");
	if (
		["model_not_found", "unsupported_model", "model_not_supported"].includes(
			code,
		)
	) {
		return true;
	}
	const detail = String(error["message"] ?? error["detail"] ?? text)
		.toLowerCase()
		.replace(/[\s_-]+/g, " ");
	if (
		response.status === 400 &&
		detail.includes("model is not supported when using codex")
	) {
		return true;
	}
	return (
		/(?:\bmodel\b|模型)/.test(detail) &&
		/(\bnot supported\b|\bunsupported\b|\bunknown model\b|\bmodel not found\b|不支持|不可用|不存在)/.test(
			detail,
		)
	);
}

/** OpenAI 反代:会话亲和、流式观测、请求本地故障转移。 */
export async function handleProxy(
	req: Request,
	deps: ProxyDeps,
): Promise<Response> {
	if (deps.keyMode !== "single") return handleProxyRequest(req, deps);
	const previous = SINGLE_REQUESTS.get(deps) ?? Promise.resolve();
	let unlock!: () => void;
	const current = new Promise<void>((resolve) => {
		unlock = resolve;
	});
	SINGLE_REQUESTS.set(deps, current);
	await previous;
	let unlocked = false;
	const finish = () => {
		if (unlocked) return;
		unlocked = true;
		unlock();
		if (SINGLE_REQUESTS.get(deps) === current) SINGLE_REQUESTS.delete(deps);
	};
	try {
		const response = await handleProxyRequest(req, deps);
		if (!response.body) {
			finish();
			return response;
		}
		const reader = response.body.getReader();
		let bodyClosed = false;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (bodyClosed) return;
					if (done) {
						bodyClosed = true;
						finish();
						controller.close();
					} else controller.enqueue(value);
				} catch (err) {
					finish();
					if (!bodyClosed) {
						bodyClosed = true;
						controller.error(err);
					}
				}
			},
			async cancel(reason) {
				bodyClosed = true;
				try {
					await reader.cancel(reason).catch(() => {});
				} finally {
					finish();
				}
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (err) {
		finish();
		throw err;
	}
}

async function handleProxyRequest(
	req: Request,
	deps: ProxyDeps,
): Promise<Response> {
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		return errorResponse(400, "非法请求 URL");
	}
	const path = upstreamPath(url.pathname) + url.search;
	const fetchFn = deps.fetch ?? globalThis.fetch;
	const maxRetries = deps.maxRetries ?? 2;
	const maxBuffer = deps.maxBufferBytes ?? 20 * 1024 * 1024;

	if (deps.proxyToken) {
		const auth = req.headers.get("authorization") ?? "";
		const key = req.headers.get("x-api-key") ?? "";
		if (auth !== `Bearer ${deps.proxyToken}` && key !== deps.proxyToken) {
			return errorResponse(401, "代理口令错误");
		}
	}

	let body: ArrayBuffer | undefined;
	let retriable = true;
	if (req.body) {
		const length = Number(req.headers.get("content-length") ?? "0");
		if (length > 0 && length <= maxBuffer) {
			body = await req.arrayBuffer();
		} else if (length === 0) {
			body = await req.arrayBuffer();
			if (body.byteLength > maxBuffer) retriable = false;
		} else {
			retriable = false;
		}
	}

	const context = requestRoutingContext(path, req.headers, body, (responseId) =>
		deps.affinity.resolveResponse(responseId),
	);
	let active: ActiveKey | undefined;
	try {
		active = await deps.route(context);
	} catch (err) {
		deps.logger.error(
			`路由准备失败:${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!active) {
		return errorResponse(503, "路由器未就绪:没有可用分组或尚未完成 AIHub 登录");
	}

	const headers = new Headers();
	req.headers.forEach((value, name) => {
		if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
	});

	const failedGroups: number[] = [];
	let trackedGroup = active.groupId;
	let lastError: Response | undefined;
	let streaming = false;
	deps.traffic.begin(trackedGroup);
	active.release?.();

	const rollbackActive = (): boolean => {
		const current = active;
		const ownedBinding = current?.isCurrentBinding?.() ?? !context.sessionKey;
		const rollback = current?.rollback;
		if (rollback) {
			current.rollback = undefined;
			rollback();
		}
		return ownedBinding;
	};
	let mayUpdateBinding = true;
	const markFailure = (groupId: number) => {
		if (failedGroups.includes(groupId)) return;
		failedGroups.push(groupId);
		deps.observations.recordFailure(groupId);
		deps.reportFailure(groupId);
	};

	try {
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				let next: ActiveKey | undefined;
				try {
					next = await deps.route({
						...context,
						updateBinding: mayUpdateBinding,
						failedGroupIds: failedGroups,
					});
				} catch (err) {
					deps.logger.warn(
						`备用路由准备失败:${err instanceof Error ? err.message : String(err)}`,
					);
					break;
				}
				if (!next) break;
				deps.traffic.move(trackedGroup, next.groupId);
				trackedGroup = next.groupId;
				active = next;
				next.release?.();
			}

			const groupId = active.groupId;
			headers.set("Authorization", `Bearer ${active.sk}`);
			const startedAt = performance.now();
			const controller = new AbortController();
			let timedOut = false;
			const timeoutError = new DOMException("TTFB timeout", "TimeoutError");
			let rejectTimeout!: (reason: unknown) => void;
			const timeout = new Promise<never>((_, reject) => {
				rejectTimeout = reject;
			});
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort(timeoutError);
				rejectTimeout(timeoutError);
			}, deps.ttfbTimeoutMs);
			const abortForClient = () => {
				const reason =
					req.signal.reason ?? new DOMException("Client aborted", "AbortError");
				controller.abort(reason);
				rejectTimeout(reason);
			};
			if (req.signal.aborted) abortForClient();
			else req.signal.addEventListener("abort", abortForClient, { once: true });
			const finishTtfb = () => {
				clearTimeout(timer);
				req.signal.removeEventListener("abort", abortForClient);
			};

			let response: Response;
			let prefetched: { done: boolean; value?: Uint8Array } | undefined;
			let firstByteAt: number | undefined;
			let upstreamReader: ByteReader | undefined;
			try {
				response = await Promise.race([
					fetchFn(`${deps.baseUrl}${path}`, {
						method: req.method,
						headers,
						body: body !== undefined ? body : req.body,
						redirect: "manual",
						signal: controller.signal,
					}),
					timeout,
				]);

				if (!upstreamFailure(response.status) && response.body) {
					upstreamReader = response.body.getReader();
					do {
						prefetched = await Promise.race([upstreamReader.read(), timeout]);
					} while (
						prefetched !== undefined &&
						!prefetched.done &&
						(prefetched.value?.byteLength ?? 0) === 0
					);
					firstByteAt = performance.now();
				} else {
					firstByteAt = performance.now();
				}
				finishTtfb();
			} catch (err) {
				finishTtfb();
				void upstreamReader?.cancel(err).catch(() => {});
				const clientCanceled = req.signal.aborted && !timedOut;
				if (clientCanceled) {
					deps.reportNeutral(groupId);
					mayUpdateBinding = rollbackActive();
					lastError = errorResponse(499, "客户端已取消请求");
					break;
				}
				deps.logger.warn(
					`上游${timedOut ? "TTFB 超时" : "连接失败"} group=${groupId} attempt=${attempt}`,
				);
				if (timedOut)
					deps.observations.recordLatency(groupId, deps.ttfbTimeoutMs);
				markFailure(groupId);
				mayUpdateBinding = rollbackActive();
				lastError = errorResponse(
					502,
					`上游${timedOut ? "TTFB 超时" : "连接失败"}(组 ${groupId})`,
				);
				if (!retriable) break;
				continue;
			}

			if (upstreamReader) {
				let firstPending = prefetched;
				let wrapperClosed = false;
				const reader = upstreamReader;
				const bodyWithFirst = new ReadableStream<Uint8Array>({
					async pull(streamController) {
						try {
							const result = firstPending ?? (await reader.read());
							firstPending = undefined;
							if (wrapperClosed) return;
							if (result.done) {
								wrapperClosed = true;
								streamController.close();
							} else if (result.value) streamController.enqueue(result.value);
						} catch (err) {
							if (!wrapperClosed) {
								wrapperClosed = true;
								streamController.error(err);
							}
						}
					},
					async cancel(reason) {
						wrapperClosed = true;
						await reader.cancel(reason).catch(() => {});
					},
				});
				response = new Response(bodyWithFirst, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}

			if (context.model && (await isModelIncompatibleResponse(response))) {
				deps.reportModelIncompatible(groupId, context.model);
				deps.reportNeutral(groupId);
				if (!failedGroups.includes(groupId)) failedGroups.push(groupId);
				mayUpdateBinding = rollbackActive();
				lastError = response;
				if (!retriable) break;
				continue;
			}
			if (upstreamFailure(response.status)) {
				finishTtfb();
				void response.body?.cancel().catch(() => {});
				deps.logger.warn(
					`上游错误 ${response.status} group=${groupId} attempt=${attempt}`,
				);
				markFailure(groupId);
				mayUpdateBinding = rollbackActive();
				lastError = response;
				if (!retriable) break;
				continue;
			}
			if (!response.ok) deps.reportNeutral(groupId);
			const invalidateBinding = active.invalidate;
			const isCurrentBinding = active.isCurrentBinding;
			active.rollback = undefined;

			const outHeaders = new Headers();
			response.headers.forEach((value, name) => {
				if (!HOP_BY_HOP.has(name.toLowerCase())) outHeaders.set(name, value);
			});
			outHeaders.set("x-aihub-auto-group", String(groupId));

			let sawFirstByte = false;
			let outcomeRecorded = false;
			let ended = false;
			let responseProbe = "";
			let usageProbe = "";
			let responseIdBound = false;
			const decoder = new TextDecoder();
			const endOnce = () => {
				if (ended) return;
				ended = true;
				deps.traffic.end(groupId);
			};
			const recordFirstByte = () => {
				if (sawFirstByte || !response.ok) return;
				sawFirstByte = true;
				deps.observations.recordLatency(
					groupId,
					(firstByteAt ?? performance.now()) - startedAt,
				);
				deps.reportModelSupported(groupId, context.model);
			};
			const recordSuccess = () => {
				if (outcomeRecorded || !response.ok) return;
				recordFirstByte();
				outcomeRecorded = true;
				deps.observations.recordSuccess(groupId);
				deps.reportSuccess(groupId);
			};
			const recordStreamFailure = () => {
				if (outcomeRecorded || !response.ok) return;
				outcomeRecorded = true;
				deps.observations.recordFailure(groupId);
				deps.reportFailure(groupId);
				invalidateBinding?.();
			};
			const inspectResponseMetadata = (chunk: Uint8Array, flush = false) => {
				if (!context.sessionKey) return;
				const text = decoder.decode(chunk, { stream: !flush });
				if (!responseIdBound && responseProbe.length < MAX_RESPONSE_ID_BYTES) {
					responseProbe = (responseProbe + text).slice(
						0,
						MAX_RESPONSE_ID_BYTES,
					);
					const responseId = findResponseId(responseProbe);
					if (responseId) {
						deps.affinity.bindResponse(responseId, context.sessionKey, groupId);
						responseIdBound = true;
					}
				}
				usageProbe = (usageProbe + text).slice(-MAX_USAGE_BYTES);
				if (!flush || !isCurrentBinding?.()) return;
				const usage = findCacheUsage(usageProbe);
				if (usage?.cachedTokens && usage.cachedTokens > 0) {
					deps.affinity.recordCache(context.sessionKey, "hit");
				} else if (usage?.cachedTokens === 0 && (usage.inputTokens ?? 0) > 0) {
					deps.affinity.recordCache(context.sessionKey, "miss");
				}
			};

			streaming = true;
			if (!response.body) {
				recordSuccess();
				endOnce();
				return new Response(null, {
					status: response.status,
					statusText: response.statusText,
					headers: outHeaders,
				});
			}
			const reader = response.body.getReader();
			let pipeClosed = false;
			const piped = new ReadableStream<Uint8Array>({
				async pull(streamController) {
					try {
						const { done, value } = await reader.read();
						if (pipeClosed) return;
						if (done) {
							pipeClosed = true;
							inspectResponseMetadata(new Uint8Array(), true);
							recordSuccess();
							endOnce();
							streamController.close();
						} else {
							recordFirstByte();
							inspectResponseMetadata(value);
							streamController.enqueue(value);
						}
					} catch (err) {
						recordStreamFailure();
						endOnce();
						if (!pipeClosed) {
							pipeClosed = true;
							streamController.error(err);
						}
					}
				},
				async cancel(reason) {
					pipeClosed = true;
					deps.reportNeutral(groupId);
					endOnce();
					await reader.cancel(reason).catch(() => {});
				},
			});
			return new Response(piped, {
				status: response.status,
				statusText: response.statusText,
				headers: outHeaders,
			});
		}

		return lastError ?? errorResponse(503, "所有候选分组均不可用");
	} finally {
		if (!streaming) deps.traffic.end(trackedGroup);
	}
}

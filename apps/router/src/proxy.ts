import type { LocalObservationStore, Platform } from "@aihub-auto/core";
import type { TrafficTracker } from "./traffic.ts";
import type { Logger } from "./logger.ts";

export interface ProxyDeps {
  baseUrl: string;
  /** 当前生效的上游 sk;undefined = 未配置 */
  currentKey: () => { sk: string; groupId: number } | undefined;
  /** 故障时申请切换到下一组;返回新 Key 或 undefined(无可用) */
  failover: (failedGroupIds: number[], platform: Platform) => Promise<{ sk: string; groupId: number } | undefined>;
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

export function detectPlatform(path: string, headers: Headers): Platform {
  if (path.startsWith("/anthropic/") || headers.has("anthropic-version")) return "anthropic";
  return "openai";
}

/** /openai/v1/... 或 /anthropic/v1/... → /v1/...;/v1/... 原样 */
export function upstreamPath(path: string): string {
  const m = path.match(/^\/(?:openai|anthropic)(\/.*)$/);
  return m ? m[1]! : path;
}

function upstreamFailure(status: number): boolean {
  return status === 429 || status >= 500;
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "aihub_auto_proxy" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * 反代处理:注入当前最优 Key,流式直通,TTFT 观测,请求内故障转移。
 * 客户端自带 Authorization 丢弃(本地代理即鉴权边界;公网监听用 proxyToken)。
 */
export async function handleProxy(req: Request, deps: ProxyDeps): Promise<Response> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return errorResponse(400, "非法请求 URL");
  }
  const platform = detectPlatform(url.pathname, req.headers);
  const path = upstreamPath(url.pathname) + url.search;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const maxRetries = deps.maxRetries ?? 2;
  const maxBuffer = deps.maxBufferBytes ?? 20 * 1024 * 1024;

  if (deps.proxyToken) {
    const auth = req.headers.get("authorization") ?? "";
    const key = req.headers.get("x-api-key") ?? "";
    if (auth !== `Bearer ${deps.proxyToken}` && key !== deps.proxyToken) {
      return errorResponse(401, "代理口令错误:请求需携带 Authorization: Bearer <proxyToken>");
    }
  }

  let active = deps.currentKey();
  if (!active) {
    return errorResponse(503, "路由器未就绪:尚未配置 AIHub Key(打开控制台完成登录)");
  }

  // 请求体缓冲(重试用);超限则直通单发
  let body: ArrayBuffer | undefined;
  let retriable = true;
  if (req.body) {
    const len = Number(req.headers.get("content-length") ?? "0");
    if (len > 0 && len <= maxBuffer) {
      body = await req.arrayBuffer();
    } else if (len === 0) {
      body = await req.arrayBuffer();
      if (body.byteLength > maxBuffer) retriable = false;
    } else {
      retriable = false;
    }
  }

  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });

  const failedGroups: number[] = [];
  let lastError: Response | undefined;
  let streaming = false;

  deps.traffic.begin();
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const next = await deps.failover(failedGroups, platform);
        if (!next) break;
        active = next;
      }
      const group = active.groupId;
      headers.set("Authorization", `Bearer ${active.sk}`);
      if (platform === "anthropic") headers.set("x-api-key", active.sk);

      const start = performance.now();
      // 仅限制响应头到达时间;到达后解除,不杀长流
      const controller = new AbortController();
      const ttfbTimer = setTimeout(() => controller.abort(new DOMException("TTFB timeout", "TimeoutError")), deps.ttfbTimeoutMs);
      let res: Response;
      try {
        res = await fetchFn(`${deps.baseUrl}${path}`, {
          method: req.method,
          headers,
          body: body !== undefined ? body : req.body,
          redirect: "manual",
          signal: controller.signal,
        });
        clearTimeout(ttfbTimer);
      } catch (err) {
        clearTimeout(ttfbTimer);
        const kind = err instanceof Error && err.name === "TimeoutError" ? "TTFB 超时" : "连接失败";
        deps.logger.warn(`上游${kind} group=${group} attempt=${attempt}`);
        deps.observations.recordFailure(group);
        failedGroups.push(group);
        lastError = errorResponse(502, `上游${kind}(组 ${group})`);
        if (!retriable) break;
        continue;
      }

      if (upstreamFailure(res.status)) {
        deps.logger.warn(`上游错误 ${res.status} group=${group} attempt=${attempt}`);
        deps.observations.recordFailure(group);
        failedGroups.push(group);
        lastError = res;
        if (!retriable) break;
        continue;
      }

      const outHeaders = new Headers();
      res.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name.toLowerCase())) outHeaders.set(name, value);
      });
      outHeaders.set("x-aihub-auto-group", String(group));

      // TTFT = 首个 body 字节时刻(非响应头);流式直通。
      // traffic.end() 延迟到流结束,activeStreams 才能反映真实在飞请求。
      let observed = false;
      const ok = res.ok;
      let ended = false;
      const endOnce = () => {
        if (!ended) {
          ended = true;
          deps.traffic.end();
        }
      };
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, tc) {
          if (!observed) {
            observed = true;
            if (ok) deps.observations.recordSuccess(group, performance.now() - start);
          }
          tc.enqueue(chunk);
        },
        flush() {
          if (!observed && ok) deps.observations.recordSuccess(group, performance.now() - start);
          endOnce();
        },
      });

      streaming = true;
      if (!res.body) {
        if (ok) deps.observations.recordSuccess(group, performance.now() - start);
        endOnce();
        return new Response(null, { status: res.status, statusText: res.statusText, headers: outHeaders });
      }
      // 流被取消/报错也要归还计数:包一层 reader 手动泵,cancel/error 都能 endOnce
      const upstream = res.body.pipeThrough(tap);
      const reader = upstream.getReader();
      const piped = new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              endOnce();
              c.close();
            } else {
              c.enqueue(value);
            }
          } catch (err) {
            endOnce();
            c.error(err);
          }
        },
        async cancel(reason) {
          endOnce();
          await reader.cancel(reason);
        },
      });
      return new Response(piped, {
        status: res.status,
        statusText: res.statusText,
        headers: outHeaders,
      });
    }

    return lastError ?? errorResponse(503, "所有候选分组均不可用");
  } finally {
    if (!streaming) deps.traffic.end();
  }
}

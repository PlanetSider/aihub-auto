import { afterEach, describe, expect, test } from "bun:test";
import { handleProxy } from "../src/proxy.ts";
import { createHarness, type Harness } from "./harness.ts";
import { makeStat } from "./mock-upstream.ts";

let h: Harness;
afterEach(() => h?.dispose());

/** 准备:pool 模式,组 1/2/3 各有统计,当前路由到组 1 */
async function setupRouted(configPatch?: Record<string, unknown>): Promise<Harness> {
  const hh = createHarness({
    configPatch: { keyMode: "pool", ...configPatch },
  });
  hh.mock.stats = [
    makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1500 }),
    makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 1800 }),
    makeStat({ groupId: 3, rateMultiplier: 0.08, avgTtftMs: 2500 }),
  ];
  await hh.daemon.runOnce();
  expect(hh.state.currentGroupId).toBe(1);
  return hh;
}

function proxyReq(path = "/v1/chat/completions", init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", messages: [] }),
    ...init,
  });
}

describe("反代基础", () => {
  test("未配置 Key ⇒ 503 且提示", async () => {
    h = createHarness();
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("未配置");
  });

  test("正常转发:注入池 Key,响应带 x-aihub-auto-group,TTFT 入观测", async () => {
    h = await setupRouted();
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-aihub-auto-group")).toBe("1");
    const body = (await res.json()) as { group: number };
    expect(body.group).toBe(1);
    const obs = h.observations.getObservation(1);
    expect(obs).toBeDefined();
    expect(obs!.sampleCount).toBe(1);
    expect(obs!.errorRate).toBe(0);
  });

  test("客户端自带 Authorization 被丢弃,注入的是池 Key", async () => {
    h = await setupRouted();
    await handleProxy(
      proxyReq("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer client-own-key", "Content-Type": "application/json" },
        body: "{}",
      }),
      h.proxyDeps,
    );
    const upstream = h.mock.requestLog.filter((r) => r.path.startsWith("/v1/"));
    expect(upstream.at(-1)!.auth).toStartWith("Bearer sk-mock-");
  });

  test("SSE 流式直通", async () => {
    h = await setupRouted();
    h.mock.behavior.groups.set(1, { sse: true });
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("来自组 1");
    expect(text).toContain("[DONE]");
  });

  test("anthropic 平台探测:路径前缀改写 + x-api-key 注入", async () => {
    h = await setupRouted();
    const res = await handleProxy(
      proxyReq("/anthropic/v1/messages", {
        method: "POST",
        headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: "{}",
      }),
      h.proxyDeps,
    );
    expect(res.status).toBe(200);
    const upstream = h.mock.requestLog.at(-1)!;
    expect(upstream.path).toBe("/v1/messages");
  });

  test("proxyToken 配置后:无 token 401,带 token 通过", async () => {
    h = await setupRouted({ proxyToken: "supersecrettoken123" });
    const denied = await handleProxy(proxyReq(), h.proxyDeps);
    expect(denied.status).toBe(401);
    const allowed = await handleProxy(
      proxyReq("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer supersecrettoken123", "Content-Type": "application/json" },
        body: "{}",
      }),
      h.proxyDeps,
    );
    expect(allowed.status).toBe(200);
  });
});

describe("故障转移", () => {
  test("首字节前 500 ⇒ 同请求内换组重试成功,观测记失败", async () => {
    h = await setupRouted();
    // 先成功一次让组 1 有观测基线
    await (await handleProxy(proxyReq(), h.proxyDeps)).text();
    h.mock.behavior.groups.set(1, { status: 500 });

    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(200);
    // 切到了组 2(次优)
    expect(res.headers.get("x-aihub-auto-group")).toBe("2");
    expect(h.state.currentGroupId).toBe(2);
    // 组 1 观测到失败(1 成功 + 1 失败 ⇒ 窗口错误率 0.5)
    expect(h.observations.getObservation(1)!.errorRate).toBeGreaterThan(0);

    // 组 2 也挂 ⇒ 后续请求落到组 3
    h.mock.behavior.groups.set(2, { status: 500 });
    const res3 = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res3.status).toBe(200);
    expect(res3.headers.get("x-aihub-auto-group")).toBe("3");
  });

  test("429 同样触发换组", async () => {
    h = await setupRouted();
    h.mock.behavior.groups.set(1, { status: 429 });
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-aihub-auto-group")).toBe("2");
  });

  test("全部候选失败 ⇒ 返回最后上游错误", async () => {
    h = await setupRouted();
    h.mock.behavior.groups.set(1, { status: 500 });
    h.mock.behavior.groups.set(2, { status: 500 });
    h.mock.behavior.groups.set(3, { status: 500 });
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(500);
  });

  test("TTFB 超时 ⇒ 换组", async () => {
    h = await setupRouted({ ttfbTimeoutMs: 1_000 });
    h.proxyDeps.ttfbTimeoutMs = 1_000;
    h.mock.behavior.groups.set(1, { delayMs: 3_000 });
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-aihub-auto-group")).toBe("2");
  }, 10_000);

  test("中途断流 ⇒ 不重试不切组,只透传已收到的部分", async () => {
    h = await setupRouted();
    h.mock.behavior.groups.set(1, { sse: true, breakMidStream: true });
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(200); // 头已 200
    const text = await res.text().catch(() => "__stream_error__");
    // 不管底层 HTTP 栈对断流报错还是截断,都不得包含完整结束标记
    expect(text).not.toContain("[DONE]");
    // 未发生重试/切组(响应已开始)
    expect(res.headers.get("x-aihub-auto-group")).toBe("1");
    expect(h.state.currentGroupId).toBe(1);
    const upstreamCalls = h.mock.requestLog.filter((r) => r.path.startsWith("/v1/")).length;
    expect(upstreamCalls).toBe(1);
  });

  test("非路由性 4xx(400)不换组如实透传", async () => {
    h = await setupRouted();
    h.mock.behavior.groups.set(1, { status: 400 });
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    expect(res.status).toBe(400);
    expect(h.state.currentGroupId).toBe(1);
  });
});

describe("流量统计", () => {
  test("请求计入 TrafficTracker,流结束归还 activeStreams", async () => {
    h = await setupRouted();
    const res = await handleProxy(proxyReq(), h.proxyDeps);
    await res.text();
    await Bun.sleep(10);
    const snap = h.traffic.snapshot();
    expect(snap.requestsLast5m).toBeGreaterThanOrEqual(1);
    expect(snap.activeStreams).toBe(0);
    expect(snap.lastRequestAt).toBeDefined();
  });
});

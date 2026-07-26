import { BREAKER_DEFAULTS } from "./defaults.ts";

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  consecutiveFailureThreshold: number;
  windowMs: number;
  windowFailureRate: number;
  windowMinSamples: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
}

interface GroupBreaker {
  state: BreakerState;
  consecutiveFailures: number;
  /** 时间窗内的结果记录 */
  window: { at: number; ok: boolean }[];
  /** open 进入时刻 */
  openedAt?: number;
  /** 连续 open 次数,决定退避指数 */
  openCount: number;
  /** half-open 探针是否已放行 */
  probeInFlight: boolean;
}

export interface BreakerSnapshot {
  groupId: number;
  state: BreakerState;
  consecutiveFailures: number;
  openCount: number;
  openedAt?: number;
  cooldownMs?: number;
}

interface SerializedBreaker {
  groupId: number;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt?: number;
  openCount: number;
}

/**
 * 按 groupId 的熔断器。
 * closed →(连续失败≥N 或 窗口失败率≥50% 且样本≥4)→ open
 * open →(冷却到期,指数退避 30s×2^n 封顶 10min)→ half-open
 * half-open →(放 1 探针;成功→closed,失败→open)
 * 失败分类由调用方定义(5xx/429/连接错误/TTFB 超时记失败,其余 4xx 不记)。
 */
export class CircuitBreaker {
  private readonly groups = new Map<number, GroupBreaker>();
  private readonly opts: BreakerOptions;

  constructor(opts?: Partial<BreakerOptions>) {
    this.opts = { ...BREAKER_DEFAULTS, ...opts };
  }

  private group(groupId: number): GroupBreaker {
    let g = this.groups.get(groupId);
    if (!g) {
      g = { state: "closed", consecutiveFailures: 0, window: [], openCount: 0, probeInFlight: false };
      this.groups.set(groupId, g);
    }
    return g;
  }

  private cooldownMs(g: GroupBreaker): number {
    const exp = Math.max(g.openCount - 1, 0);
    return Math.min(this.opts.baseCooldownMs * 2 ** exp, this.opts.maxCooldownMs);
  }

  private refresh(g: GroupBreaker, now: number): void {
    if (g.state === "open" && g.openedAt !== undefined && now - g.openedAt >= this.cooldownMs(g)) {
      g.state = "half-open";
      g.probeInFlight = false;
    }
    const cutoff = now - this.opts.windowMs;
    g.window = g.window.filter((r) => r.at >= cutoff);
  }

  /** 该组当前是否允许发请求。half-open 只放一个探针。 */
  allowRequest(groupId: number, now = Date.now()): boolean {
    const g = this.group(groupId);
    this.refresh(g, now);
    if (g.state === "closed") return true;
    if (g.state === "open") return false;
    if (g.probeInFlight) return false;
    g.probeInFlight = true;
    return true;
  }

  /** 该组是否应被路由排除(open,或 half-open 尚未证明自己) */
  isTripped(groupId: number, now = Date.now()): boolean {
    const g = this.group(groupId);
    this.refresh(g, now);
    return g.state !== "closed";
  }

  trippedGroupIds(now = Date.now()): number[] {
    const out: number[] = [];
    for (const [id] of this.groups) {
      if (this.isTripped(id, now)) out.push(id);
    }
    return out;
  }

  recordSuccess(groupId: number, now = Date.now()): void {
    const g = this.group(groupId);
    this.refresh(g, now);
    g.window.push({ at: now, ok: true });
    g.consecutiveFailures = 0;
    if (g.state === "half-open") {
      g.state = "closed";
      g.openCount = 0;
      g.openedAt = undefined;
      g.probeInFlight = false;
    }
  }

  recordFailure(groupId: number, now = Date.now()): void {
    const g = this.group(groupId);
    this.refresh(g, now);
    g.window.push({ at: now, ok: false });
    g.consecutiveFailures++;

    if (g.state === "half-open") {
      this.trip(g, now);
      return;
    }
    if (g.state !== "closed") return;

    const failures = g.window.filter((r) => !r.ok).length;
    const rateTrip =
      g.window.length >= this.opts.windowMinSamples &&
      failures / g.window.length >= this.opts.windowFailureRate;
    if (g.consecutiveFailures >= this.opts.consecutiveFailureThreshold || rateTrip) {
      this.trip(g, now);
    }
  }

  private trip(g: GroupBreaker, now: number): void {
    g.state = "open";
    g.openedAt = now;
    g.openCount++;
    g.probeInFlight = false;
  }

  snapshot(now = Date.now()): BreakerSnapshot[] {
    const out: BreakerSnapshot[] = [];
    for (const [groupId, g] of this.groups) {
      this.refresh(g, now);
      out.push({
        groupId,
        state: g.state,
        consecutiveFailures: g.consecutiveFailures,
        openCount: g.openCount,
        openedAt: g.openedAt,
        cooldownMs: g.state === "open" ? this.cooldownMs(g) : undefined,
      });
    }
    return out;
  }

  toJSON(): SerializedBreaker[] {
    return [...this.groups.entries()].map(([groupId, g]) => ({
      groupId,
      state: g.state,
      consecutiveFailures: g.consecutiveFailures,
      openedAt: g.openedAt,
      openCount: g.openCount,
    }));
  }

  static fromJSON(data: unknown, opts?: Partial<BreakerOptions>): CircuitBreaker {
    const breaker = new CircuitBreaker(opts);
    if (!Array.isArray(data)) return breaker;
    for (const raw of data) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Partial<SerializedBreaker>;
      if (typeof r.groupId !== "number") continue;
      const g = breaker.group(r.groupId);
      if (r.state === "open" || r.state === "half-open" || r.state === "closed") g.state = r.state;
      g.consecutiveFailures = typeof r.consecutiveFailures === "number" ? r.consecutiveFailures : 0;
      g.openedAt = typeof r.openedAt === "number" ? r.openedAt : undefined;
      g.openCount = typeof r.openCount === "number" ? r.openCount : 0;
    }
    return breaker;
  }
}

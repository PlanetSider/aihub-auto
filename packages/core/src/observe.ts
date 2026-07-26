import { LOCAL_CONFIDENCE_HALF_LIFE_MS, LOCAL_EWMA_ALPHA, LOCAL_WINDOW_SIZE } from "./defaults.ts";
import type { LocalObservation } from "./types.ts";

interface GroupObs {
  ewmaTtftMs?: number;
  /** 环形缓冲:最近 N 次请求 { ok, ttftMs? } */
  ring: { ok: boolean; ttftMs?: number }[];
  sampleCount: number;
  lastAt: number;
}

interface SerializedObs {
  groupId: number;
  ewmaTtftMs?: number;
  ring: { ok: boolean; ttftMs?: number }[];
  sampleCount: number;
  lastAt: number;
}

/**
 * 反代实测观测存储:按 groupId 记 EWMA TTFT、近 N 次成败(错误率/CV)。
 * localConfidence = (1 − e^(−n/5)) × exp(−ln2·age/5min)
 */
export class LocalObservationStore {
  private readonly groups = new Map<number, GroupObs>();
  private readonly alpha: number;
  private readonly windowSize: number;
  private readonly halfLifeMs: number;

  constructor(opts?: { alpha?: number; windowSize?: number; halfLifeMs?: number }) {
    this.alpha = opts?.alpha ?? LOCAL_EWMA_ALPHA;
    this.windowSize = opts?.windowSize ?? LOCAL_WINDOW_SIZE;
    this.halfLifeMs = opts?.halfLifeMs ?? LOCAL_CONFIDENCE_HALF_LIFE_MS;
  }

  private group(groupId: number): GroupObs {
    let g = this.groups.get(groupId);
    if (!g) {
      g = { ring: [], sampleCount: 0, lastAt: 0 };
      this.groups.set(groupId, g);
    }
    return g;
  }

  recordSuccess(groupId: number, ttftMs: number, now = Date.now()): void {
    if (!Number.isFinite(ttftMs) || ttftMs <= 0) return;
    const g = this.group(groupId);
    g.ewmaTtftMs = g.ewmaTtftMs === undefined ? ttftMs : this.alpha * ttftMs + (1 - this.alpha) * g.ewmaTtftMs;
    g.ring.push({ ok: true, ttftMs });
    if (g.ring.length > this.windowSize) g.ring.shift();
    g.sampleCount++;
    g.lastAt = now;
  }

  recordFailure(groupId: number, now = Date.now()): void {
    const g = this.group(groupId);
    g.ring.push({ ok: false });
    if (g.ring.length > this.windowSize) g.ring.shift();
    g.sampleCount++;
    g.lastAt = now;
  }

  getObservation(groupId: number, now = Date.now()): LocalObservation | undefined {
    const g = this.groups.get(groupId);
    if (!g || g.sampleCount === 0 || g.ewmaTtftMs === undefined) return undefined;

    const failures = g.ring.filter((r) => !r.ok).length;
    const errorRate = g.ring.length > 0 ? failures / g.ring.length : 0;

    const ttfts = g.ring.filter((r) => r.ok && r.ttftMs !== undefined).map((r) => r.ttftMs!);
    let cv: number | undefined;
    if (ttfts.length >= 3) {
      const mean = ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
      if (mean > 0) {
        const variance = ttfts.reduce((a, b) => a + (b - mean) ** 2, 0) / ttfts.length;
        cv = Math.sqrt(variance) / mean;
      }
    }

    const age = Math.max(now - g.lastAt, 0);
    const confidence = (1 - Math.exp(-g.sampleCount / 5)) * Math.exp((-Math.LN2 * age) / this.halfLifeMs);

    return {
      groupId,
      ewmaTtftMs: g.ewmaTtftMs,
      errorRate,
      cv,
      sampleCount: g.sampleCount,
      lastAt: g.lastAt,
      confidence,
    };
  }

  /** 供 evaluate() 的 localObs 入参 */
  asMap(now = Date.now()): Map<number, LocalObservation> {
    const out = new Map<number, LocalObservation>();
    for (const [groupId] of this.groups) {
      const obs = this.getObservation(groupId, now);
      if (obs) out.set(groupId, obs);
    }
    return out;
  }

  toJSON(): SerializedObs[] {
    return [...this.groups.entries()].map(([groupId, g]) => ({
      groupId,
      ewmaTtftMs: g.ewmaTtftMs,
      ring: g.ring,
      sampleCount: g.sampleCount,
      lastAt: g.lastAt,
    }));
  }

  static fromJSON(
    data: unknown,
    opts?: { alpha?: number; windowSize?: number; halfLifeMs?: number },
  ): LocalObservationStore {
    const store = new LocalObservationStore(opts);
    if (!Array.isArray(data)) return store;
    for (const raw of data) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Partial<SerializedObs>;
      if (typeof r.groupId !== "number") continue;
      const g = store.group(r.groupId);
      g.ewmaTtftMs = typeof r.ewmaTtftMs === "number" ? r.ewmaTtftMs : undefined;
      g.ring = Array.isArray(r.ring)
        ? r.ring.filter((e): e is { ok: boolean; ttftMs?: number } => typeof e === "object" && e !== null && typeof (e as { ok?: unknown }).ok === "boolean")
        : [];
      g.sampleCount = typeof r.sampleCount === "number" ? r.sampleCount : g.ring.length;
      g.lastAt = typeof r.lastAt === "number" ? r.lastAt : 0;
    }
    return store;
  }
}

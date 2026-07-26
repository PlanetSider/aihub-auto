import {
  evaluate,
  parseGroupStat,
  recommendTopN,
  type GroupStat,
  type Platform,
  type RoutingMode,
  type ScoredCandidate,
} from "@aihub-auto/core";
import { DEFAULT_ERROR_RATE_CAP, DEFAULT_MAX_STATUS_AGE_MS, PLATFORMS } from "@aihub-auto/core";

export interface RecommendOptions {
  baseUrl: string;
  mode: RoutingMode;
  maxRate: number;
  samples: number;
  scoreWindow: number;
  cacheTtlMs: number;
  /** JSON GET(由 ctx.http 适配注入) */
  getJson: (url: string) => Promise<unknown>;
}

export interface PlatformRecommendation {
  platform: Platform;
  items: ScoredCandidate[];
}

interface CacheEntry {
  at: number;
  data: PlatformRecommendation[];
}

/** 推荐服务:双平台并发拉取 + 评分 + TTL 缓存 + in-flight 单飞 */
export class RecommendService {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<PlatformRecommendation[]>>();

  async recommend(opts: RecommendOptions): Promise<PlatformRecommendation[]> {
    const cacheKey = `${opts.baseUrl}|${opts.mode}|${opts.maxRate}|${opts.samples}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < opts.cacheTtlMs) return cached.data;

    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;

    const task = this.fetchAll(opts)
      .then((data) => {
        this.cache.set(cacheKey, { at: Date.now(), data });
        return data;
      })
      .finally(() => this.inflight.delete(cacheKey));
    this.inflight.set(cacheKey, task);
    return task;
  }

  private async fetchAll(opts: RecommendOptions): Promise<PlatformRecommendation[]> {
    const now = Date.now();
    const results = await Promise.allSettled(
      PLATFORMS.map(async (platform): Promise<PlatformRecommendation> => {
        const q = new URLSearchParams({ samples: String(opts.samples), platform });
        const raw = await opts.getJson(
          `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/public/groups/usage-stats?${q}`,
        );
        const stats = parseStatsResponse(raw);
        const evaluation = evaluate(stats, {
          mode: opts.mode,
          priceBand: { min: 0, max: opts.maxRate },
          blacklist: [],
          maxStatusAgeMs: DEFAULT_MAX_STATUS_AGE_MS,
          errorRateCap: DEFAULT_ERROR_RATE_CAP,
          platform,
          now,
        });
        return { platform, items: recommendTopN(evaluation, { scoreWindow: opts.scoreWindow, max: 6 }) };
      }),
    );
    const ok = results
      .filter((r): r is PromiseFulfilledResult<PlatformRecommendation> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((r) => r.items.length > 0);
    if (ok.length === 0 && results.every((r) => r.status === "rejected")) {
      throw new Error("usage-stats 全部平台拉取失败");
    }
    return ok;
  }
}

export function parseStatsResponse(raw: unknown): GroupStat[] {
  const root = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  // 兼容带 envelope({code,data:{items}})与裸 {items}
  const data =
    typeof root["data"] === "object" && root["data"] !== null
      ? (root["data"] as Record<string, unknown>)
      : root;
  const items = Array.isArray(data["items"]) ? (data["items"] as unknown[]) : [];
  return items.map(parseGroupStat).filter((s): s is GroupStat => s !== undefined);
}

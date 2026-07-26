import { type GroupStat, type Platform, type RoutingMode, type ScoredCandidate } from "@aihub-auto/core";
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
/** 推荐服务:双平台并发拉取 + 评分 + TTL 缓存 + in-flight 单飞 */
export declare class RecommendService {
    private cache;
    private inflight;
    recommend(opts: RecommendOptions): Promise<PlatformRecommendation[]>;
    private fetchAll;
}
export declare function parseStatsResponse(raw: unknown): GroupStat[];

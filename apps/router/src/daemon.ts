import {
  type AIHubClient,
  type CircuitBreaker,
  type LocalObservationStore,
  decide,
  evaluate,
  idleTraffic,
  type Decision,
  type Evaluation,
  type GroupStat,
  type Platform,
  type RouteState,
  type ScoringOptions,
} from "@aihub-auto/core";
import type { AppConfig, AppState, Credentials } from "./config.ts";
import type { RouteExecutor, ActiveKey } from "./executor.ts";
import type { TrafficTracker } from "./traffic.ts";
import type { AuditLog, Logger } from "./logger.ts";

export interface DaemonDeps {
  config: AppConfig;
  state: AppState;
  credentials: Credentials;
  client: AIHubClient;
  executor: RouteExecutor;
  breaker: CircuitBreaker;
  observations: LocalObservationStore;
  traffic: TrafficTracker;
  logger: Logger;
  audit: AuditLog;
  persistState: () => Promise<void>;
  persistCredentials: () => Promise<void>;
}

export interface RoundResult {
  platform: Platform;
  evaluation: Evaluation;
  decision: Decision;
  executed: boolean;
  stale: boolean;
}

/**
 * 路由守护:定时拉公开统计 → 融合本地观测/熔断 → 决策 → 执行。
 * setTimeout 链(非忙轮询),统计拉取失败容忍用上轮缓存(标 stale)。
 */
export class RouteDaemon {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private lastStats = new Map<Platform, { items: GroupStat[]; at: number }>();
  needsReauth = false;
  lastRound: RoundResult | undefined;

  constructor(private readonly deps: DaemonDeps) {}

  /** 主要服务平台:反代流量最近谁在用就路由谁;暂无流量默认 openai */
  private activePlatform(): Platform {
    return this.deps.state.currentGroupId !== undefined && this.lastRound
      ? this.lastRound.platform
      : "openai";
  }

  async fetchStats(platform: Platform): Promise<{ items: GroupStat[]; stale: boolean }> {
    try {
      const page = await this.deps.client.getUsageStats({
        platform,
        samples: this.deps.config.samples,
      });
      this.lastStats.set(platform, { items: page.items, at: Date.now() });
      return { items: page.items, stale: false };
    } catch (err) {
      const cached = this.lastStats.get(platform);
      this.deps.logger.warn(
        `usage-stats 拉取失败(${platform}),${cached ? "使用上轮缓存" : "无缓存可用"}:${err instanceof Error ? err.message : ""}`,
      );
      return { items: cached?.items ?? [], stale: true };
    }
  }

  scoringOptions(platform: Platform, now: number): ScoringOptions {
    const cfg = this.deps.config;
    const tripped = this.deps.breaker.trippedGroupIds(now);
    return {
      mode: cfg.mode,
      priceBand: cfg.priceBand,
      blacklist: [...cfg.blacklist, ...tripped],
      maxStatusAgeMs: cfg.maxStatusAgeMs,
      errorRateCap: cfg.errorRateCap,
      platform,
      now,
    };
  }

  /** 单轮:评估 + 决策 + (可选)执行 */
  async runOnce(opts?: { dryRun?: boolean; platform?: Platform }): Promise<RoundResult> {
    const now = Date.now();
    const platform = opts?.platform ?? this.activePlatform();
    const { items, stale } = await this.fetchStats(platform);

    const evaluation = evaluate(
      items,
      this.scoringOptions(platform, now),
      this.deps.observations.asMap(now),
    );

    const routeState: RouteState = {
      currentGroupId: this.deps.state.currentGroupId,
      lastSwitchAt: this.deps.state.lastSwitchAt,
      pendingSwitch: this.deps.state.pendingSwitch,
    };
    const policy = this.deps.config.decision;
    const decision = decide(evaluation, routeState, policy, this.deps.traffic.snapshot(now), now);

    let executed = false;
    if (!opts?.dryRun && decision.shouldSwitch && decision.targetGroupId !== undefined) {
      try {
        await this.deps.executor.switchTo(decision.targetGroupId);
        executed = true;
        this.deps.state.lastSwitchAt = decision.nextState.lastSwitchAt;
        this.deps.state.pendingSwitch = decision.nextState.pendingSwitch;
      } catch (err) {
        this.deps.logger.error(`切换执行失败:${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (!opts?.dryRun) {
      // 非切换轮也要持久化 pendingSwitch 演变
      this.deps.state.pendingSwitch = decision.nextState.pendingSwitch;
    }
    if (!opts?.dryRun) {
      this.deps.state.breaker = this.deps.breaker.toJSON();
      this.deps.state.observations = this.deps.observations.toJSON();
      await this.deps.persistState();
    }

    await this.deps.audit.append({
      platform,
      stale,
      decision: {
        reason: decision.reason,
        shouldSwitch: decision.shouldSwitch,
        target: decision.targetGroupId,
        advantage: decision.advantage,
        threshold: decision.effectiveThreshold,
      },
      candidates: evaluation.eligible.map((c) => ({
        group: c.stat.groupId,
        code: c.stat.code,
        rate: c.stat.rateMultiplier,
        ttft: Math.round(c.blendedTtftMs),
        conservative: Math.round(c.conservativeLatencyMs),
        confidence: Number(c.confidence.toFixed(3)),
        premium: Number.isFinite(c.premium) ? Number(c.premium.toFixed(3)) : "inf",
        score: Number.isFinite(c.score) ? Number(c.score.toFixed(4)) : "-inf",
      })),
      excluded: evaluation.excluded.map((e) => ({ group: e.stat.groupId, reason: e.excludeReason })),
    });

    const result: RoundResult = { platform, evaluation, decision, executed, stale };
    this.lastRound = result;
    return result;
  }

  /**
   * 请求内故障转移(由反代调用):
   * 记熔断 → failover 决策(排除失败组,无视门槛)→ 执行切换 → 返回新 Key。
   */
  async failover(failedGroupIds: number[], platform: Platform): Promise<ActiveKey | undefined> {
    const now = Date.now();
    for (const gid of failedGroupIds) this.deps.breaker.recordFailure(gid, now);

    const cached = this.lastStats.get(platform);
    const items = cached?.items ?? (await this.fetchStats(platform)).items;
    const evaluation = evaluate(items, this.scoringOptions(platform, now), this.deps.observations.asMap(now));
    const decision = decide(
      evaluation,
      { currentGroupId: this.deps.state.currentGroupId, lastSwitchAt: this.deps.state.lastSwitchAt },
      this.deps.config.decision,
      idleTraffic(),
      now,
      { failover: true, failedGroupIds },
    );
    if (!decision.shouldSwitch || decision.targetGroupId === undefined) return undefined;
    try {
      const key = await this.deps.executor.switchTo(decision.targetGroupId);
      this.deps.state.lastSwitchAt = now;
      await this.deps.persistState();
      this.deps.logger.info(`故障转移:→ group=${decision.targetGroupId}`);
      return key;
    } catch (err) {
      this.deps.logger.error(`故障转移执行失败:${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** 上游成功回报(反代首字节后调用) */
  reportSuccess(groupId: number): void {
    this.deps.breaker.recordSuccess(groupId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.deps.logger.error(`路由轮失败:${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.stopped) {
        this.timer = setTimeout(loop, this.deps.config.pollIntervalMs);
      }
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

import type { TrafficSnapshot } from "@aihub-auto/core";

/** 反代流量跟踪:activeStreams / lastRequestAt / 5min 滑窗计数 */
export class TrafficTracker {
  private active = 0;
  private lastRequestAt?: number;
  private window: number[] = [];

  begin(now = Date.now()): void {
    this.active++;
    this.lastRequestAt = now;
    this.window.push(now);
    this.prune(now);
  }

  end(): void {
    this.active = Math.max(this.active - 1, 0);
  }

  private prune(now: number): void {
    const cutoff = now - 5 * 60_000;
    while (this.window.length > 0 && this.window[0]! < cutoff) this.window.shift();
  }

  snapshot(now = Date.now()): TrafficSnapshot {
    this.prune(now);
    return {
      lastRequestAt: this.lastRequestAt,
      activeStreams: this.active,
      requestsLast5m: this.window.length,
    };
  }
}

import type { TrafficSnapshot } from "@aihub-auto/core";

/** 反代流量跟踪:全局/分组在飞数、最近请求与 5 分钟滑窗。 */
export class TrafficTracker {
	private active = 0;
	private readonly byGroup = new Map<number, number>();
	/** 已选组但尚未交给代理流生命周期的请求,防止并发新会话扎堆。 */
	private readonly pendingByGroup = new Map<number, number>();
	private lastRequestAt?: number;
	private window: number[] = [];

	reserve(groupId: number): () => void {
		this.pendingByGroup.set(
			groupId,
			(this.pendingByGroup.get(groupId) ?? 0) + 1,
		);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = (this.pendingByGroup.get(groupId) ?? 1) - 1;
			if (next > 0) this.pendingByGroup.set(groupId, next);
			else this.pendingByGroup.delete(groupId);
		};
	}

	begin(groupId?: number, now = Date.now()): void {
		this.active++;
		if (groupId !== undefined) this.incrementGroup(groupId);
		this.lastRequestAt = now;
		this.window.push(now);
		this.prune(now);
	}

	move(fromGroupId: number, toGroupId: number): void {
		if (fromGroupId === toGroupId) return;
		this.decrementGroup(fromGroupId);
		this.incrementGroup(toGroupId);
	}

	end(groupId?: number): void {
		this.active = Math.max(this.active - 1, 0);
		if (groupId !== undefined) this.decrementGroup(groupId);
	}

	activeGroupIds(): Set<number> {
		return new Set([...this.byGroup.keys(), ...this.pendingByGroup.keys()]);
	}

	private incrementGroup(groupId: number): void {
		this.byGroup.set(groupId, (this.byGroup.get(groupId) ?? 0) + 1);
	}

	private decrementGroup(groupId: number): void {
		const next = (this.byGroup.get(groupId) ?? 0) - 1;
		if (next > 0) this.byGroup.set(groupId, next);
		else this.byGroup.delete(groupId);
	}

	private prune(now: number): void {
		const cutoff = now - 5 * 60_000;
		while (this.window.length > 0 && this.window[0]! < cutoff)
			this.window.shift();
	}

	snapshot(now = Date.now()): TrafficSnapshot {
		this.prune(now);
		return {
			lastRequestAt: this.lastRequestAt,
			activeStreams: this.active,
			requestsLast5m: this.window.length,
			activeByGroup: Object.fromEntries(
				[
					...new Set([...this.byGroup.keys(), ...this.pendingByGroup.keys()]),
				].map((groupId) => [
					String(groupId),
					(this.byGroup.get(groupId) ?? 0) +
						(this.pendingByGroup.get(groupId) ?? 0),
				]),
			),
		};
	}
}

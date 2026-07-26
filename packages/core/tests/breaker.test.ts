import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../src/index.ts";

const T0 = 1_000_000;

describe("CircuitBreaker", () => {
  test("连续 3 次失败 ⇒ open,期间拒绝请求", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(1, T0 + i * 100);
    expect(b.isTripped(1, T0 + 300)).toBe(true);
    expect(b.allowRequest(1, T0 + 300)).toBe(false);
    expect(b.isTripped(2, T0 + 300)).toBe(false);
  });

  test("窗口失败率触发:4 样本 50% 失败 ⇒ open", () => {
    const b = new CircuitBreaker();
    b.recordSuccess(1, T0);
    b.recordFailure(1, T0 + 100);
    b.recordSuccess(1, T0 + 200);
    b.recordFailure(1, T0 + 300);
    expect(b.isTripped(1, T0 + 300)).toBe(true);
  });

  test("成功重置连续失败计数", () => {
    const b = new CircuitBreaker();
    b.recordFailure(1, T0);
    b.recordFailure(1, T0 + 20_000); // 窗口外,失败率不触发
    b.recordSuccess(1, T0 + 40_000);
    b.recordFailure(1, T0 + 60_000);
    b.recordFailure(1, T0 + 80_000);
    expect(b.isTripped(1, T0 + 80_000)).toBe(false);
  });

  test("冷却后 half-open:放 1 探针,成功 ⇒ closed 且退避复位", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(1, T0 + i);
    const afterCooldown = T0 + 30_100;
    expect(b.allowRequest(1, afterCooldown)).toBe(true); // 探针
    expect(b.allowRequest(1, afterCooldown + 1)).toBe(false); // 只放一个
    b.recordSuccess(1, afterCooldown + 100);
    expect(b.isTripped(1, afterCooldown + 200)).toBe(false);
    expect(b.allowRequest(1, afterCooldown + 200)).toBe(true);
  });

  test("half-open 失败 ⇒ 重新 open,冷却指数退避", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(1, T0 + i);
    const t1 = T0 + 30_100;
    expect(b.allowRequest(1, t1)).toBe(true);
    b.recordFailure(1, t1 + 10);
    // 第二次 open:冷却 60s
    expect(b.allowRequest(1, t1 + 30_100)).toBe(false);
    expect(b.allowRequest(1, t1 + 60_100)).toBe(true);
  });

  test("退避封顶 10min", () => {
    const b = new CircuitBreaker();
    let t = T0;
    // 反复 open 很多次
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 3; i++) b.recordFailure(1, t + i);
      const snap = b.snapshot(t + 10)[0]!;
      expect(snap.cooldownMs!).toBeLessThanOrEqual(10 * 60_000);
      t += (snap.cooldownMs ?? 0) + 1000;
      b.allowRequest(1, t); // half-open 探针
    }
    const last = b.snapshot(t)[0]!;
    expect(last.state).not.toBe("closed");
  });

  test("序列化往返保留 open 状态与退避计数", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(7, T0 + i);
    const restored = CircuitBreaker.fromJSON(JSON.parse(JSON.stringify(b.toJSON())));
    expect(restored.isTripped(7, T0 + 100)).toBe(true);
    expect(restored.allowRequest(7, T0 + 30_100)).toBe(true); // 冷却语义保留
  });

  test("fromJSON 容忍垃圾输入", () => {
    expect(() => CircuitBreaker.fromJSON(null)).not.toThrow();
    expect(() => CircuitBreaker.fromJSON([{ bogus: true }, 42, "x"])).not.toThrow();
  });

  test("trippedGroupIds 汇总", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(1, T0 + i);
    b.recordSuccess(2, T0);
    expect(b.trippedGroupIds(T0 + 100)).toEqual([1]);
  });
});

import { describe, expect, test } from "bun:test";
import { LocalObservationStore } from "../src/index.ts";

const T0 = 1_000_000;

describe("LocalObservationStore", () => {
  test("EWMA 收敛:重复观测靠近新值", () => {
    const s = new LocalObservationStore();
    s.recordSuccess(1, 1000, T0);
    for (let i = 1; i <= 10; i++) s.recordSuccess(1, 2000, T0 + i * 1000);
    const obs = s.getObservation(1, T0 + 11_000)!;
    expect(obs.ewmaTtftMs).toBeGreaterThan(1900);
    expect(obs.ewmaTtftMs).toBeLessThan(2000);
  });

  test("错误率按环形窗口(10)计算", () => {
    const s = new LocalObservationStore();
    for (let i = 0; i < 5; i++) s.recordSuccess(1, 1000, T0 + i);
    for (let i = 0; i < 5; i++) s.recordFailure(1, T0 + 100 + i);
    expect(s.getObservation(1, T0 + 200)!.errorRate).toBeCloseTo(0.5, 5);
    // 再来 10 次成功把失败挤出窗口
    for (let i = 0; i < 10; i++) s.recordSuccess(1, 1000, T0 + 300 + i);
    expect(s.getObservation(1, T0 + 400)!.errorRate).toBe(0);
  });

  test("置信度随样本增长、随时间衰减(半衰期 5min)", () => {
    const s = new LocalObservationStore();
    s.recordSuccess(1, 1000, T0);
    const one = s.getObservation(1, T0)!.confidence;
    for (let i = 0; i < 20; i++) s.recordSuccess(1, 1000, T0);
    const many = s.getObservation(1, T0)!.confidence;
    expect(many).toBeGreaterThan(one);
    const aged = s.getObservation(1, T0 + 5 * 60_000)!.confidence;
    expect(aged).toBeCloseTo(many / 2, 2);
  });

  test("CV:延迟稳定 ⇒ 低,抖动 ⇒ 高;样本<3 无 CV", () => {
    const s = new LocalObservationStore();
    s.recordSuccess(1, 1000, T0);
    s.recordSuccess(1, 1000, T0);
    expect(s.getObservation(1, T0)!.cv).toBeUndefined();
    s.recordSuccess(1, 1000, T0);
    expect(s.getObservation(1, T0)!.cv).toBeCloseTo(0, 5);

    const j = new LocalObservationStore();
    j.recordSuccess(2, 500, T0);
    j.recordSuccess(2, 3000, T0);
    j.recordSuccess(2, 6000, T0);
    expect(j.getObservation(2, T0)!.cv!).toBeGreaterThan(0.5);
  });

  test("纯失败无 EWMA ⇒ 无观测(避免伪造延迟)", () => {
    const s = new LocalObservationStore();
    s.recordFailure(1, T0);
    expect(s.getObservation(1, T0)).toBeUndefined();
  });

  test("非法 TTFT 忽略", () => {
    const s = new LocalObservationStore();
    s.recordSuccess(1, NaN, T0);
    s.recordSuccess(1, -5, T0);
    expect(s.getObservation(1, T0)).toBeUndefined();
  });

  test("asMap 汇总 + 序列化往返", () => {
    const s = new LocalObservationStore();
    s.recordSuccess(1, 1000, T0);
    s.recordSuccess(2, 2000, T0);
    expect(s.asMap(T0).size).toBe(2);
    const restored = LocalObservationStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(restored.getObservation(1, T0)!.ewmaTtftMs).toBe(1000);
    expect(() => LocalObservationStore.fromJSON("garbage")).not.toThrow();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "./harness.ts";
import { makeStat } from "./mock-upstream.ts";

let h: Harness;
afterEach(() => h?.dispose());

describe("executor 模式 single", () => {
  test("首次 switchTo 自动选 Key、PUT 切组、缓存 sk", async () => {
    h = createHarness();
    h.mock.keys.set(11, { id: 11, name: "我的Key", key: "sk-user-11", group_id: 5 });
    const key = await h.executor.switchTo(9);
    expect(key.groupId).toBe(9);
    expect(key.sk).toBe("sk-user-11");
    expect(h.mock.keys.get(11)!.group_id).toBe(9);
    expect(h.credentials.singleKeySk).toBe("sk-user-11");
    expect(h.state.currentGroupId).toBe(9);
    // currentKey 反映最新
    expect(h.executor.currentKey()).toMatchObject({ sk: "sk-user-11", groupId: 9 });
  });

  test("无任何 Key 时报清晰错误", async () => {
    h = createHarness();
    expect(h.executor.switchTo(9)).rejects.toThrow(/没有可用 API Key/);
  });

  test("token 过期 → 自动 refresh → 重试成功", async () => {
    h = createHarness();
    h.mock.keys.set(11, { id: 11, name: "k", key: "sk-user-11", group_id: 5 });
    h.mock.expireToken = true;
    const key = await h.executor.switchTo(7);
    expect(key.groupId).toBe(7);
    expect(h.mock.refreshCalls).toBe(1);
  });
});

describe("executor 模式 pool", () => {
  function poolHarness(poolMaxGroups = 3): Harness {
    return createHarness({ configPatch: { keyMode: "pool", poolMaxGroups } });
  }

  test("首次切组自动建 aihub-auto-g{gid} Key;二次复用", async () => {
    h = poolHarness();
    const k1 = await h.executor.switchTo(5);
    expect(k1.sk).toStartWith("sk-mock-");
    const created = [...h.mock.keys.values()].find((k) => k.name === "aihub-auto-g5");
    expect(created).toBeDefined();
    expect(created!.group_id).toBe(5);

    const countAfterFirst = h.mock.keys.size;
    const k2 = await h.executor.switchTo(5);
    expect(k2.sk).toBe(k1.sk);
    expect(h.mock.keys.size).toBe(countAfterFirst); // 未重复创建
  });

  test("LRU 逐出:超过上限删最久未用,当前组受保护", async () => {
    h = poolHarness(2);
    await h.executor.switchTo(1);
    await Bun.sleep(5);
    await h.executor.switchTo(2);
    await Bun.sleep(5);
    await h.executor.switchTo(3); // 触发逐出 group1
    const names = [...h.mock.keys.values()].map((k) => k.name).sort();
    expect(names).toEqual(["aihub-auto-g2", "aihub-auto-g3"]);
    expect(Object.keys(h.state.pool).sort()).toEqual(["2", "3"]);
  });

  test("对账:回收孤儿前缀 Key,绝不动非前缀 Key,清理失效记录", async () => {
    h = poolHarness();
    // 远端孤儿(前缀但 state 不认识)
    h.mock.keys.set(91, { id: 91, name: "aihub-auto-g99", key: "sk-orphan", group_id: 99 });
    // 用户自己的 Key(非前缀)
    h.mock.keys.set(92, { id: 92, name: "my-precious", key: "sk-user", group_id: 1 });
    // state 记录但远端已删
    h.state.pool["77"] = { keyId: 777, sk: "sk-gone", lastUsedAt: Date.now() };

    await h.executor.reconcile();

    expect(h.mock.keys.has(91)).toBe(false); // 孤儿回收
    expect(h.mock.keys.has(92)).toBe(true); // 用户 Key 不动
    expect(h.state.pool["77"]).toBeUndefined(); // 失效记录清理
  });

  test("cleanup 删除全部自建 Key", async () => {
    h = poolHarness();
    await h.executor.switchTo(1);
    await h.executor.switchTo(2);
    h.mock.keys.set(92, { id: 92, name: "my-precious", key: "sk-user", group_id: 1 });
    await h.executor.cleanup();
    expect([...h.mock.keys.values()].map((k) => k.name)).toEqual(["my-precious"]);
    expect(Object.keys(h.state.pool)).toHaveLength(0);
  });
});

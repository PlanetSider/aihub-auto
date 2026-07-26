import type { AIHubClient } from "@aihub-auto/core";
import { AIHubApiError } from "@aihub-auto/core";
import type { AppState, Credentials } from "./config.ts";
import type { Logger } from "./logger.ts";

export const POOL_KEY_PREFIX = "aihub-auto-g";

export interface ActiveKey {
  sk: string;
  groupId: number;
}

export interface ExecutorDeps {
  client: AIHubClient;
  state: AppState;
  credentials: Credentials;
  logger: Logger;
  keyMode: "single" | "pool";
  singleKeyId?: number;
  poolMaxGroups: number;
  persistState: () => Promise<void>;
  persistCredentials: () => Promise<void>;
  /** 401 时由 daemon 注入的续期回调;成功返回 true */
  reauth: () => Promise<boolean>;
}

/**
 * 路由执行器:把"目标分组"落到 AIHub 账号上。
 * 模式 single:PUT /keys/{id} {group_id} 切组,反代始终用同一把 sk。
 * 模式 pool:每组一把 aihub-auto-g{gid} 自建 Key,切换=换 sk(毫秒级,缓存互不干扰);
 *   LRU 超限删除,启动对账回收孤儿;绝不触碰非前缀 Key。
 */
export class RouteExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  /** 反代当前应注入的 Key */
  currentKey(): ActiveKey | undefined {
    const { state, credentials, keyMode } = this.deps;
    if (state.currentGroupId === undefined) return undefined;
    if (keyMode === "single") {
      if (!credentials.singleKeySk) return undefined;
      return { sk: credentials.singleKeySk, groupId: state.currentGroupId };
    }
    const entry = state.pool[String(state.currentGroupId)];
    if (!entry) return undefined;
    entry.lastUsedAt = Date.now();
    return { sk: entry.sk, groupId: state.currentGroupId };
  }

  /** 带 401 重试的调用包装 */
  private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AIHubApiError && err.status === 401) {
        const ok = await this.deps.reauth();
        if (ok) return await fn();
      }
      throw err;
    }
  }

  /** 切换到目标组;返回切换后反代应使用的 Key */
  async switchTo(groupId: number): Promise<ActiveKey> {
    return this.deps.keyMode === "single"
      ? this.switchSingle(groupId)
      : this.switchPool(groupId);
  }

  private async switchSingle(groupId: number): Promise<ActiveKey> {
    const { state, credentials, logger } = this.deps;
    let keyId = this.deps.singleKeyId;
    if (keyId === undefined || !credentials.singleKeySk) {
      const keys = await this.withAuth(() => this.deps.client.listAllKeys());
      const chosen =
        (keyId !== undefined ? keys.find((k) => k.id === keyId) : undefined) ??
        keys.find((k) => k.status !== "inactive");
      if (!chosen) throw new Error("账号下没有可用 API Key;请先在 AIHub 创建一个 Key");
      keyId = chosen.id;
      if (chosen.key) {
        credentials.singleKeySk = chosen.key;
        await this.deps.persistCredentials();
      } else if (!credentials.singleKeySk) {
        throw new Error(
          `Key 列表不返回 sk 明文;请在控制台把 Key(id=${keyId})的 sk 粘贴进配置(singleKeySk)`,
        );
      }
    }
    try {
      await this.withAuth(() => this.deps.client.updateKeyGroup(keyId!, groupId));
    } catch (err) {
      // PUT 失败重试一次
      logger.warn(`切组 PUT 失败,重试一次: ${err instanceof Error ? err.message : String(err)}`);
      await this.withAuth(() => this.deps.client.updateKeyGroup(keyId!, groupId));
    }
    state.currentGroupId = groupId;
    await this.deps.persistState();
    logger.info(`已切换(single):key=${keyId} → group=${groupId}`);
    return { sk: credentials.singleKeySk!, groupId };
  }

  private async switchPool(groupId: number): Promise<ActiveKey> {
    const { state, logger } = this.deps;
    const gid = String(groupId);
    let entry = state.pool[gid];
    if (!entry) {
      const created = await this.withAuth(() =>
        this.deps.client.createKey({ name: `${POOL_KEY_PREFIX}${groupId}`, groupId }),
      );
      if (!created.key) {
        throw new Error("创建 Key 未返回 sk 明文,无法用于池模式");
      }
      entry = { keyId: created.id, sk: created.key, lastUsedAt: Date.now() };
      state.pool[gid] = entry;
      logger.info(`池新建 Key:group=${groupId} keyId=${created.id}`);
      await this.evictLru(groupId);
    }
    entry.lastUsedAt = Date.now();
    state.currentGroupId = groupId;
    await this.deps.persistState();
    return { sk: entry.sk, groupId };
  }

  /** LRU 逐出:超过 poolMaxGroups 时删除最久未用且非当前组的自建 Key */
  private async evictLru(protectGroupId: number): Promise<void> {
    const { state, logger } = this.deps;
    const entries = Object.entries(state.pool);
    if (entries.length <= this.deps.poolMaxGroups) return;
    const victims = entries
      .filter(([gid]) => Number(gid) !== protectGroupId && Number(gid) !== state.currentGroupId)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    while (Object.keys(state.pool).length > this.deps.poolMaxGroups && victims.length > 0) {
      const [gid, entry] = victims.shift()!;
      try {
        await this.withAuth(() => this.deps.client.deleteKey(entry.keyId));
        delete state.pool[gid];
        logger.info(`池 LRU 删除:group=${gid} keyId=${entry.keyId}`);
      } catch (err) {
        logger.warn(`池删除失败(保留记录,下轮重试):keyId=${entry.keyId} ${err instanceof Error ? err.message : ""}`);
        break;
      }
    }
    await this.deps.persistState();
  }

  /**
   * 启动对账:远端 aihub-auto-g* 但 state 不认识 → 孤儿,删除。
   * 非前缀 Key 一律不触碰。state 记录但远端已消失 → 清理本地记录。
   */
  async reconcile(): Promise<void> {
    const { state, logger } = this.deps;
    if (this.deps.keyMode !== "pool") return;
    const keys = await this.withAuth(() => this.deps.client.listAllKeys());
    const known = new Set(Object.values(state.pool).map((e) => e.keyId));
    const remoteIds = new Set(keys.map((k) => k.id));

    for (const key of keys) {
      if (!key.name.startsWith(POOL_KEY_PREFIX)) continue;
      if (!known.has(key.id)) {
        try {
          await this.withAuth(() => this.deps.client.deleteKey(key.id));
          logger.info(`回收孤儿 Key:${key.name}(id=${key.id})`);
        } catch (err) {
          logger.warn(`孤儿 Key 回收失败:id=${key.id} ${err instanceof Error ? err.message : ""}`);
        }
      }
    }
    for (const [gid, entry] of Object.entries(state.pool)) {
      if (!remoteIds.has(entry.keyId)) {
        delete state.pool[gid];
        logger.warn(`池记录失效(远端已删):group=${gid}`);
      }
    }
    await this.deps.persistState();
  }

  /** 退出清理(可选):删除全部自建 Key */
  async cleanup(): Promise<void> {
    const { state, logger } = this.deps;
    for (const [gid, entry] of Object.entries(state.pool)) {
      try {
        await this.withAuth(() => this.deps.client.deleteKey(entry.keyId));
        delete state.pool[gid];
      } catch (err) {
        logger.warn(`退出清理失败:keyId=${entry.keyId} ${err instanceof Error ? err.message : ""}`);
      }
    }
    await this.deps.persistState();
  }
}

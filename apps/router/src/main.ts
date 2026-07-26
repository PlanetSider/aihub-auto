import { AIHubClient, CircuitBreaker, LocalObservationStore } from "@aihub-auto/core";
import { join } from "node:path";
import {
  configDir,
  FileStore,
  loadConfig,
  loadCredentials,
  loadState,
  validateListenSecurity,
} from "./config.ts";
import { RouteDaemon } from "./daemon.ts";
import { RouteExecutor } from "./executor.ts";
import { AuditLog, Logger } from "./logger.ts";
import type { ProxyDeps } from "./proxy.ts";
import { createServer } from "./server.ts";
import { TrafficTracker } from "./traffic.ts";

async function main(): Promise<void> {
  const dir = configDir();
  const store = new FileStore(dir);
  const config = await loadConfig(store);
  const state = await loadState(store);
  const credentials = await loadCredentials(store);

  const logger = new Logger(config.logLevel);
  const audit = new AuditLog(config.auditLog ? join(dir, "audit.jsonl") : undefined);

  const securityProblems = validateListenSecurity(config);
  if (securityProblems.length > 0) {
    for (const p of securityProblems) logger.error(p);
    process.exit(1);
  }

  const client = new AIHubClient({
    baseUrl: config.baseUrl,
    token: () => credentials.accessToken,
  });

  const breaker = CircuitBreaker.fromJSON(state.breaker);
  const observations = LocalObservationStore.fromJSON(state.observations);
  const traffic = new TrafficTracker();

  const persistState = async () => store.write("state.json", state);
  const persistConfig = async () => store.write("config.json", config);
  const persistCredentials = async () => store.write("credentials.json", credentials);

  const executor = new RouteExecutor({
    client,
    state,
    credentials,
    logger,
    keyMode: config.keyMode,
    singleKeyId: config.singleKeyId,
    poolMaxGroups: config.poolMaxGroups,
    persistState,
    persistCredentials,
    reauth: async () => {
      if (!credentials.refreshToken) {
        daemon.needsReauth = true;
        return false;
      }
      try {
        const session = await client.refreshSession(credentials.refreshToken);
        credentials.accessToken = session.accessToken;
        credentials.refreshToken = session.refreshToken;
        credentials.expiresAt = session.expiresAt;
        await persistCredentials();
        logger.info("token 已自动续期");
        return true;
      } catch {
        daemon.needsReauth = true;
        logger.error("token 续期失败,请重新登录(控制台)");
        return false;
      }
    },
  });

  const daemon = new RouteDaemon({
    config,
    state,
    credentials,
    client,
    executor,
    breaker,
    observations,
    traffic,
    logger,
    audit,
    persistState,
    persistCredentials,
  });

  const proxyDeps: ProxyDeps = {
    baseUrl: config.baseUrl,
    currentKey: () => executor.currentKey(),
    failover: (failed, platform) => daemon.failover(failed, platform),
    observations,
    traffic,
    logger,
    ttfbTimeoutMs: config.ttfbTimeoutMs,
    proxyToken: config.proxyToken,
  };

  let server: ReturnType<typeof createServer>;
  try {
    server = createServer({
      config,
      state,
      credentials,
      client,
      daemon,
      executor,
      proxyDeps,
      store,
      logger,
      persistConfig,
      persistCredentials,
    });
  } catch (err) {
    logger.error(
      `无法监听 ${config.listen.host}:${config.listen.port}(端口被占用?已有实例在运行?):${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  logger.info(`aihub-auto 已启动:http://${config.listen.host}:${config.listen.port}`);
  logger.info(`控制台:http://${config.listen.host === "0.0.0.0" ? "127.0.0.1" : config.listen.host}:${config.listen.port}/ui`);
  logger.info(`配置目录:${dir}`);

  // 有凭据才做启动对账 + 守护
  if (credentials.accessToken) {
    if (config.keyMode === "pool") {
      executor.reconcile().catch((err) => logger.warn(`启动对账失败:${err.message}`));
    }
    daemon.start();
  } else {
    logger.warn("尚未登录 AIHub:打开控制台完成登录后自动开始路由");
    // 轮询等待登录
    const waitLogin = setInterval(() => {
      if (credentials.accessToken) {
        clearInterval(waitLogin);
        if (config.keyMode === "pool") {
          executor.reconcile().catch((err) => logger.warn(`对账失败:${err.message}`));
        }
        daemon.start();
      }
    }, 2000);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal},优雅退出…`);
    daemon.stop();
    server.stop(true);
    if (config.keyMode === "pool" && config.cleanupPoolOnExit) {
      await executor.cleanup().catch(() => {});
    }
    state.breaker = breaker.toJSON();
    state.observations = observations.toJSON();
    await persistState().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`启动失败:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

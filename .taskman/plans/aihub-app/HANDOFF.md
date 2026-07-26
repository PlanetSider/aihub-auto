# aihub-app

`apps/router`:Bun 单二进制,本地 HTTP 反代 + 自动路由守护 + 本地 Web 控制台。依赖 `@aihub-auto/core`(算法、client、breaker、observe 全部来自 core,本计划不重写算法)。

## 架构

```
客户端(Codex/Claude Code/任意 SDK) → http://{listen.host}:8787/v1/...(反代)
                                          │ 注入当前最优 Key → https://aihub.top
守护循环(60s 可配) → usage-stats + 本地观测 → score/decide → 执行切换(模式A PUT / 模式B 换Key)
Web 控制台 /ui  控制 API /ctl/*
```

## 关键设计决定

- **监听地址可配**:默认 127.0.0.1:8787,可改任意 host/port 含 0.0.0.0。非 loopback 监听时启动强制要求 `proxyToken`(反代 /v1 需 `Authorization: Bearer {proxyToken}`)与 `uiPassword`(/ctl),缺一拒绝启动——防止公网他人烧额度;loopback 下两者可选。无 TLS(用户已确认)
- 双执行模式:`keyMode: "single"`(PUT 切组)/`"pool"`(每候选组自动建 `aihub-auto-g{groupId}` Key,LRU 上限默认 4 组,启动/退出/对账时删除多余自建 Key,**绝不删除非本工具前缀的 Key**)
- 故障转移:请求未向客户端写回任何字节前,上游 5xx/429/连接错误/TTFB 超时 → 记熔断 → 立刻用下一候选组重试(≤2 次);已开始回包则中断并如实透传
- 流式:SSE/chunked 直通 pipe,首字节时间戳记 TTFT 进 LocalObservationStore
- 凭据:配置目录(win %LocalAppData%/aihub-auto,linux ~/.config/aihub-auto,mac ~/Library/Application Support/aihub-auto)JSON,POSIX chmod 600;token 不进日志
- 401 处理:业务 401 → refresh 一次 → 重试一次 → 仍失败标记需重新登录(控制台醒目提示)

## 验收

- `bun test` 全绿(反代/故障转移/池对账用 mock 上游测)
- 本机启动后:配置 token → 状态页显示候选表与当前分组 → mock 场景故障转移生效
- 非 loopback 无 proxyToken 启动被拒;带 token 请求通过、无 token 401
- `scripts/build.ts` 产出 6 目标压缩包;GitHub Actions tag 触发发布(repo: aihub-auto)

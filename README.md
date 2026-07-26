# aihub-auto

AIHub 最优分组自动路由。一套算法核心,两件产品:

- **apps/router** — 跨平台单二进制反代应用:自动选最优分组、故障转移、缓存感知切换
- **packages/koishi-plugin-aihub-auto** — Koishi 插件:群聊查询当前最优分组
- **packages/core** — 共享算法核心(评分/决策/熔断/观测,零运行时依赖)

## 开发

```bash
bun install
bun run check   # 测试 + 类型检查
```

详细算法说明见 `packages/core/ALGORITHM.md`。

# aihub-koishi

`packages/koishi-plugin-aihub-auto`:在指定适配器+群号(通配符)响应 `/最优分组` 与 `最优分组`,输出 top1~6 推荐 + 应用下载链接。算法与 API client 全部复用 `@aihub-auto/core`(scoring.recommendTopN),本计划零算法代码。

## Koishi 对接要点(实现前用 context7/koishi.chat 复核最新 API,不凭记忆写)

- 包名必须 `koishi-plugin-*` 才能被插件市场/loader 识别;`koishi` 放 peerDependencies;package.json 加 `koishi` 字段(description/service 声明)
- 触发要同时覆盖两种形态:`ctx.command('最优分组')` 注册指令(吃 `/最优分组`,受全局 prefix 配置影响)+ `ctx.middleware` 精确匹配裸文本 `最优分组`(去除 @bot 前缀后 trim 全等,不做包含匹配防误触)
- 作用域过滤:`session.platform` 匹配适配器(如 onebot);`session.guildId` 匹配群规则。规则形如 `onebot:1059338666`、`onebot:*`、`*:*`,`*` 通配(逐段 glob,仅 `*` 通配符,转正则时 escape 其余字符防注入)。私聊默认不响应(可配)
- HTTP 用 `ctx.http`(尊重 Koishi 全局代理/超时),把 `ctx.http` 适配成 core client 的 fetch 注入
- 用 `ctx.schema`/`Schema.object` 出配置表单,中文描述,koishi 控制台可视化编辑

## 回复格式(用户示例,条数 1~6 由 recommendTopN 自动定)

```
AIHub 当前推荐
策略:{strategyText 配置项,用户后补文案}
1. A001-Plus/K12(#57)|0.03x|9584 ms
2. A012-K12(#30)|0.06x|4300 ms
下载:{downloadUrl}
```

## 验收

- @koishijs/plugin-mock 单测全绿:两种触发形态、通配符正/反例、非目标群沉默、API 挂时的降级文案、缓存生效
- `bun run build` 产出可发布 npm 包(dist + dts),README 含配置表

# aihub-auto — 规划上下文

## 意图

从 0 开发:①跨平台应用(反代 + 最优分组自动路由 + 故障转移)②Koishi 插件(群聊查询最优分组)。目标站 aihub.top(sub2api 魔改),参考并超越 OnRightPath/AIHubRouter。

## 调研结论(已验证)

### AIHub API(实测可用)

- `GET /api/v1/public/groups/usage-stats?samples=N&platform=P&max_rate=R` 公开无鉴权
  - item: `{code, platform("openai"|"anthropic"), rate_multiplier, avg_ttft_ms, sample_count, last_sample_at, group_id}`
  - `platform=claude` 返回空,正确值是 `anthropic`
- 认证类(参考项目在用,需账号 token):
  - `POST /api/v1/auth/login` (email+password) / `POST /api/v1/auth/refresh` / `GET /api/v1/auth/me`
  - `GET /api/v1/groups/available`、`GET /api/v1/groups/rates`(用户专属倍率,优先于公开倍率)
  - `GET /api/v1/keys?page=&page_size=` 分页列 Key
  - **`PUT /api/v1/keys/{keyId}` body `{group_id}` = 切换 Key 分组(路由的实际执行机制)**

### AIHubRouter 现状(C#/.NET10, Avalonia+CLI+Web)

- **不代理流量**,只定时看公开统计并 PUT 切分组
- 算法:
  - confidence = freshness(指数半衰, MaxAge/2) × volume(1-e^(-n/20)) × stability(1/(1+CV))
  - 保守延迟 = avg × (1 + (1-confidence))
  - score = latencyWeight×speedupRatio − priceWeight×pricePremiumRatio(相对最低倍率基准)
  - 硬过滤: 样本≤15min、confidence≥0.20、平台匹配、有权限、非黑名单、倍率有限非负、价格区间硬约束(默认 0~0.15x)
  - 粘性: 新候选得分优势 > 0.10 才切换;无冷却、无最短驻留
  - 模式: Economy 0.8/0.2, Balanced 0.5/0.5, Speed 0.2/0.8
- 发布矩阵: win/linux/osx × x64/arm64

### 我们要超越的点(用户要求)

1. **真反代**: 客户端指向本地代理 → 转发 aihub.top;从真实流量实测自己的 TTFT/错误率(参考项目只有公开均值)
2. **真故障转移**: 上游 5xx/429/超时 → 熔断该分组 → 切换 → 重试(参考项目看不到流量做不到)
3. **缓存感知**: 切分组=上游账号变=prompt cache 失效。算法要把"切换成本"显式建模(空闲窗口再切/切换收益须超过缓存损失),而不是只靠 0.10 粘性
4. 省钱/均衡/极速三模式 + 价格区间 + 黑名单(保留参考项目优点)
5. 不用考虑证书 → 本地 HTTP 即可

## 用户需求原文要点

- Koishi 插件: 指定适配器(如 onebot)+ 群号(支持通配符, 如 1059338666), 触发词 `/最优分组` 或 `最优分组`,回复格式:

  ```
  AIHub 当前推荐
  策略:(用户回头补文案)
  1. A001-Plus/K12(#57)|0.03x|9584 ms
  2. A012-K12(#30)|0.06x|4300 ms
  3. A001-Plus(#34)|0.06x|6012 ms
  + 应用下载 GitHub 链接
  ```

- 应用: 三大平台、反代实现、最优选择+故障转移、缓存感知、价格/速度/均衡可选、算法要最好

## 倾向方案(待用户确认)

- TS monorepo(bun workspaces): `packages/core`(算法+API client, 零依赖) / `apps/router`(反代+守护+Web UI, bun compile 单二进制 6 目标) / `packages/koishi-plugin-aihub-router`(复用 core)
- 一种语言共享算法,Koishi 插件天然 TS
- UI = 本地 Web 页面(localhost, 无证书), 不做原生窗口
- 凭据: 用户配置目录 JSON + 0600 权限(v1 不做系统钥匙串)

## 已拍板(用户确认)

1. 三大平台 = win/linux/mac 桌面
2. 技术栈 = TS monorepo + Bun 单二进制(算法一份代码,插件/应用共享;bun compile 覆盖 6 目标,二进制比 deno 小)
3. 路由执行双模式:A=单 Key PUT 切组(即 sub2api 后台同款接口);B=自动创建 Key 池(`POST /api/v1/keys` {name,group_id})+自动删除(`DELETE /api/v1/keys/{id}`,只删 `aihub-auto-` 前缀自建 Key)
4. Koishi 展示条数自动 1~6:按分数降序,与最优分差 ≤ scoreWindow 截断
5. repo 名 = aihub-auto;下载链接做成插件配置项
6. base URL 可配(默认 aihub.top),不承诺兼容其他站(usage-stats 是 aihub 自有接口)

## sub2api Key API(已从上游源码确认)

- `POST /api/v1/keys` body `{name, group_id?}` → 创建(响应含 key 明文)
- `PUT /api/v1/keys/{id}` body `{group_id}` → 切组
- `DELETE /api/v1/keys/{id}` → 删除
- 均为账号 Bearer token 鉴权(非 sk- key)

## 结构

initiative `aihub-auto` → 3 plans: aihub-core(算法包+monorepo) → aihub-app(反代应用) / aihub-koishi(插件),后两者依赖 core

## 开放问题

1. 三大平台 = Windows/Linux/macOS?(还是含移动端?)
2. 技术栈认可 TS+bun 单二进制?(备选 Go/Tauri)
3. 故障转移机制: 单 Key PUT 切组(参考项目式) vs 多 Key 池(每组预建 Key,切换=换 Key,毫秒级+不互相踩)?
4. Koishi 回复: 均衡策略 top3?还是三种策略各 top1?文案模板可配?
5. GitHub repo 名(下载链接用)?
6. 站点 base URL 可配置(通用 sub2api)还是写死 aihub.top?

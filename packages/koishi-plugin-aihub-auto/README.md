# koishi-plugin-aihub-auto

查询 [AIHub](https://aihub.top) 当前最优或最烂分组。插件只读取公开统计并回复排名,**不会修改 AIHub Key 或执行切组**。

群里发 `最优分组` 或 `/最优分组`,机器人回复:

```text
AIHub 当前推荐
策略:价格与首字延迟均衡
1. A001-Plus/K12(#57)|0.03x|9584 ms
2. A012-K12(#30)|0.06x|4300 ms
3. A001-Plus(#34)|0.06x|6012 ms
下载:https://github.com/WSXYT/aihub-auto/releases/latest
```

发 `最烂分组` 或 `/最烂分组` 则只回复 1 个:先取最高有效倍率层,再选其中首字延迟最慢的分组:

```text
AIHub 当前最烂分组
策略:最高倍率优先,同倍率首字最慢
1. A099-Plus(#99)|0.15x|12800 ms
下载:https://github.com/WSXYT/aihub-auto/releases/latest
```

- 最优条数**自适应 1~6 条**:分数接近就多列,断层就只列头部
- 最烂固定只发 **1 条**:有效候选中倍率最高优先,同倍率则保守首字延迟最慢优先
- 只比较倍率在 `maxRate` 内且具有有效 TTFT 的候选;不会把无效数据当作“最烂”
- 评分算法与 [aihub-auto](https://github.com/WSXYT/aihub-auto) 自动路由应用同源:置信度加权、保守延迟修正、价格与首字延迟三种策略
- `economy` 只约束最优推荐;最烂查询仍覆盖 `maxRate` 内全部有效倍率层
- 仅查询 AIHub 当前提供的 OpenAI 分组

## 安装

插件市场搜索 `aihub-auto`,或:

```bash
npm i koishi-plugin-aihub-auto
```

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `rules` | `["onebot:*"]` | 生效范围,每项 `平台:群号`,`*` 通配。示例:`onebot:1059338666`(指定群)、`onebot:*`(OneBot 全部群)、`*:*`(所有平台) |
| `baseUrl` | `https://aihub.top` | 站点地址(usage-stats 为 AIHub 自有接口,不兼容其他 sub2api 站) |
| `mode` | `balanced` | `economy` 省钱 / `balanced` 均衡 / `speed` 速度 |
| `maxRate` | `0.15` | 最大倍率硬约束 |
| `samples` | `100` | 每组统计样本条数 |
| `scoreWindow` | `0.15` | 最优推荐窗口:与最优分差在窗口内才展示 |
| `strategyText` | `价格与首字延迟均衡` | 「策略:」后的文案,可自定义 |
| `downloadUrl` | 应用 Releases | 自动路由应用下载链接 |
| `template` | 见下 | 最优分组回复模板,变量 `{strategy}` `{items}` `{download}` |
| `worstTemplate` | 见下 | 最烂分组回复模板,变量同上 |
| `cacheTtlMs` | `30000` | 推荐结果缓存 |
| `cooldownMs` | `10000` | 每群冷却 |
| `respondPrivate` | `false` | 是否响应私聊 |
| `errorText` | `AIHub 数据暂不可用,请稍后再试` | 降级文案 |

默认模板:

```text
AIHub 当前推荐
策略:{strategy}
{items}
下载:{download}
```

最烂分组默认模板只将首行改为 `AIHub 当前最烂分组`。

## 触发方式

- `/最优分组`、`/最烂分组`(经指令系统,支持你配置的全局 prefix 与 help)
- 裸文本 `最优分组`、`最烂分组`(中间件精确匹配,@机器人后跟触发词也可)

两种方式同一消息只回一次;同类查询在冷却期内重复触发静默,最优和最烂的冷却互不阻塞。

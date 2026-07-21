# Billing 功能说明

本文面向产品、研发和 QA，说明 `billing` 分支当前已经实现的云端计费能力。文中所述套餐均按组织生效，同一组织下的所有 Project 共享套餐、额度和账期。

## 套餐概览

| 套餐       | 当前入口             |                月费 |         包含用量 | 数据访问         | 用户与主要能力                                                                                   |
| ---------- | -------------------- | ------------------: | ---------------: | ---------------- | ------------------------------------------------------------------------------------------------ |
| Developer  | 默认套餐             |                免费 | 100,000 units/月 | 30 天            | 最多 2 位组织成员，1 个 annotation queue                                                         |
| Pro        | Billing 页面自助升级 |             $199/月 | 200,000 units/月 | 3 年（1,095 天） | 不限组织成员和 annotation queues，支持 Data retention management                                 |
| Teams      | 自助入口已屏蔽       | Pro + $300/月附加项 |         继承 Pro | 3 年             | 继承 Pro，并包含 SSO、Project 级 RBAC、审计日志等权益；当前仅兼容已有 Stripe 订阅和 webhook 解析 |
| Enterprise | 联系销售             |                定制 |         合同约定 | 合同约定         | Cloud 或 Self-hosted、合同定价和发票、企业支持与控制能力                                         |

内部仍使用 `cloud:hobby` 表示 Developer，以兼容历史数据；界面统一显示为 Developer。`cloud:core` 仅保留历史兼容，不提供购买入口。

当前自助 Checkout 的目标参数只接受 `cloud:pro`。Teams Price 环境变量、Teams add-on 识别和既有订阅权益解析仍保留，但 Billing 页面不展示 Teams 购买卡片，也不接受 `cloud:team` 自助变更。

Self-hosted Open Source 不接入 Stripe，不执行云端免费额度阻断，用量不受上述 Cloud 套餐限制。

## Units 与超额计费

计量使用服务端 `created_at`，不使用客户端回填的业务时间。当前聚合口径为：

- `events_full` 中每个根事件计 1 个 trace unit；
- `events_full` 中每个事件计 1 个 observation unit；
- `scores` 中每条 score 计 1 个 score unit；
- 将组织下所有未删除 Project 的结果相加。

QA 固定测试数据的当前预期聚合结果为 **4 units**，首次上报和同一小时重放都必须保持 4，不得重复累计。

Developer 达到 80,000 units 后进入 `WARNING`，达到 100,000 units 后进入 `BLOCKED`。开启 enforcement 时，系统会通知组织 OWNER/ADMIN，并阻止新的 ingestion 写入；下一账期或成功升级后自动解除。

Pro 的 Stripe Usage Price 使用 Graduated tiers：

- 前 200,000 units：$0；
- 200,001 及以上：$0.00004/unit，即每额外 100,000 units 收取 $4；
- 应用向 Stripe 上报原始 units，不在应用侧预先扣除 200,000 免费额度；
- Billing 页面展示的超额金额是折扣前估算，最终税费、折扣和发票金额以 Stripe 为准。

## 订阅生命周期

- Developer 升级 Pro：创建 Stripe Checkout，包含 Pro 固定月费和 Usage Price 两个 line items。
- Pro 再次选择 Pro：不产生变更。
- 已有 Teams 订阅切换 Pro：创建 Stripe Subscription Schedule，在当前账期结束时移除 Teams add-on。
- Paid 降回 Developer：设置 `cancel_at_period_end=true`，当前账期内继续保留付费权益。
- 取消待生效降级：释放 Subscription Schedule；取消待生效退订：清除 `cancel_at_period_end`。
- 组织删除：若仍有 Stripe 订阅，先立即取消订阅；Stripe 取消失败时中止组织删除，避免留下孤立扣费。

Stripe 状态与权益关系：

| Stripe 状态                                | 当前权益处理                 |
| ------------------------------------------ | ---------------------------- |
| `active`、`trialing`、`past_due`           | 保留 Pro/Teams 权益          |
| `unpaid`、`canceled`、`incomplete_expired` | 清除付费套餐，回到 Developer |
| 其他非付费状态                             | 不视为有效付费订阅           |

`past_due` 期间 Billing 页面会提示更新付款方式，但仍暂时保留付费访问。

## 3 年数据访问与 Data retention management

这两个概念互不等价：

- **3 年数据访问**是套餐的查询访问窗口。Pro/Teams 的 `data-access-days` 为 1,095 天，Developer 为 30 天。
- **Data retention management** 是 Project 级主动删除策略。拥有 `data-retention` 权益的套餐可以为每个 Project 设置 `retentionDays`；到期后由 Worker 异步删除数据。

Retention 不只管理 S3：

- Doris 批量清理器删除 `traces`、`observations`、`scores`、`events_full` 中超过 Project 截止时间的数据；
- Media 清理器删除过期媒体的 S3 对象和 PostgreSQL 记录；
- 启用 blob storage file log 时，同时删除过期 ingestion blob，并清理 Doris 引用；
- 未设置 `retentionDays` 表示不主动按 Project retention 删除，但查询仍受套餐数据访问窗口约束。

## 权限、覆盖与区域隔离

- Billing 页面和所有 Billing tRPC 操作要求 `langfuseCloudBilling:CRUD` 组织权限；默认由 OWNER/ADMIN 使用。
- `cloudConfig.plan` 仅表示人工套餐覆盖。存在人工覆盖时，页面显示“Billing is managed manually”，自助 Checkout、变更和 Portal 均禁用。
- Stripe webhook 验证后的套餐保存在 `cloudConfig.stripe.resolvedPlan`，不会覆盖人工套餐字段。
- Customer、Checkout Session 和 Subscription metadata 都携带 `orgId` 与 `cloudRegion`。
- webhook 对 `cloudRegion` 与当前部署不一致的订阅不做处理，避免跨区域串单。

## 当前限制

- 只支持 USD 月付 Pro 自助购买；没有年付入口。
- Teams 和 Enterprise 均没有自助 Checkout；Enterprise 走销售、合同或发票。
- 批量折扣和合同价不在应用中硬编码，由 Stripe 折扣、优惠券、专用 Price 或销售合同处理。
- 免费额度按小时聚合，属于最终一致；达到 100,000 后到 Worker 下一次刷新前可能有少量超出。
- 当前写入 guard 已覆盖公共 ingestion、OTel traces、v1 score POST 和 media POST；v2 score 与 MCP 写操作是 QA 必须重点验证并记录的覆盖缺口。

## 延伸阅读

- [用户使用手册](user-guide.md)
- [技术设计](technical-design.md)
- [QA 测试重点](qa-test-focus.md)
- [自测报告](self-test-report.md)

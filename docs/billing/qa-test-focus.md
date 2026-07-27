# Billing QA 测试重点

本文是 Billing 分支的 QA 执行清单。测试统一按当前聚合实现断言 **3 units**，不使用其他口径。

## 测试目标与优先级

- P0：会导致错误扣费、重复计费、错误阻断、跨区域串单或付费权益丢失。
- P1：状态展示、权限、恢复路径、配置错误和数据保留边界。
- P2：文案、可观测性和非关键兼容行为。

建议为每个用例保留 Organization ID、Stripe Customer/Subscription/Event ID、账期、Doris 查询结果、`billing_meter_backups` 记录和 Stripe meter summary 截图。

## 环境准备

### Stripe Sandbox

创建并记录三个 Price：

1. Pro monthly：Recurring、Monthly、$199。
2. Usage Price：Usage-based、Per tier、Graduated，关联 meter event `litefuse_units`：
   - 0–200,000：每 unit $0；
   - 200,001–∞：每 unit $0.00004；
   - aggregation 为 Sum，event ingestion 为 Raw。

确认配置的是 `price_...`，不是 `prod_...`。

### 环境变量

Web 至少配置：

```dotenv
NEXT_PUBLIC_LITEFUSE_CLOUD_REGION="DEV"
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRO_MONTHLY_PRICE_ID="price_..."
STRIPE_USAGE_PRICE_ID="price_..."
```

Worker 至少配置：

```dotenv
NEXT_PUBLIC_LITEFUSE_CLOUD_REGION="DEV"
STRIPE_SECRET_KEY="sk_test_..."
QUEUE_CONSUMER_CLOUD_USAGE_METERING_QUEUE_IS_ENABLED="true"
QUEUE_CONSUMER_FREE_TIER_USAGE_THRESHOLD_QUEUE_IS_ENABLED="true"
LITEFUSE_FREE_TIER_USAGE_THRESHOLD_ENFORCEMENT_ENABLED="false"
```

先以 enforcement `false` 运行 shadow 测试。需要验证邮件和阻断时再单独改为 `true`，避免污染其他本地测试 Organization。

### Webhook 与服务

启动本地基础设施、Web 和 Worker 后，用 Stripe CLI 转发 webhook：

```bash
stripe listen --forward-to http://localhost:3000/api/billing/stripe-webhook
```

把 CLI 输出的 `whsec_...` 配置为 Web 使用的 `STRIPE_WEBHOOK_SECRET`，重启 Web 使变量生效。不要把测试 secret 提交到仓库。

## P0：套餐与订阅生命周期

| 编号      | 场景             | 操作                                | 预期                                                                              |
| --------- | ---------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| BIL-P0-01 | Developer → Pro  | OWNER 完成 Checkout                 | line items 为 Pro 固定费 + usage；metadata 含 orgId/cloudRegion；webhook 后为 Pro |
| BIL-P0-02 | Teams 入口屏蔽   | 检查 UI，并向接口提交 `cloud:team`  | UI 无 Teams 购买卡；接口校验拒绝                                                  |
| BIL-P0-03 | Pro 重选 Pro     | 已有 Pro 时选择 Pro                 | 返回 no-op，不新建订阅或 schedule                                                 |
| BIL-P0-04 | 既有 Teams → Pro | 构造含 Teams add-on 的订阅后切换    | 本账期仍为 Teams，账期末 schedule 移除 add-on                                     |
| BIL-P0-05 | Paid → Developer | 点击账期末取消                      | `cancel_at_period_end=true`，本账期保留付费权益，显示待生效 Developer             |
| BIL-P0-06 | 恢复订阅         | 待取消期间 Reactivate               | 清除取消标记，计划变更消失                                                        |
| BIL-P0-07 | 清除 schedule    | 待 Teams → Pro 时 Keep current plan | schedule 被释放，继续当前套餐                                                     |
| BIL-P0-08 | 付款异常         | 依次同步 past_due、unpaid           | past_due 保留权益并告警；unpaid 清除付费状态并回 Developer                        |
| BIL-P0-09 | 删除组织         | 有 active subscription 时删除       | 先立即取消 Stripe 订阅；取消失败则组织不删除                                      |

同时验证 `active`、`trialing`、`past_due` 保留付费权益，`unpaid`、`canceled`、`incomplete_expired` 清除付费权益。

## P0：权限、覆盖和区域

| 编号      | 场景                                    | 预期                                                          |
| --------- | --------------------------------------- | ------------------------------------------------------------- |
| BIL-P0-10 | OWNER/ADMIN 操作 Billing                | 允许                                                          |
| BIL-P0-11 | MEMBER 调用 Billing tRPC                | 返回 Forbidden，不泄露 Billing 状态                           |
| BIL-P0-12 | `cloudConfig.plan` 人工覆盖             | 人工套餐优先；Checkout、变更和 Portal 禁用                    |
| BIL-P0-13 | webhook `cloudRegion` 不同              | 不更新 Organization，不失效本区域套餐                         |
| BIL-P0-14 | Customer/Checkout/Subscription metadata | 均包含正确 orgId/cloudRegion，Checkout 另含 userId/targetPlan |
| BIL-P0-15 | Price ID 误填 Product ID                | catalogue 不可购买，页面显示配置错误                          |

## P0：Webhook 幂等与恢复

| 编号     | 场景                           | 预期                                                  |
| -------- | ------------------------------ | ----------------------------------------------------- |
| WH-P0-01 | 同一 event ID 连续投递         | 第一次 processed，之后 duplicate；只存在一条事件记录  |
| WH-P0-02 | 首次处理失败后 Stripe 重试     | failed 事件可 reclaim，成功后 processed 且 error 清空 |
| WH-P0-03 | 两个请求并发投递               | 5 分钟 lease 内只有一个处理者，另一个返回 duplicate   |
| WH-P0-04 | processing 超过 5 分钟         | 新请求可 reclaim 并完成                               |
| WH-P0-05 | 签名缺失或错误                 | 返回 400，不写套餐状态                                |
| WH-P0-06 | 重复 subscription/invoice 事件 | 同一账期的 `cloudCurrentCycleUsage` 不被重复清零      |

## P0：Usage Price 结算

用 Stripe Sandbox 的 meter event 或 Worker 链路分别验证：

| 原始用量 | 固定月费 | Usage 金额 |          预期账单小计（税前、无折扣） |
| -------: | -------: | ---------: | ------------------------------------: |
|        0 |     $199 |         $0 |                                  $199 |
|  200,000 |     $199 |         $0 |                                  $199 |
|  200,001 |     $199 |   $0.00004 | $199.00004，Stripe 展示按币种精度处理 |
|  300,000 |     $199 |         $4 |                                  $203 |

检查 Usage Price 为 `tiered_mode=graduated`，第一层 up_to 为 200,000 且 unit amount 为 0，第二层无上限且美元单价为 0.00004。注意 Stripe API 可能以“分”为单位返回 `0.004` cents，对应 `$0.00004`。

## P0：Worker 自动聚合上报

### 固定 3 units 用例

1. 创建专用 Organization、至少一个 Project、Stripe Customer 和包含 Pro + Usage Price 的订阅。
2. 在一个完整小时内写入固定 billing fixture，并等待 Doris 可查询。
3. 触发 `cloud-usage-metering-job`，或等待每小时第 5 分钟任务。
4. 检查 `billing_meter_backups`：interval、org_id、customer、event_name 正确，`aggregated_value=3`，成功后 `submitted_at` 非空。
5. 检查 Stripe meter summary：对应账期增加 3 units。
6. 对同一个小时再次触发任务，确认 backup 仍是一条、Stripe summary 仍为 3，不重复收费。

### 追赶与失败恢复

| 编号      | 场景                          | 预期                                                                     |
| --------- | ----------------------------- | ------------------------------------------------------------------------ |
| MTR-P0-01 | 多 Project 同 Organization    | 各 Project units 相加，只向同一 Customer 上报                            |
| MTR-P0-02 | 不同 Organization             | 各自使用自己的 Customer 和 identifier，不串单                            |
| MTR-P0-03 | Stripe API 暂时失败           | API 内重试 3 次；job 失败后 BullMQ 最多重试 5 次；未成功不写 submittedAt |
| MTR-P0-04 | Worker 漏跑多个小时           | 从 CronJobs lastRun 逐小时追赶，直到 caughtUp                            |
| MTR-P0-05 | 两个 Worker 同时 claim        | processing lease/CAS 只允许一个推进 interval                             |
| MTR-P0-06 | 零用量                        | 不创建 meter event，不影响 checkpoint 推进                               |
| MTR-P0-07 | 使用客户端历史 timestamp 回填 | 按服务端 created_at 归入当前小时                                         |

每个 event identifier 必须符合 `litefuse:{orgId}:{intervalStartSeconds}`。

## P0：Developer 阈值和 API 阻断

分别构造 79,999、80,000、99,999、100,000 units：

|    用量 | enforcement=true                          | enforcement=false        |
| ------: | ----------------------------------------- | ------------------------ |
|  79,999 | state=null，不发信、不阻断                | 只更新 usage             |
|  80,000 | WARNING，OWNER/ADMIN 各收到一次预警       | 只更新 usage，state=null |
|  99,999 | 保持 WARNING，不重复发信                  | 只更新 usage，state=null |
| 100,000 | BLOCKED，发一次阻断通知，API Key 缓存失效 | 只更新 usage，state=null |

BLOCKED 后验证以下写入均返回一致 403：

- public ingestion；
- OTel v1 traces；
- v1 score POST；
- media POST。

同时验证 trace/observation/score 读取、Billing 状态、Portal 和 Pro 升级仍可用。账期重置或升级为付费套餐后，state 清空、API Key 缓存失效，使用原 API Key 可以恢复写入。

付费 Organization 即使当前周期超过 100,000 units，也不得进入免费额度 BLOCKED。

### 必须记录的当前缺口

- v2 score POST/PUT 当前未接入 suspension guard：QA 应验证并记录实际结果，若 BLOCKED 时仍可写入，按已知覆盖缺口提交问题。
- MCP prompt 创建/更新等写操作当前未接入 suspension guard：处理方式同上。

## P1：账期边界

- Developer 无显式 anchor 时使用 Organization 创建日；
- Stripe 订阅建立后切换到 period start；
- 付费服务结束后从 period end 开始 Developer 周期；
- 同一 anchor 的重复 webhook 不清零 usage，anchor 真正变化时清零；
- 29/30/31 日锚点在短月份使用当月最后一天；
- 当前应用把 anchor 归一到 UTC 00:00，需专门验证 Stripe period start 非 00:00 时边界是否符合业务预期，并记录差异。

## P1：Billing UI

覆盖以下状态截图：

- Developer 正常、WARNING、BLOCKED；
- Pro 正常和 250,000 units（预计超额 $2）；
- Teams 历史订阅、past_due、待降级 Pro；
- 待取消 Developer、恢复成功；
- Stripe 未配置、Price ID 无效、无 Customer；
- 人工套餐覆盖；
- Checkout success/cancelled 回跳。

## P1：Data retention

- 同一 Organization 建两个 Project，分别设置不同 `retentionDays`，确认 cutoff 互不影响；
- 验证 Doris 的 traces、observations、scores、events_full 均删除到期数据，未到期数据保留；
- 验证 media S3 对象与 PostgreSQL media 记录清理；
- 启用 blob log 时验证 ingestion S3 文件和 Doris 引用清理；
- `retentionDays=null` 的 Project 不进入主动清理；小于 3 天的配置被接口拒绝；
- 验证 Pro 的 1,095 天访问窗口与自定义 retention 是两套独立行为。

## 回归命令

```bash
pnpm --filter web run test --testPathPatterns="billing-pro.servertest.ts"
pnpm --filter web run test-client --testPathPatterns="BillingSettings.clienttest.tsx"
pnpm --filter web run test --testPathPatterns="ingestion-suspension.servertest.ts"
pnpm --filter worker test -- src/features/billing/billing.unit.test.ts
pnpm run lint
pnpm run typecheck
pnpm run build:check
```

Billing 涉及 Prisma schema 时还应执行 `pnpm run db:generate`。测试专用 Stripe Customer、Subscription、meter event 可关联资源和本地 Organization 必须在验证后清理。

## 通过标准

- 所有 P0 用例通过，且没有重复 meter event、跨 Organization/区域串单或错误免费额度阻断；
- 3 units fixture 首次上报与重放后均为 3；
- Stripe 300,000 units 发票预览为 `$199 + $4 = $203`（税前、无折扣）；
- 已知 v2 score/MCP guard 与账期时分秒边界有明确测试记录，不得被误标为已通过；
- 自动化测试、lint、typecheck、build 结果连同失败原因一并附在 QA 报告中。

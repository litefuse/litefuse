# Billing 用户使用手册

本文说明 Cloud 组织管理员如何查看用量、升级 Pro、管理订阅以及配置 Project 数据保留。Self-hosted Open Source 不使用本页面的 Stripe 流程。

## 进入 Billing 页面

1. 登录 Litefuse Cloud。
2. 进入目标 Organization 的 **Settings**。
3. 选择 **Billing**。

Billing 入口只在 Cloud 部署中显示，并要求当前用户拥有 `langfuseCloudBilling:CRUD` 权限。普通 MEMBER 无法查看或操作组织 Billing。

## 查看当前状态

页面顶部展示：

- 当前套餐和 Stripe 订阅状态；
- 当前账期已使用 units、包含额度和重置日期；
- Pro 已成功提交给 Stripe 的 units，以及尚未上报的 Pending units；
- Pro 超出 200,000 units 后的预计超额金额；
- 待生效的降级或退订；
- Stripe 未配置、Price ID 错误、付款异常或人工套餐覆盖提示。

用量按 Organization 汇总，同一 Organization 下所有 Project 共享额度。Pro 的预计超额金额按 `$0.00004 × overage units` 计算，未包含可能的优惠、税费或合同调整。

Pro 主用量等于 **Reported to Stripe + Pending**。Reported 表示 Stripe API 已接受对应 meter event；Stripe Dashboard 仍可能需要短暂时间完成异步聚合。Pending 是 metering checkpoint 之后、当前账期内的 Doris 用量估算。

## 从 Developer 升级到 Pro

1. 在 Pro 套餐卡片点击 **Upgrade to Pro**。
2. 浏览器跳转到 Stripe Checkout。
3. 在 Stripe 完成付款信息和订阅确认。
4. 返回 Billing 页面后等待 webhook 同步；页面会先显示 Checkout 完成提示，随后更新为 Pro。

Pro 当前价格为 $199/月，包含 200,000 units；超出部分每 100,000 units 收取 $4。Checkout 中应同时包含 Pro 固定月费和 Usage Price。

当前 Teams 自助购买已屏蔽，页面不会显示 “Pro + Teams” 购买卡片。Enterprise 通过 **Contact sales** 联系销售。

## 管理付款方式、税务信息和发票

点击 **Payment methods & invoices** 进入 Stripe Customer Portal。付款方式、税务信息、历史发票和 Stripe 支持的客户资料均在 Portal 中管理。

以下情况按钮不可用：

- Organization 尚未创建 Stripe Customer；
- Stripe 未配置；
- Organization 使用人工套餐覆盖。

## 取消、恢复和清除待生效变更

### 账期末取消

有有效订阅时点击 **Cancel at period end**。取消不会立即降级，当前账期结束前仍保留 Pro/Teams 权益；页面显示 Developer 的待生效日期。

### 恢复订阅

在取消真正生效前点击 **Reactivate subscription**，系统清除 Stripe 的账期末取消标记，订阅继续续费。

### 保持当前套餐

若页面显示 **Scheduled billing change**，点击 **Keep current plan** 可释放待生效的 Subscription Schedule，或撤销待生效的账期末取消。

## Developer 用量预警和阻断

|   当前账期用量 | 页面/系统行为                                             |
| -------------: | --------------------------------------------------------- |
|       0–79,999 | 正常使用                                                  |
|  80,000–99,999 | `WARNING`；开启 enforcement 时向 OWNER/ADMIN 发送一次预警 |
| 100,000 及以上 | `BLOCKED`；开启 enforcement 时暂停新的受控 ingestion 写入 |

达到上限后：

- 已有数据和读取接口仍可使用；
- Billing 页面、Stripe Portal 和升级入口仍可使用；
- 等待下一账期刷新后自动恢复，或升级 Pro 并等待 webhook/用量任务解除阻断；
- 阻断按小时刷新，状态可能不会在第 100,000 个 unit 写入后立即变化。

如果部署处于 shadow mode（enforcement 关闭），系统只更新用量，不发送阈值邮件，也不阻断写入。

## 付款异常

当订阅为 `past_due` 时，页面显示 **Payment needs attention**。此时付费权益暂时保留，请尽快通过 Stripe Portal 更新付款方式。若 Stripe 最终将订阅置为 `unpaid`、`canceled` 或 `incomplete_expired`，系统会清除付费状态并回到 Developer。

## 人工套餐覆盖

若页面显示 **Billing is managed manually**，说明 Organization 的 `cloudConfig.plan` 由运营或合同人工设置：

- 无法自助升级、降级、取消或打开 Stripe Portal；
- 请联系支持或销售处理套餐与账单变更；
- 人工覆盖优先于 webhook 解析出的 Stripe 套餐。

## 配置 Project Data Retention

Pro 及具有 `data-retention` 权益的套餐可以按 Project 配置主动删除周期：

1. 进入目标 Project 的 **Settings**。
2. 打开 Data Retention 配置。
3. 输入至少 3 天的保留天数；设置为不限定时不执行 Project retention 删除。
4. 保存后，Worker 将异步清理超过截止时间的数据。

该设置是 Project 级别，同一 Organization 下不同 Project 可以使用不同的 `retentionDays`。它会影响 Doris 事件数据、媒体和启用了 blob log 的 S3 ingestion 文件，不只是 S3。

“3 年数据访问”只是 Pro 的最大查询访问窗口，不会自动把每个 Project 的 retention 设置成 3 年。

## 常见问题

### Checkout 按钮不可用

确认当前用户有 Billing 权限，Organization 没有人工套餐覆盖，并且服务端已配置有效的 `price_` 类型 Pro Price ID 与 Usage Price ID。

### Checkout 完成后仍显示 Developer

套餐由 Stripe webhook 最终确认。检查 webhook 是否转发到 `/api/billing/stripe-webhook`、签名密钥是否正确、事件是否属于当前 `cloudRegion`。

### 用量与刚写入的数据不一致

Developer 用量由 Worker 每小时刷新，Billing 页面不是实时计数器。Pro 页面会同时展示已上报和待上报部分；等待每小时 metering 任务追平后，Pending 应降为 0。

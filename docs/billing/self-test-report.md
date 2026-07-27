# Billing 自测报告

本文汇总 Billing 分支交付 QA 前已经执行的自测。状态含义：

最近一次定向自动化复核日期：**2026-07-27**。

- **通过**：自动化测试或静态检查完成且成功；
- **已验证**：在 Stripe Sandbox 或本地完整链路中人工验证成功；
- **需重验**：实现口径已变化，原人工验证结果需要按新口径复核；
- **被阻塞**：已执行，但由非本功能的既有问题阻断；
- **未执行**：尚无完整结果，QA/合并前仍需执行。

## 结果摘要

| 范围                              | 状态   | 结果                                                                    |
| --------------------------------- | ------ | ----------------------------------------------------------------------- |
| Billing server tests              | 通过   | 17/17                                                                   |
| Billing client tests              | 通过   | 2/2                                                                     |
| Shared billing query tests        | 通过   | 3/3；root span 同时计入 trace 与 observation                            |
| Worker billing unit tests         | 通过   | 5/5                                                                     |
| Ingestion suspension server tests | 通过   | 2/2                                                                     |
| Billing 相关 targeted ESLint      | 通过   | 无 lint error                                                           |
| Stripe Sandbox Usage Price/账单   | 已验证 | 300,000 units → $199 + $4 = $203                                        |
| Worker 自动聚合上报 E2E           | 需重验 | Langfuse 对齐口径预期聚合 4 units；需确认 checkpoint 与同小时重放仍为 4 |
| 全量 web typecheck                | 被阻塞 | 既有 NextAuth 重复类型及 `index.clienttest.tsx` 页面校验错误            |
| 全仓 lint/typecheck/build:check   | 被阻塞 | shared/worker 类型与构建通过；既有 lint warning 和 Web 页面校验阻断     |

## 自动化测试明细

### Billing server：17/17 通过

测试文件：`web/src/__tests__/server/billing-pro.servertest.ts`

已覆盖：

- Pro catalogue 和 Checkout 固定费/usage line items；
- Teams 不作为自助目标；
- Product ID 误配置拒绝；
- active/canceled/past_due 和 unpaid/canceled/incomplete_expired 权益处理；
- Teams add-on 解析；
- 重复订阅事件不重复清零账期用量；
- 错误 cloud region 忽略；
- webhook 重复事件、失败后重试、processing lease；
- OWNER 允许、MEMBER 拒绝；
- 人工套餐覆盖禁用自助操作。

### Billing client：2/2 通过

测试文件：`web/src/features/billing/components/BillingSettings.clienttest.tsx`

已覆盖：

- Developer 100,000 units 与 BLOCKED 提示；
- 历史 Teams 状态、past_due、待降级、Pro 超额展示；
- 页面不展示 Pro + Teams 自助购买卡片。

### Worker billing unit：5/5 通过

测试文件：`worker/src/features/billing/billing.unit.test.ts`

已覆盖：

- 79,999、80,000、99,999、100,000 的阈值映射；
- Organization + interval 的确定性 Stripe identifier。

### Shared billing query：3/3 通过

测试文件：

- `packages/shared/src/server/repositories/billing.unit.test.ts`
- `packages/shared/src/server/repositories/observations.unit.test.ts`

已覆盖按日、按小时和当前账期的 observation 聚合均包含 root span。

### Ingestion suspension：2/2 通过

测试文件：`web/src/__tests__/server/ingestion-suspension.servertest.ts`

已覆盖未阻断时允许写入，以及阻断时统一抛出 HTTP 403 `ForbiddenError`。该测试验证共享 guard，本身不代表所有写入路由都已经接入 guard。

## Stripe Sandbox 验证

状态：**已验证**。

已确认 Usage Price 配置：

- Usage-based、per tier、Graduated；
- meter event name 为 `litefuse_units`，aggregation 为 Sum，event ingestion 为 Raw；
- 前 200,000 units 免费；
- 后续 `$0.00004/unit`；
- 通过 API 查看时第二层单价可能显示为 `0.004` cents，与美元单价一致。

端到端结算验证：

1. 创建专用 Stripe Customer 和包含 Pro + Usage Price 的 Subscription；
2. 上报 300,000 units meter event；
3. Stripe meter summary 显示 300,000；
4. invoice preview 显示 Pro $199、Usage $4、合计 $203（税前、无折扣）；
5. 验证后清理专用 Subscription/Customer。

## Worker 自动聚合上报 E2E

状态：**需按新口径重新验证**。

验证链路：Doris 测试数据 → BullMQ job → Billing Worker → PostgreSQL `BillingMeterBackup` → Stripe meter summary → invoice preview。

结果：

- 使用独立 Organization、Project、Stripe Customer 和 Subscription；
- 当前固定 fixture 的 Langfuse 对齐口径预期为 **4 units**；
- `BillingMeterBackup.aggregatedValue` 应为 4，且 `submittedAt` 应成功写入；
- Stripe meter summary 应收到对应 interval 的 4 units；
- 对同一小时重放后应仍为 4，没有重复累计；
- 第二个订阅内 interval 在 200,000 免费层内应显示 `4 × Litefuse Usage`，金额为 $0；
- 验证结束后清理测试 Organization 和 Stripe 资源。

## 静态检查

### Targeted ESLint

状态：**通过**。Billing 相关改动文件没有产生 targeted ESLint 错误。

### 全量 web typecheck

状态：**被阻塞**。

执行全量 web typecheck 时遇到两个既有问题：

- `web/src/server/auth.ts:499` 的 NextAuth adapter 重复类型依赖冲突；
- `web/src/pages/organization/[organizationId]/settings/index.clienttest.tsx` 被生成的 Next.js 页面校验当作页面模块，但没有 default export。

这些错误不在 Billing 改动范围内，不能据此将 Billing typecheck 标记为通过；最终合并前仍需在基线问题解决后重跑。

### Package lint、typecheck 与 build:check

状态：**部分通过，仓库既有问题阻断全绿**。

- shared typecheck 和 worker typecheck 通过；
- `pnpm run build:check` 中 shared、worker 构建通过，Web 被上述 `index.clienttest.tsx` 页面校验错误阻断；
- shared lint 被 52 个既有 warning 阻断，worker lint 被 14 个既有 warning 阻断，均无 error；
- Web lint 持续运行约 15 分钟仍未完成，手动结束；本次改动文件的 targeted ESLint 无 error；
- 本次没有 Prisma schema 变更；`build:check` 使用缓存成功完成了 `db:generate`。

## 尚未执行或未完整覆盖

以下项目当前没有完整通过记录：

- 所有 Billing 生命周期在真实浏览器 UI 中的完整回归；
- webhook 超过 5 分钟 processing lease 后 reclaim；
- Worker Stripe 失败重试、多个漏跑小时追赶和双 Worker 并发 claim；
- 80k/100k 实际邮件仅发送一次、shadow mode、账期重置和升级自动解封；
- 所有受控写入路由的真实 HTTP 403 回归；
- Project retention 对 Doris、S3 和 PostgreSQL 的完整 E2E；
- 组织删除时 Stripe 取消失败中止删除的故障注入测试。

当前实现中 v2 score 和 MCP 写操作尚未接入 suspension guard；这是 QA 需要记录的已知覆盖缺口，不应归入“已通过”。账期 helper 把 Stripe anchor 归一到 UTC 00:00，非零时分秒的边界也需要单独验证。

## 建议复现命令

```bash
pnpm --filter web run test --testPathPatterns="billing-pro.servertest.ts"
pnpm --filter web run test-client --testPathPatterns="BillingSettings.clienttest.tsx"
pnpm --filter web run test --testPathPatterns="ingestion-suspension.servertest.ts"
pnpm --filter worker test -- src/features/billing/billing.unit.test.ts
```

完整 QA 场景和环境准备见 [QA 测试重点](qa-test-focus.md)。

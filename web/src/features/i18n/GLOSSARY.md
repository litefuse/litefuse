# zh-CN glossary

Canonical Chinese for recurring product terms. **Read this before translating a
batch.** Consistency across several hundred files matters more than any single
phrasing, so prefer the term here even when another reading fits better. To
change an entry, update it here and re-translate every affected key in the same
commit.

## Style

- Chinese punctuation for Chinese sentences（，。？：、），ASCII punctuation
  inside code, identifiers and URLs.
- One space between Chinese and adjacent Latin or digits: `使用 3 个 Token`.
- Second person is 你, never 您.
- Full sentences end with 。Short labels, buttons and column headers do not.
- Keep product and protocol names in Latin: Litefuse, OpenTelemetry, Doris,
  ClickHouse, Prisma, Slack, GitHub, Webhook, API, SDK, URL, JSON, CSV.
- `Tokenizer` stays Latin or becomes 分词器; it is not 词元器.
- Do not translate a string the SDK or the API reads. See
  [README](./README.md) and `locales.clienttest.ts`.
- Do not translate error text. Server error messages and the global error toast
  stay English, so the heading and the body always match. See the README.

## Domain

| English           | 中文        | Note                                                        |
| ----------------- | ----------- | ----------------------------------------------------------- |
| Trace             | 追踪        | Never 跟踪 / 轨迹                                           |
| Observation       | 观测        |                                                             |
| Span              | Span        | OpenTelemetry term, left in Latin                           |
| Generation        | 生成        |                                                             |
| Session           | 会话        |                                                             |
| Score             | 评分        | The value and the act                                       |
| Dataset           | 数据集      |                                                             |
| Dataset item      | 数据集条目  |                                                             |
| Dataset run       | 数据集运行  |                                                             |
| Experiment        | 实验        |                                                             |
| Prompt            | 提示词      |                                                             |
| Prompt version    | 提示词版本  |                                                             |
| Playground        | 演练场      |                                                             |
| Evaluation        | 评估        |                                                             |
| Evaluator         | 评估器      |                                                             |
| LLM-as-a-Judge    | LLM 评估    |                                                             |
| Human annotation  | 人工标注    |                                                             |
| Annotation queue  | 标注队列    |                                                             |
| Dashboard         | 仪表盘      |                                                             |
| Widget            | 组件        | On a dashboard                                              |
| Observability     | 可观测性    |                                                             |
| Prompt management | 提示词管理  |                                                             |
| Tracing           | 追踪        | The product area                                            |
| Logging           | 日志        |                                                             |
| Project           | 项目        |                                                             |
| Organization      | 组织        |                                                             |
| Member            | 成员        |                                                             |
| Role              | 角色        |                                                             |
| Environment       | 环境        |                                                             |
| Model             | 模型        |                                                             |
| Provider          | 服务商      | LLM / storage vendor. An identity provider stays 身份提供方 |
| Latency           | 延迟        |                                                             |
| Cost              | 成本        |                                                             |
| Usage             | 用量        |                                                             |
| Token             | 词元        | The LLM unit. An auth token is 令牌                         |
| Temperature       | 温度        | The sampling parameter. Top P stays English                 |
| Metadata          | 元数据      |                                                             |
| Tag               | 标签        |                                                             |
| Label (prompt)    | 版本标签    | Tags stay 标签                                              |
| Comment           | 评论        |                                                             |
| Ingestion         | 数据接入    |                                                             |
| Retention         | 数据保留    |                                                             |
| API key           | API 密钥    |                                                             |
| Access token      | 访问令牌    | Auth credential, never 词元                                 |
| Webhook           | Webhook     |                                                             |
| Plan              | 套餐        | Billing                                                     |
| Quota / Limit     | 配额 / 上限 |                                                             |

## Actions

| English   | 中文     | English    | 中文     | English  | 中文     |
| --------- | -------- | ---------- | -------- | -------- | -------- |
| Create    | 创建     | Save       | 保存     | Search   | 搜索     |
| Add       | 添加     | Cancel     | 取消     | Filter   | 筛选     |
| Edit      | 编辑     | Confirm    | 确认     | Sort     | 排序     |
| Update    | 更新     | Close      | 关闭     | Export   | 导出     |
| Delete    | 删除     | Dismiss    | 关闭     | Import   | 导入     |
| Remove    | 移除     | Refresh    | 刷新     | Copy     | 复制     |
| Duplicate | 创建副本 | Retry      | 重试     | Download | 下载     |
| Archive   | 归档     | Upgrade    | 升级     | Upload   | 上传     |
| Rename    | 重命名   | Learn more | 了解更多 | Sign in  | 登录     |
| Select    | 选择     | Settings   | 设置     | Sign up  | 注册     |
| Clear     | 清空     | Support    | 支持     | Sign out | 退出登录 |

## Status

| English  | 中文   | English   | 中文   |
| -------- | ------ | --------- | ------ |
| Enabled  | 已启用 | Succeeded | 成功   |
| Disabled | 已禁用 | Failed    | 失败   |
| Active   | 启用中 | Pending   | 待处理 |
| Inactive | 未启用 | Running   | 运行中 |
| Archived | 已归档 | Completed | 已完成 |
| Default  | 默认   | Cancelled | 已取消 |
| Loading  | 加载中 | Expired   | 已过期 |

## Recurring phrasings

| English                       | 中文                  |
| ----------------------------- | --------------------- |
| This action cannot be undone. | 此操作无法撤销。      |
| Are you sure?                 | 确定要继续吗？        |
| No data                       | 暂无数据              |
| No results found              | 未找到结果            |
| Something went wrong          | 出错了                |
| Please try again.             | 请重试。              |
| You do not have access to X.  | 你没有访问 X 的权限。 |
| Optional                      | 选填                  |
| Required                      | 必填                  |
| Coming soon                   | 即将推出              |

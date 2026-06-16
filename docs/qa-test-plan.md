# Litefuse-Doris QA 测试方案

> 目标：验证 [litefuse-doris](https://github.com/selectdb/litefuse-doris)（Doris 后端，`master` 分支）与 litefuse 原版（ClickHouse 后端，[litefuse/litefuse](https://github.com/selectdb/litefuse-doris) tag `v3.16.0` 或 `v3.16.1`）在数据写入、接口返回、Web 功能三个层面的一致性。
> 已适配 Tab：Home、Dashboard、Tracing（Traces / Observations）、Sessions、Users

---

## 一、数据写入一致性测试

### 1.1 测试目标

通过 SDK 双写同一份数据到 litefuse-doris 和 litefuse-ck 两套环境，对比 Doris 和 ClickHouse 中三张核心表（`traces`、`observations`、`scores`）的行数和字段值一致性。

### 1.2 环境准备

| 组件       | litefuse-doris   | litefuse-ck      |
| ---------- | ---------------- | ---------------- |
| Web 应用   | `localhost:3000` | `localhost:3001` |
| 分析数据库 | Apache Doris     | ClickHouse       |
| PostgreSQL | 独立实例         | 独立实例         |
| Redis      | 独立实例         | 独立实例         |

两套环境分别通过 `docker-compose` 启动，确保端口不冲突。

### 1.3 双写方案

使用 [OpenClaw](https://github.com/selectdb/openclaw-litefuse-doris-plugin) + 自研 Litefuse Doris Plugin 实现数据双写：

```
SDK Client → OpenClaw Proxy → ┬→ litefuse-doris (Doris 后端)
                               └→ litefuse-ck   (ClickHouse 后端)
```

**配置步骤：**

1. 部署 OpenClaw 代理服务，安装 litefuse-doris-plugin
2. 配置两个下游 Litefuse 实例的 API endpoint 和 API Key
3. SDK 端将 `LANGFUSE_HOST` 指向 OpenClaw 代理地址

### 1.4 测试数据集设计

准备覆盖各类场景的 SDK 调用脚本（建议使用 Python SDK）：

| 场景编号 | 场景描述                                     | 覆盖数据                                                                    |
| -------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| W-01     | 基础 trace 创建                              | trace 基础字段：name, user_id, metadata, tags, release, version, session_id |
| W-02     | trace 含 input/output（含 emoji 和特殊字符） | Doris 使用 Variant 类型，需验证 emoji 🎉、中文、JSON 嵌套                   |
| W-03     | 多层级 observation（span + generation）      | observation 的 parent_observation_id 层级关系                               |
| W-04     | generation 含 usage 和 cost 信息             | provided_usage_details, usage_details, cost_details, total_cost             |
| W-05     | generation 含 model 信息                     | provided_model_name, internal_model_id, model_parameters                    |
| W-06     | generation 含 prompt 关联                    | prompt_id, prompt_name, prompt_version                                      |
| W-07     | score 写入（NUMERIC 类型）                   | value 为浮点数                                                              |
| W-08     | score 写入（CATEGORICAL 类型）               | string_value 字段                                                           |
| W-09     | score 写入（BOOLEAN 类型）                   | value 为 0/1                                                                |
| W-10     | session 级数据                               | 同一 session_id 下多个 trace                                                |
| W-11     | 多用户数据                                   | 不同 user_id 的 trace                                                       |
| W-12     | environment 标记                             | 不同 environment（production, staging, development）                        |
| W-13     | 批量写入（50+ traces）                       | 验证并发写入一致性                                                          |
| W-14     | trace 更新（upsert）                         | 同一 trace id 多次写入，验证 merge 行为                                     |
| W-15     | observation 含 completion_start_time         | time_to_first_token 计算                                                    |
| W-16     | score 关联 observation                       | observation_id 字段                                                         |
| W-17     | metadata 含多种 KV 类型                      | Map<String, String> 字段存储                                                |
| W-18     | tags 为空数组 / 多元素数组                   | Array<String> 字段                                                          |

### 1.5 数据校验方法

#### 1.5.1 行数校验

对三张表分别执行 count 查询，结果需完全一致：

```sql
-- Doris
SELECT count(*) FROM traces WHERE project_id = '{projectId}';
SELECT count(*) FROM observations WHERE project_id = '{projectId}';
SELECT count(*) FROM scores WHERE project_id = '{projectId}';

-- ClickHouse（需 FINAL 关键字去重）
SELECT count(*) FROM traces FINAL WHERE project_id = '{projectId}' AND is_deleted = 0;
SELECT count(*) FROM observations FINAL WHERE project_id = '{projectId}' AND is_deleted = 0;
SELECT count(*) FROM scores FINAL WHERE project_id = '{projectId}' AND is_deleted = 0;
```

#### 1.5.2 字段值校验

逐条对比核心字段，以下字段必须一致：

**traces 表：**

| 字段        | 预期一致性 | 备注                                                      |
| ----------- | ---------- | --------------------------------------------------------- |
| id          | 完全一致   |                                                           |
| name        | 完全一致   |                                                           |
| timestamp   | 完全一致   | 精度 ms                                                   |
| user_id     | 完全一致   |                                                           |
| session_id  | 完全一致   |                                                           |
| release     | 完全一致   |                                                           |
| version     | 完全一致   |                                                           |
| tags        | 完全一致   | 数组顺序一致                                              |
| public      | 完全一致   |                                                           |
| bookmarked  | 完全一致   |                                                           |
| environment | 完全一致   |                                                           |
| input       | 语义一致   | Doris 用 Variant，CK 用 Nullable(String)；JSON 解析后对比 |
| output      | 语义一致   | 同上                                                      |
| metadata    | 完全一致   | Map 类型，KV 对一致                                       |

**observations 表：**

| 字段                   | 预期一致性 | 备注                                     |
| ---------------------- | ---------- | ---------------------------------------- |
| id                     | 完全一致   |                                          |
| trace_id               | 完全一致   |                                          |
| type                   | 完全一致   | SPAN / GENERATION / EVENT                |
| name                   | 完全一致   |                                          |
| start_time             | 完全一致   |                                          |
| end_time               | 完全一致   |                                          |
| parent_observation_id  | 完全一致   |                                          |
| level                  | 完全一致   |                                          |
| status_message         | 完全一致   |                                          |
| provided_model_name    | 完全一致   |                                          |
| internal_model_id      | 完全一致   |                                          |
| model_parameters       | 完全一致   |                                          |
| provided_usage_details | 完全一致   | Map 类型                                 |
| usage_details          | 完全一致   | Map 类型                                 |
| provided_cost_details  | 数值一致   | Doris: Decimal(38,12), CK: Decimal64(12) |
| cost_details           | 数值一致   | 同上                                     |
| total_cost             | 数值一致   | 同上                                     |
| completion_start_time  | 完全一致   |                                          |
| prompt_id              | 完全一致   |                                          |
| prompt_name            | 完全一致   |                                          |
| prompt_version         | 完全一致   |                                          |
| environment            | 完全一致   |                                          |
| input                  | 语义一致   | Variant vs Nullable(String)              |
| output                 | 语义一致   | 同上                                     |

**scores 表：**

| 字段           | 预期一致性 | 备注       |
| -------------- | ---------- | ---------- |
| id             | 完全一致   |            |
| trace_id       | 完全一致   |            |
| observation_id | 完全一致   |            |
| session_id     | 完全一致   |            |
| name           | 完全一致   |            |
| value          | 数值一致   | Float 精度 |
| source         | 完全一致   |            |
| data_type      | 完全一致   |            |
| string_value   | 完全一致   |            |
| comment        | 完全一致   |            |
| environment    | 完全一致   |            |

#### 1.5.3 已知 Schema 差异（不影响一致性判定）

| 差异项               | ClickHouse                   | Doris                               | 说明                                                 |
| -------------------- | ---------------------------- | ----------------------------------- | ---------------------------------------------------- |
| input/output 类型    | Nullable(String) CODEC(ZSTD) | Variant                             | Doris Variant 支持更灵活的 JSON，对比时需 JSON parse |
| cost 精度            | Decimal64(12)                | Decimal(38,12)                      | Doris 精度范围更大，数值相等即可                     |
| usage_details 值类型 | Map(String, UInt64)          | Map(String, Int)                    | 数值相等即可                                         |
| 引擎特性             | ReplacingMergeTree           | UNIQUE KEY OLAP                     | Doris 天然去重，CK 需 FINAL                          |
| 分区策略             | toYYYYMM(timestamp)          | AUTO PARTITION BY RANGE(date_trunc) | 透明差异，不影响数据                                 |
| 索引类型             | bloom_filter                 | INVERTED                            | 透明差异，不影响数据                                 |

### 1.6 校验脚本建议

编写 Python 校验脚本，自动化对比：

```python
# 伪代码
def compare_tables():
    for table in ['traces', 'observations', 'scores']:
        doris_rows = query_doris(f"SELECT * FROM {table} WHERE project_id='{pid}' ORDER BY id")
        ck_rows = query_ck(f"SELECT * FROM {table} FINAL WHERE project_id='{pid}' AND is_deleted=0 ORDER BY id")

        assert len(doris_rows) == len(ck_rows), f"{table} 行数不一致"

        for doris_row, ck_row in zip(doris_rows, ck_rows):
            for field in COMPARE_FIELDS[table]:
                doris_val = normalize(doris_row[field])
                ck_val = normalize(ck_row[field])
                assert doris_val == ck_val, f"{table}.{field} 不一致: {doris_val} vs {ck_val}"
```

---

## 二、接口一致性测试

### 2.1 测试目标

对 Home、Dashboard、Traces、Observations、Sessions、Users 页面涉及的所有 tRPC 接口，分别请求 litefuse-doris 和 litefuse-ck，对比 response 中同名字段的值一致性。

**核心原则：ClickHouse 返回的字段 Doris 一定也要有，数值型字段允许微小精度差异（< 0.001）。**

### 2.2 测试方法

1. 两套环境使用相同数据（通过第一部分的双写保证）
2. 使用脚本同时调用两套环境的 tRPC 接口
3. 对比 response JSON，忽略已知差异字段

**tRPC 接口调用方式：**

```bash
# tRPC batch 调用示例
curl 'http://localhost:3000/api/trpc/traces.all?batch=1' \
  -H 'Content-Type: application/json' \
  -H 'Cookie: next-auth.session-token=xxx' \
  --data '{"0":{"json":{"projectId":"xxx","filter":[],"orderBy":{"column":"timestamp","order":"DESC"},"page":0,"limit":50}}}'
```

### 2.3 接口清单与校验点

#### 2.3.1 Traces 页面（`/project/[projectId]/traces`）

| 编号 | 接口                                   | 校验点                                                                                                                                | 优先级 |
| ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T-01 | `traces.hasTracingConfigured`          | 返回 boolean 一致                                                                                                                     | P0     |
| T-02 | `traces.all`                           | 列表条数一致；每条 trace 的 id, name, timestamp, user_id, session_id, tags, release, version, environment, bookmarked, public 一致    | P0     |
| T-03 | `traces.countAll`                      | count 数值一致                                                                                                                        | P0     |
| T-04 | `traces.metrics`                       | 每条 trace 的 latency, observation_count, total_cost, level, error_count, warning_count, scores_avg, usage_details, cost_details 一致 | P0     |
| T-05 | `traces.filterOptions`                 | 返回的 name 列表、tag 列表、user 列表、session 列表一致（顺序可不同）                                                                 | P1     |
| T-06 | `traces.byId`                          | 单条 trace 的所有字段一致（input/output JSON parse 后对比）                                                                           | P0     |
| T-07 | `traces.byIdWithObservationsAndScores` | trace 详情 + observations 列表 + scores 列表的字段一致                                                                                | P0     |
| T-08 | `scores.getScoreColumns`               | score 列定义（name, source, data_type）集合一致                                                                                       | P1     |
| T-09 | `projects.environmentFilterOptions`    | environment 列表一致                                                                                                                  | P1     |

**traces.filterOptions 子查询校验：**

| 子编号 | 函数                                | 校验点                          |
| ------ | ----------------------------------- | ------------------------------- |
| T-05a  | `getTracesGroupedByName`            | name 列表一致，count 一致       |
| T-05b  | `getTracesGroupedByTags`            | tag 集合一致                    |
| T-05c  | `getTracesGroupedByUsers`           | user_id 列表一致，count 一致    |
| T-05d  | `getTracesGroupedBySessionId`       | session_id 列表一致，count 一致 |
| T-05e  | `getNumericScoresGroupedByName`     | score name 列表一致             |
| T-05f  | `getCategoricalScoresGroupedByName` | score name + values 集合一致    |

#### 2.3.2 Observations 页面（`/project/[projectId]/observations`）

| 编号 | 接口                        | 校验点                                                                                                                    | 优先级 |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| O-01 | `generations.all`           | 列表条数一致；每条 observation 的 id, type, name, trace_id, start_time, end_time, level, model, latency, cost, usage 一致 | P0     |
| O-02 | `generations.countAll`      | count 数值一致                                                                                                            | P0     |
| O-03 | `generations.filterOptions` | model 列表、name 列表、prompt 列表一致                                                                                    | P1     |
| O-04 | `observations.byId`         | 单条 observation 全部字段一致（input/output JSON parse 后对比）                                                           | P0     |

**generations.filterOptions 子查询校验：**

| 子编号 | 函数                                 | 校验点                    |
| ------ | ------------------------------------ | ------------------------- |
| O-03a  | `getObservationsGroupedByModel`      | model name 列表一致       |
| O-03b  | `getObservationsGroupedByModelId`    | model id 列表一致         |
| O-03c  | `getObservationsGroupedByName`       | observation name 列表一致 |
| O-03d  | `getObservationsGroupedByPromptName` | prompt id 列表一致        |

> **注意**：`getObservationsGroupedByToolName` 和 `getObservationsGroupedByCalledToolName` 在 Doris 后端返回空数组，这是已知差异，暂不做一致性校验。

#### 2.3.3 Sessions 页面（`/project/[projectId]/sessions`）

| 编号 | 接口                      | 校验点                                                                                                               | 优先级 |
| ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| S-01 | `sessions.hasAny`         | 返回 boolean 一致                                                                                                    | P0     |
| S-02 | `sessions.all`            | session 列表一致：session_id, created_at, 关联 trace 数                                                              | P0     |
| S-03 | `sessions.countAll`       | count 数值一致                                                                                                       | P0     |
| S-04 | `sessions.metrics`        | 每个 session 的 trace_count, total_cost, duration, user_ids, trace_tags, input_usage, output_usage, total_usage 一致 | P0     |
| S-05 | `sessions.filterOptions`  | 筛选选项一致                                                                                                         | P1     |
| S-06 | `sessions.byIdWithScores` | session 详情 + scores 一致                                                                                           | P0     |

#### 2.3.4 Users 页面（`/project/[projectId]/users`）

| 编号 | 接口            | 校验点                                                                                                                     | 优先级 |
| ---- | --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| U-01 | `users.hasAny`  | 返回 boolean 一致                                                                                                          | P0     |
| U-02 | `users.all`     | user 列表一致：user_id, count                                                                                              | P0     |
| U-03 | `users.metrics` | 每个 user 的 trace_count, obs_count, total_cost, total_usage, input_usage, output_usage, max_timestamp, min_timestamp 一致 | P0     |
| U-04 | `users.byId`    | 单个 user 的指标一致                                                                                                       | P0     |

#### 2.3.5 Home / Dashboard 页面（`/project/[projectId]`）

| 编号 | 接口                                   | 校验点                                                   | 优先级 |
| ---- | -------------------------------------- | -------------------------------------------------------- | ------ |
| D-01 | `dashboard.chart` (traces 汇总)        | traces 总数、时间序列趋势一致                            | P0     |
| D-02 | `dashboard.chart` (model costs)        | 模型维度的 cost 汇总一致                                 | P0     |
| D-03 | `dashboard.chart` (model usage)        | 模型维度的 usage 汇总一致                                | P0     |
| D-04 | `dashboard.chart` (scores table)       | scores 聚合值一致                                        | P1     |
| D-05 | `dashboard.chart` (users)              | 活跃用户数一致                                           | P1     |
| D-06 | `dashboard.chart` (traces time series) | 时间序列数据点一致（Doris 使用 fillTimeSeriesGaps 填充） | P0     |
| D-07 | `dashboard.chart` (generation latency) | latency 指标（p50/p75/p90/p95/p99）一致，允许 < 5% 偏差  | P1     |
| D-08 | `dashboard.scoreHistogram`             | 直方图分桶和计数一致                                     | P1     |
| D-09 | `dashboard.executeQuery` (自定义查询)  | 查询结果一致                                             | P1     |

> **已知差异说明：**
>
> - latency 百分位数：Doris 使用 `percentile_approx()`，CK 使用 `quantile()`，算法不同可能导致微小差异（< 5%）
> - histogram：两端分桶实现不同，允许边界值微调
> - 时间序列：Doris 无 `WITH FILL`，由应用层 `fillTimeSeriesGaps()` 补零，结果应一致

#### 2.3.6 Public API 接口

除 tRPC 内部接口外，以下 Public REST API 也需要校验：

| 编号 | 接口                                       | 方法 | 校验点       | 优先级 |
| ---- | ------------------------------------------ | ---- | ------------ | ------ |
| P-01 | `/api/public/traces`                       | GET  | 列表数据一致 | P0     |
| P-02 | `/api/public/traces/[traceId]`             | GET  | 单条数据一致 | P0     |
| P-03 | `/api/public/observations`                 | GET  | 列表数据一致 | P0     |
| P-04 | `/api/public/observations/[observationId]` | GET  | 单条数据一致 | P0     |
| P-05 | `/api/public/sessions`                     | GET  | 列表数据一致 | P0     |
| P-06 | `/api/public/sessions/[sessionId]`         | GET  | 单条数据一致 | P0     |
| P-07 | `/api/public/metrics/daily`                | GET  | 每日指标一致 | P1     |

```bash
# Public API 调用示例
curl 'http://localhost:3000/api/public/traces?limit=10' \
  -H 'Authorization: Bearer pk-xxx:sk-xxx'
```

### 2.4 对比策略

```python
# 接口对比伪代码
def compare_api_response(doris_resp, ck_resp, config):
    # 1. 结构一致性：CK 有的字段 Doris 必须有
    for key in ck_resp.keys():
        assert key in doris_resp, f"Doris 缺少字段: {key}"

    # 2. 值一致性
    for key in config.compare_fields:
        doris_val = doris_resp[key]
        ck_val = ck_resp[key]

        if key in config.json_fields:
            # input/output 等 JSON 字段，parse 后深度对比
            assert json_equal(doris_val, ck_val)
        elif key in config.numeric_fields:
            # 数值字段，允许微小精度差异
            assert abs(float(doris_val) - float(ck_val)) < 0.001
        elif key in config.set_fields:
            # 集合类字段（tags, filter options），忽略顺序
            assert set(doris_val) == set(ck_val)
        elif key in config.percentile_fields:
            # 百分位数字段，允许 5% 偏差
            assert abs(float(doris_val) - float(ck_val)) / max(float(ck_val), 1e-10) < 0.05
        else:
            # 其他字段，严格一致
            assert doris_val == ck_val
```

### 2.5 接口测试执行流程

```
1. 确保双写数据已就绪（第一部分完成）
2. 登录两套环境，获取 session token 和 API key
3. 按优先级 P0 → P1 逐一执行接口对比
4. 记录每个接口的通过/失败状态
5. 对失败项分析是 bug 还是已知差异
```

---

## 三、Web 功能点击测试

### 3.1 测试目标

人工操作 litefuse-doris 的 Web 界面，验证各功能页面可正常使用，数据展示正确，交互无报错。

### 3.2 测试前置条件

- litefuse-doris 环境已启动（`pnpm run dev`）
- 已通过 SDK 写入足够的测试数据（来自第一部分）
- 使用 demo 账号登录：`demo@litefuse.ai` / `password`
- 打开浏览器开发者工具 Network + Console 面板，监控接口报错

### 3.3 测试用例

#### 3.3.1 Home 页面

| 编号 | 操作步骤                            | 预期结果                       |
| ---- | ----------------------------------- | ------------------------------ |
| H-01 | 进入项目首页 `/project/[projectId]` | 页面正常加载，无 console error |
| H-02 | 查看 Traces 汇总卡片                | 显示 trace 总数，数值 > 0      |
| H-03 | 查看 Model Costs 卡片               | 显示模型成本表格，金额显示正确 |
| H-04 | 查看 Model Usage 卡片               | 显示 token 使用量图表          |
| H-05 | 查看 Traces Time Series 卡片        | 时间序列图正常渲染，无空白     |
| H-06 | 查看 Users 卡片                     | 显示活跃用户数                 |
| H-07 | 查看 Scores 卡片                    | scores 表格/图表正常渲染       |
| H-08 | 查看 Latency 卡片                   | latency 表格/图表正常渲染      |
| H-09 | 切换时间范围（24h / 7d / 1m / 3m）  | 图表数据刷新，无报错           |
| H-10 | 切换 environment 筛选               | 数据按 environment 过滤        |

#### 3.3.2 Traces 页面

| 编号  | 操作步骤                                                                              | 预期结果                                            |
| ----- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| TR-01 | 进入 Traces 列表页                                                                    | 表格正常加载，显示 trace 列表                       |
| TR-02 | 检查列表中的列：Name, Timestamp, User ID, Session, Tags, Latency, Cost, Tokens, Level | 各列数据显示正确，无 undefined/null 异常            |
| TR-03 | 翻页操作（下一页 / 上一页）                                                           | 数据正确翻页，count 正确                            |
| TR-04 | 按 Timestamp 排序（升序/降序）                                                        | 排序正确                                            |
| TR-05 | 使用 Name 筛选器                                                                      | 下拉选项正常加载；筛选后列表过滤正确                |
| TR-06 | 使用 User ID 筛选器                                                                   | 同上                                                |
| TR-07 | 使用 Tags 筛选器                                                                      | 同上                                                |
| TR-08 | 使用 Session ID 筛选器                                                                | 同上                                                |
| TR-09 | 使用 Environment 筛选器                                                               | 同上                                                |
| TR-10 | 使用 Release / Version 筛选器                                                         | 同上                                                |
| TR-11 | 使用时间范围筛选器                                                                    | 数据按时间过滤                                      |
| TR-12 | 使用搜索框搜索 trace                                                                  | 搜索结果正确                                        |
| TR-13 | 使用 Score 筛选器（按 score name 和值范围）                                           | 筛选正确                                            |
| TR-14 | 点击某条 trace 进入详情页                                                             | 详情页正常加载                                      |
| TR-15 | 详情页查看 trace 基本信息                                                             | id, name, timestamp, user_id, session_id 等字段正确 |
| TR-16 | 详情页查看 Input/Output                                                               | JSON 正确渲染，emoji 正常显示                       |
| TR-17 | 详情页查看 Metadata                                                                   | metadata KV 正确显示                                |
| TR-18 | 详情页查看 Observations 列表                                                          | observations 按 start_time 排序展示                 |
| TR-19 | 详情页查看 Scores                                                                     | scores 正确显示 name, value, source                 |
| TR-20 | 详情页查看时间线视图                                                                  | observation 层级关系、latency 可视化正确            |
| TR-21 | 点击 observation 展开详情                                                             | observation 的 input/output, usage, cost 正确       |
| TR-22 | Bookmark 操作                                                                         | 书签切换正常，列表中 bookmark 状态更新              |
| TR-23 | 批量选择 trace 后删除                                                                 | 删除成功，列表刷新                                  |
| TR-24 | 更新 trace tags                                                                       | tags 更新成功                                       |
| TR-25 | 多条件组合筛选                                                                        | 多个筛选条件同时生效                                |

#### 3.3.3 Observations 页面

| 编号  | 操作步骤                                                                                | 预期结果                    |
| ----- | --------------------------------------------------------------------------------------- | --------------------------- |
| OB-01 | 进入 Observations 列表页                                                                | 表格正常加载                |
| OB-02 | 检查列表中的列：Name, Type, Trace ID, Model, Latency, TTFT, Cost, Tokens, Level, Scores | 各列数据正确                |
| OB-03 | 翻页操作                                                                                | 正常翻页                    |
| OB-04 | 按 Model 筛选                                                                           | 下拉选项正常；筛选正确      |
| OB-05 | 按 Name 筛选                                                                            | 同上                        |
| OB-06 | 按 Type 筛选（GENERATION / SPAN / EVENT）                                               | 同上                        |
| OB-07 | 按 Prompt 筛选                                                                          | 同上                        |
| OB-08 | 按 Level 筛选（ERROR / WARNING / DEFAULT / DEBUG）                                      | 同上                        |
| OB-09 | 使用时间范围筛选器                                                                      | 数据按时间过滤              |
| OB-10 | 点击某条 observation 进入详情                                                           | 详情页加载，显示完整信息    |
| OB-11 | 详情页查看 Input/Output                                                                 | JSON 渲染正确               |
| OB-12 | 详情页查看 Usage（input/output/total tokens）                                           | token 数显示正确            |
| OB-13 | 详情页查看 Cost（input/output/total cost）                                              | 成本显示正确，小数精度合理  |
| OB-14 | 详情页查看 Model Parameters                                                             | 参数 JSON 正确渲染          |
| OB-15 | 详情页查看 Prompt 信息                                                                  | prompt name 和 version 正确 |
| OB-16 | 多条件组合筛选                                                                          | 多个筛选条件同时生效        |

#### 3.3.4 Sessions 页面

| 编号  | 操作步骤                                                                           | 预期结果                         |
| ----- | ---------------------------------------------------------------------------------- | -------------------------------- |
| SE-01 | 进入 Sessions 列表页                                                               | 表格正常加载                     |
| SE-02 | 检查列表中的列：Session ID, Created At, Trace Count, Users, Duration, Cost, Tokens | 各列数据正确                     |
| SE-03 | 翻页操作                                                                           | 正常翻页                         |
| SE-04 | 使用筛选器                                                                         | 筛选功能正常                     |
| SE-05 | 使用时间范围筛选器                                                                 | 数据按时间过滤                   |
| SE-06 | 使用 Environment 筛选器                                                            | 同上                             |
| SE-07 | 点击某个 session 进入详情页                                                        | 详情页正常加载                   |
| SE-08 | 详情页查看 trace 列表                                                              | 该 session 下的 traces 正确列出  |
| SE-09 | 详情页查看 session 汇总指标                                                        | duration, cost, token usage 正确 |
| SE-10 | 详情页查看 Scores                                                                  | session 关联的 scores 正确展示   |
| SE-11 | 详情页点击某条 trace 跳转                                                          | 正确跳转到 trace 详情页          |
| SE-12 | Bookmark 操作                                                                      | 书签切换正常                     |

#### 3.3.5 Users 页面

| 编号  | 操作步骤                                                                          | 预期结果                                       |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| US-01 | 进入 Users 列表页                                                                 | 表格正常加载                                   |
| US-02 | 检查列表中的列：User ID, Trace Count, Total Cost, Tokens, Last Trace, First Trace | 各列数据正确                                   |
| US-03 | 翻页操作                                                                          | 正常翻页                                       |
| US-04 | 使用时间范围筛选器                                                                | 数据按时间过滤                                 |
| US-05 | 使用 Environment 筛选器                                                           | 同上                                           |
| US-06 | 点击某个 user 进入详情页                                                          | 详情页正常加载                                 |
| US-07 | 详情页查看 user 汇总指标                                                          | trace_count, obs_count, total_cost, usage 正确 |
| US-08 | 详情页查看 trace 列表                                                             | 该 user 下的 traces 正确列出                   |
| US-09 | 详情页点击某条 trace 跳转                                                         | 正确跳转到 trace 详情页                        |

#### 3.3.6 Dashboard 页面

| 编号  | 操作步骤                    | 预期结果                     |
| ----- | --------------------------- | ---------------------------- |
| DA-01 | 进入 Dashboards 列表页      | 页面正常加载                 |
| DA-02 | 创建新 Dashboard            | 创建成功，跳转到新 dashboard |
| DA-03 | 添加 Widget（表格类型）     | widget 正常渲染，数据加载    |
| DA-04 | 添加 Widget（时间序列图表） | 图表正常渲染                 |
| DA-05 | 添加 Widget（数值指标）     | 数值正确显示                 |
| DA-06 | 修改 Dashboard 筛选器       | widget 数据刷新              |
| DA-07 | 切换时间范围                | 所有 widget 数据刷新         |
| DA-08 | 编辑 Dashboard 名称         | 修改成功                     |
| DA-09 | 克隆 Dashboard              | 克隆成功，数据一致           |
| DA-10 | 删除 Dashboard              | 删除成功                     |

### 3.4 通用检查项

每个页面都需要关注的通用问题：

| 编号 | 检查项        | 说明                                                   |
| ---- | ------------- | ------------------------------------------------------ |
| G-01 | Console Error | 无 JavaScript 报错                                     |
| G-02 | Network Error | 无 5xx / 4xx 接口报错（除预期的 404）                  |
| G-03 | 加载状态      | 数据加载时有 loading 状态，不出现空白                  |
| G-04 | 空数据状态    | 无数据时显示空状态提示，非报错                         |
| G-05 | 大数据量      | 100+ 条数据时性能可接受（< 5s 加载）                   |
| G-06 | 时间显示      | 时间戳格式正确，时区处理正确                           |
| G-07 | 数值显示      | cost 保留合理小数位，usage 为整数                      |
| G-08 | Emoji 显示    | input/output 中的 emoji 正常渲染（Doris Variant 类型） |

---

## 四、测试执行计划

### 4.1 优先级与时间安排

| 阶段   | 内容                         | 预计工作量 | 优先级 |
| ------ | ---------------------------- | ---------- | ------ |
| 阶段一 | 环境搭建 + 双写配置          | 1 天       | P0     |
| 阶段二 | 编写 SDK 测试数据脚本        | 0.5 天     | P0     |
| 阶段三 | 执行双写，数据写入一致性校验 | 1 天       | P0     |
| 阶段四 | P0 接口一致性测试            | 2 天       | P0     |
| 阶段五 | P1 接口一致性测试            | 1 天       | P1     |
| 阶段六 | Web 功能点击测试             | 2 天       | P0     |
| 阶段七 | Bug 修复 & 回归              | 视情况     | -      |

### 4.2 测试报告模板

每轮测试完成后，填写以下报告：

```markdown
## 测试报告 - [日期]

### 环境信息

- litefuse-doris 版本：master（https://github.com/selectdb/litefuse-doris）
- litefuse-ck 版本：v3.16.0 / v3.16.1（https://github.com/selectdb/litefuse-doris）
- Doris 版本：xxx
- ClickHouse 版本：xxx

### 测试结果汇总

| 模块 | 总用例 | 通过 | 失败 | 阻塞 | 通过率 |
| ---- | ------ | ---- | ---- | ---- | ------ |

### 失败用例详情

| 编号 | 描述 | 现象 | 根因分析 | 严重程度 |
| ---- | ---- | ---- | -------- | -------- |

### 已知差异（不计为 bug）

| 差异项 | 说明 | 是否接受 |
| ------ | ---- | -------- |
```

### 4.3 通过标准

| 级别         | 标准                                                           |
| ------------ | -------------------------------------------------------------- |
| **数据写入** | 三张核心表行数 100% 一致，核心字段值 100% 一致（已知差异除外） |
| **P0 接口**  | 100% 通过                                                      |
| **P1 接口**  | 95% 以上通过                                                   |
| **Web 功能** | P0 用例 100% 通过，无阻断性 bug                                |

---

## 附录

### A. 接口完整清单

| #   | Router       | 接口                          | 数据源     | 测试分类  |
| --- | ------------ | ----------------------------- | ---------- | --------- |
| 1   | traces       | hasTracingConfigured          | Doris      | T-01      |
| 2   | traces       | all                           | Doris      | T-02      |
| 3   | traces       | countAll                      | Doris      | T-03      |
| 4   | traces       | metrics                       | Doris      | T-04      |
| 5   | traces       | filterOptions                 | Doris      | T-05      |
| 6   | traces       | byId                          | Doris      | T-06      |
| 7   | traces       | byIdWithObservationsAndScores | Doris      | T-07      |
| 8   | traces       | deleteMany                    | Doris + PG | TR-23     |
| 9   | traces       | bookmark                      | PG         | TR-22     |
| 10  | traces       | updateTags                    | Doris + PG | TR-24     |
| 11  | generations  | all                           | Doris      | O-01      |
| 12  | generations  | countAll                      | Doris      | O-02      |
| 13  | generations  | filterOptions                 | Doris      | O-03      |
| 14  | observations | byId                          | Doris      | O-04      |
| 15  | sessions     | hasAny                        | PG         | S-01      |
| 16  | sessions     | all                           | Doris      | S-02      |
| 17  | sessions     | countAll                      | Doris      | S-03      |
| 18  | sessions     | metrics                       | Doris      | S-04      |
| 19  | sessions     | filterOptions                 | Doris      | S-05      |
| 20  | sessions     | byIdWithScores                | Doris      | S-06      |
| 21  | sessions     | bookmark                      | PG         | SE-12     |
| 22  | users        | hasAny                        | Doris      | U-01      |
| 23  | users        | all                           | Doris      | U-02      |
| 24  | users        | metrics                       | Doris      | U-03      |
| 25  | users        | byId                          | Doris      | U-04      |
| 26  | dashboard    | chart                         | Doris      | D-01~D-07 |
| 27  | dashboard    | scoreHistogram                | Doris      | D-08      |
| 28  | dashboard    | executeQuery                  | Doris      | D-09      |
| 29  | scores       | getScoreColumns               | Doris      | T-08      |
| 30  | projects     | environmentFilterOptions      | Doris      | T-09      |
| 31  | Public API   | GET /traces                   | Doris      | P-01      |
| 32  | Public API   | GET /traces/[id]              | Doris      | P-02      |
| 33  | Public API   | GET /observations             | Doris      | P-03      |
| 34  | Public API   | GET /observations/[id]        | Doris      | P-04      |
| 35  | Public API   | GET /sessions                 | Doris      | P-05      |
| 36  | Public API   | GET /sessions/[id]            | Doris      | P-06      |
| 37  | Public API   | GET /metrics/daily            | Doris      | P-07      |

### B. 关键代码路径

| 模块                      | 文件路径                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| tRPC 根路由               | `web/src/server/api/root.ts`                                       |
| Traces Router             | `web/src/server/api/routers/traces.ts`                             |
| Sessions Router           | `web/src/server/api/routers/sessions.ts`                           |
| Users Router              | `web/src/server/api/routers/users.ts`                              |
| Observations Router       | `web/src/server/api/routers/observations.ts`                       |
| Dashboard Router          | `web/src/features/dashboard/server/dashboard-router.ts`            |
| Query Builder             | `web/src/features/query/server/queryBuilder.ts`                    |
| Query Executor            | `web/src/features/query/server/queryExecutor.ts`                   |
| Doris Client              | `packages/shared/src/server/doris/client.ts`                       |
| Doris Filter Factory      | `packages/shared/src/server/queries/doris-sql/factory.ts`          |
| Traces Repository         | `packages/shared/src/server/repositories/traces.ts`                |
| Observations Repository   | `packages/shared/src/server/repositories/observations.ts`          |
| Scores Repository         | `packages/shared/src/server/repositories/scores.ts`                |
| Sessions Service          | `packages/shared/src/server/services/sessions-ui-table-service.ts` |
| Backend Detection         | `packages/shared/src/server/repositories/analytics.ts`             |
| Public API - Traces       | `web/src/pages/api/public/traces/index.ts`                         |
| Public API - Observations | `web/src/pages/api/public/observations/index.ts`                   |
| Public API - Sessions     | `web/src/pages/api/public/sessions/index.ts`                       |

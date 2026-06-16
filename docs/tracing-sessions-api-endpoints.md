# Tracing & Sessions 页面接口清单

本文档记录 Litefuse 左侧导航栏 **Observability** 区域下 **Tracing**（含 Traces、Observations 两个 Tab）和 **Sessions** 页面会触发的所有 tRPC 接口，以及每个接口在 Doris 后端下执行的 SQL。

> 源码路径均基于 `packages/shared/src/server/` 目录。

---

## 1. Tracing - Traces Tab

页面路径：`/project/[projectId]/traces`

### 1.1 `traces.hasTracingConfigured`

**说明**：检查项目是否有 trace 数据
**源码**：`repositories/traces.ts` → `hasAnyTrace()`

```sql
SELECT 1
FROM traces
WHERE project_id = {projectId: String}
LIMIT 1
```

### 1.2 `traces.all`

**说明**：获取 traces 列表（分页）
**源码**：`services/traces-ui-table-service.ts` → `getTracesTableGeneric(select="rows")`

```sql
SELECT
  t.id as id,
  t.project_id as project_id,
  t.timestamp as timestamp,
  t.tags as tags,
  t.bookmarked as bookmarked,
  t.name as name,
  t.`release` as `release`,
  t.version as version,
  t.user_id as user_id,
  t.environment as environment,
  t.session_id as session_id,
  t.`public` as `public`
FROM traces t
WHERE t.project_id = {projectId: String}
  AND t.timestamp_date >= DATE(DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY))
  AND ${tracesFilterRes.query}
  ${search.query}
ORDER BY DATE(t.timestamp) DESC, t.timestamp DESC, t.event_ts DESC
LIMIT {limit: Int32} OFFSET {offset: Int32}
```

### 1.3 `traces.countAll`

**说明**：获取 traces 总数
**源码**：`services/traces-ui-table-service.ts` → `getTracesTableGeneric(select="count")`

```sql
SELECT count(*) as count
FROM traces t
WHERE t.project_id = {projectId: String}
  AND t.timestamp_date >= DATE(DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY))
  AND ${tracesFilterRes.query}
  ${search.query}
```

### 1.4 `traces.metrics`

**说明**：获取 traces 指标（latency、cost、observation levels、scores 等）
**源码**：`services/traces-ui-table-service.ts` → `getTracesTableGeneric(select="metrics")`

```sql
WITH
observations_stats AS (
  SELECT
    agg.trace_id, agg.project_id,
    agg.observation_count, agg.total_cost, agg.latency_milliseconds,
    agg.error_count, agg.warning_count, agg.default_count, agg.debug_count,
    agg.aggregated_level,
    usage_maps.usage_details, cost_maps.cost_details
  FROM (
    SELECT
      trace_id, project_id,
      COUNT(*) AS observation_count,
      SUM(total_cost) AS total_cost,
      milliseconds_diff(
        CASE WHEN max(start_time) > max(end_time) THEN max(start_time) ELSE max(end_time) END,
        CASE WHEN min(start_time) < min(end_time) THEN min(start_time) ELSE min(end_time) END
      ) as latency_milliseconds,
      sum(CASE WHEN level = 'ERROR' THEN 1 ELSE 0 END) as error_count,
      sum(CASE WHEN level = 'WARNING' THEN 1 ELSE 0 END) as warning_count,
      sum(CASE WHEN level = 'DEFAULT' THEN 1 ELSE 0 END) as default_count,
      sum(CASE WHEN level = 'DEBUG' THEN 1 ELSE 0 END) as debug_count,
      CASE
        WHEN ARRAY_CONTAINS(collect_list(level), 'ERROR') THEN 'ERROR'
        WHEN ARRAY_CONTAINS(collect_list(level), 'WARNING') THEN 'WARNING'
        WHEN ARRAY_CONTAINS(collect_list(level), 'DEFAULT') THEN 'DEFAULT'
        ELSE 'DEBUG'
      END AS aggregated_level
    FROM (
      SELECT trace_id, project_id, level, start_time, end_time, total_cost
      FROM observations o
      WHERE project_id = {projectId: String}
        AND start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)
        AND ${observationFilterRes.query}
    ) obs
    GROUP BY trace_id, project_id
  ) agg
  LEFT JOIN (
    SELECT trace_id, project_id,
      map_agg(usage_key, usage_sum) as usage_details
    FROM (
      SELECT o.trace_id, o.project_id, usage_key, sum(usage_value) as usage_sum
      FROM observations o
      LATERAL VIEW explode_map(usage_details) usage_exploded AS usage_key, usage_value
      WHERE o.project_id = {projectId: String}
        AND o.start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)
        AND ${observationFilterRes.query}
        AND usage_details IS NOT NULL
      GROUP BY o.trace_id, o.project_id, usage_key
    ) u
    GROUP BY trace_id, project_id
  ) usage_maps ON agg.trace_id = usage_maps.trace_id AND agg.project_id = usage_maps.project_id
  LEFT JOIN (
    SELECT trace_id, project_id,
      map_agg(cost_key, cost_sum) as cost_details
    FROM (
      SELECT o.trace_id, o.project_id, cost_key, sum(cost_value) as cost_sum
      FROM observations o
      LATERAL VIEW explode_map(cost_details) cost_exploded AS cost_key, cost_value
      WHERE o.project_id = {projectId: String}
        AND o.start_time >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY)
        AND ${observationFilterRes.query}
        AND cost_details IS NOT NULL
      GROUP BY o.trace_id, o.project_id, cost_key
    ) c
    GROUP BY trace_id, project_id
  ) cost_maps ON agg.trace_id = cost_maps.trace_id AND agg.project_id = cost_maps.project_id
),
scores_avg AS (
  SELECT
    project_id, trace_id,
    array_except(
      collect_list(
        CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN
          CONCAT(name, ':', CAST(avg_value AS STRING))
        ELSE NULL END
      ), [NULL]
    ) AS scores_avg,
    array_except(
      collect_list(
        CASE WHEN data_type = 'CATEGORICAL' AND string_value IS NOT NULL AND string_value != '' THEN
          CONCAT(name, ':', string_value)
        ELSE NULL END
      ), [NULL]
    ) AS score_categories
  FROM (
    SELECT project_id, trace_id, name, data_type, string_value, avg(value) as avg_value
    FROM scores s
    WHERE project_id = {projectId: String}
      AND s.timestamp >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 1 HOUR)
      AND ${scoresFilterRes.query}
    GROUP BY project_id, trace_id, name, data_type, string_value
  ) tmp
  GROUP BY project_id, trace_id
)
SELECT
  t.id as id, t.project_id as project_id, t.timestamp as timestamp,
  os.latency_milliseconds / 1000 as latency,
  os.cost_details, os.usage_details, os.aggregated_level as level,
  os.error_count, os.warning_count, os.default_count, os.debug_count,
  os.observation_count,
  s.scores_avg, s.score_categories,
  t.`public` as `public`
FROM traces t
  LEFT JOIN observations_stats os ON os.project_id = t.project_id AND os.trace_id = t.id
  LEFT JOIN scores_avg s ON s.project_id = t.project_id AND s.trace_id = t.id
WHERE t.project_id = {projectId: String}
  AND t.timestamp_date >= DATE(DATE_SUB({traceTimestamp: DateTime}, INTERVAL 2 DAY))
  AND ${tracesFilterRes.query}
  ${search.query}
ORDER BY DATE(t.timestamp) DESC, t.timestamp DESC, t.event_ts DESC
LIMIT {limit: Int32} OFFSET {offset: Int32}
```

### 1.5 `traces.filterOptions`

**说明**：获取筛选器选项，内部并行调用以下函数

#### 1.5.1 `getNumericScoresGroupedByName`

**源码**：`repositories/scores.ts`

```sql
SELECT name
FROM scores s
WHERE s.project_id = {projectId: String}
  AND s.data_type IN ('NUMERIC', 'BOOLEAN')
  AND ${timestampFilterRes.query}
GROUP BY name
ORDER BY count() DESC
LIMIT 1000
```

#### 1.5.2 `getCategoricalScoresGroupedByName`

**源码**：`repositories/scores.ts`

```sql
SELECT
  name AS label,
  collect_set(string_value) AS `values`
FROM scores s
WHERE s.project_id = {projectId: String}
  AND s.data_type = 'CATEGORICAL'
  AND ${timestampFilterRes.query}
GROUP BY name
ORDER BY count() DESC
LIMIT 1000
```

#### 1.5.3 `getTracesGroupedByName`

**源码**：`repositories/traces.ts`

```sql
SELECT name, count(*) as count
FROM traces t
WHERE t.project_id = {projectId: String}
  AND t.name IS NOT NULL
  AND ${timestampFilterRes.query}
GROUP BY name
ORDER BY count(*) DESC
LIMIT 1000
```

#### 1.5.4 `getTracesGroupedByTags`

**源码**：`repositories/traces.ts`

```sql
SELECT distinct(tag) as value
FROM traces t
LATERAL VIEW explode(tags) tmp AS tag
WHERE t.project_id = {projectId: String}
  AND ${filterRes.query}
LIMIT 1000
```

#### 1.5.5 `getTracesGroupedByUsers`

**源码**：`repositories/traces.ts`

```sql
SELECT user_id as user, count(*) as count
FROM traces t
WHERE t.project_id = {projectId: String}
  AND t.user_id IS NOT NULL
  AND t.user_id != ''
  AND ${filterRes.query}
GROUP BY user
ORDER BY count DESC
LIMIT {limit: Int32} OFFSET {offset: Int32}
```

#### 1.5.6 `getTracesGroupedBySessionId`

**源码**：`repositories/traces.ts`

```sql
SELECT session_id, count(*) as count
FROM traces t
WHERE t.project_id = {projectId: String}
  AND t.session_id IS NOT NULL
  AND t.session_id != ''
  AND ${tracesFilterRes.query}
  ${search.query}
GROUP BY session_id
ORDER BY count DESC
LIMIT {limit: Int32} OFFSET {offset: Int32}
```

### 1.6 `traces.byId`

**说明**：按需获取单条 trace 详情（表格单元格展开时触发）
**源码**：`repositories/traces.ts` → `getTraceById()`

```sql
SELECT
  id, timestamp, name, user_id, metadata, environment,
  `release`, version, project_id, `public`, bookmarked,
  tags, input, output, session_id,
  created_at, updated_at, event_ts, is_deleted
FROM traces
WHERE id = {traceId: String}
  AND project_id = {projectId: String}
  AND DATE(timestamp) = DATE({timestamp: DateTime})  -- 可选
ORDER BY event_ts DESC
LIMIT 1
```

### 1.7 `scores.getScoreColumns`

**说明**：获取 score 列定义（用于动态列渲染）
**源码**：`repositories/scores.ts` → `getScoresGroupedByNameSourceType()`

```sql
SELECT name, source, data_type
FROM scores s
WHERE s.project_id = {projectId: String}
  AND ${dorisScoresFilterRes.query}
  AND s.timestamp >= {fromTimestamp: DateTime}  -- 可选
  AND s.timestamp <= {toTimestamp: DateTime}    -- 可选
GROUP BY name, source, data_type
ORDER BY count() DESC
LIMIT 1000
```

### 1.8 `projects.environmentFilterOptions`

**说明**：获取项目的 environment 列表
**源码**：`repositories/` → `getEnvironmentsForProject()`

```sql
SELECT environments
FROM project_environments
WHERE project_id = {projectId: String}
```

### 1.9 `getScoresForTraces`（`traces.metrics` 路由第二步调用）

**说明**：获取 trace 关联的 scores，用于 metrics 聚合
**源码**：`repositories/scores.ts` → `getScoresForTracesInternal()`

```sql
SELECT ${select} FROM (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY id, project_id ORDER BY event_ts DESC) as rn
  FROM scores s
  WHERE s.project_id = {projectId: String}
    AND s.trace_id IN ({traceIds: Array(String)})
    AND s.timestamp >= DATE_SUB({traceTimestamp: DateTime}, INTERVAL 1 HOUR)  -- 可选
) ranked
WHERE rn = 1
ORDER BY event_ts DESC
LIMIT {limit: Int32} OFFSET {offset: Int32}
```

### 1.10 `getScoreStringValues`（`scores.filterOptions` 调用）

**说明**：获取 score 的 string_value 筛选选项
**源码**：`repositories/scores.ts`

```sql
SELECT string_value, count(*) as count
FROM scores s
WHERE s.project_id = {projectId: String}
  AND string_value IS NOT NULL
  AND string_value != ''
  AND ${timestampFilterRes.query}
GROUP BY string_value
ORDER BY count(*) DESC
LIMIT 1000
```

---

## 2. Tracing - Observations Tab

页面路径：`/project/[projectId]/observations`

> 根据是否开启 Beta 功能（v4 Events 模式），使用不同的组件和接口集。

### 传统模式（ObservationsTable 组件）

#### 2.1 `generations.all`

**说明**：获取 observations 列表（分页）
**源码**：`repositories/observations.ts` → `getObservationsTableInternal(select="rows")`

```sql
${scoresCte}
SELECT
  o.id, o.type, o.project_id, o.name, o.model_parameters,
  o.start_time, o.end_time, o.trace_id, o.completion_start_time,
  o.provided_usage_details, o.usage_details,
  o.provided_cost_details, o.cost_details,
  o.level, o.environment, o.status_message, o.version,
  o.parent_observation_id, o.created_at, o.updated_at,
  o.provided_model_name, o.total_cost,
  o.prompt_id, o.prompt_name, o.prompt_version, internal_model_id,
  if(isNull(end_time), NULL, milliseconds_diff(end_time, start_time)) as latency,
  if(isNull(completion_start_time), NULL, milliseconds_diff(completion_start_time, start_time)) as time_to_first_token
FROM (
  SELECT o.*,
    ROW_NUMBER() OVER (PARTITION BY o.id, o.project_id ORDER BY o.event_ts DESC) as rn
  FROM observations o
    LEFT JOIN traces t ON t.id = o.trace_id AND t.project_id = o.project_id  -- 按需
    LEFT JOIN scores_agg AS s ON s.trace_id = o.trace_id AND s.observation_id = o.id  -- 按需
  WHERE ${appliedObservationsFilter.query}
    ${search.query}
) o WHERE rn = 1
${dorisOrderBy}
LIMIT ${limit} OFFSET ${offset}
```

#### 2.2 `generations.countAll`

**说明**：获取 observations 总数
**源码**：`repositories/observations.ts` → `getObservationsTableInternal(select="count")`

```sql
SELECT count(*) as count
FROM (
  SELECT o.*
  FROM observations o
    LEFT JOIN traces t ON t.id = o.trace_id AND t.project_id = o.project_id  -- 按需
  WHERE ${appliedObservationsFilter.query}
    ${search.query}
) o
```

#### 2.3 `generations.filterOptions`

**说明**：获取筛选器选项，内部并行调用以下函数

##### `getObservationsGroupedByModel`

**源码**：`repositories/observations.ts`

```sql
SELECT o.provided_model_name as name
FROM observations o
WHERE ${appliedObservationsFilter.query}
  AND o.type = 'GENERATION'
GROUP BY o.provided_model_name
ORDER BY count(*) DESC
LIMIT 1000
```

##### `getObservationsGroupedByModelId`

```sql
SELECT o.internal_model_id as modelId
FROM observations o
WHERE ${appliedObservationsFilter.query}
  AND o.type = 'GENERATION'
GROUP BY o.internal_model_id
ORDER BY count() DESC
LIMIT 1000
```

##### `getObservationsGroupedByName`

```sql
SELECT o.name as name
FROM observations o
WHERE ${appliedObservationsFilter.query}
  AND o.type = 'GENERATION'  -- 或传入的 observationType
GROUP BY o.name
ORDER BY count() DESC
LIMIT 1000
```

##### `getObservationsGroupedByPromptName`

```sql
SELECT o.prompt_id as id
FROM observations o
WHERE ${appliedObservationsFilter.query}
  AND o.type = 'GENERATION'
  AND o.prompt_id IS NOT NULL
GROUP BY o.prompt_id
ORDER BY count() DESC
LIMIT 1000
```

##### `getObservationsGroupedByToolName`

> Doris 后端返回空数组（Doris 的 observations 表无 `tool_definitions` 列）

##### `getObservationsGroupedByCalledToolName`

> Doris 后端返回空数组（Doris 的 observations 表无 `tool_call_names` 列）

##### `getNumericScoresGroupedByName` / `getCategoricalScoresGroupedByName` / `getTracesGroupedByName` / `getTracesGroupedByTags`

> 与 Traces Tab 1.5.1 ~ 1.5.4 相同，不再重复。

#### 2.4 `observations.byId`

**说明**：按需获取单条 observation 详情
**源码**：`repositories/observations.ts` → `getObservationById()`

```sql
SELECT
  id, trace_id, project_id, environment, type,
  parent_observation_id, start_time, end_time, name,
  metadata, level, status_message, version,
  input, output,  -- fetchWithInputOutput=true 时包含
  provided_model_name, internal_model_id, model_parameters,
  provided_usage_details, usage_details,
  provided_cost_details, cost_details, total_cost,
  completion_start_time, prompt_id, prompt_name, prompt_version,
  created_at, updated_at, event_ts
FROM (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY id, project_id ORDER BY event_ts DESC) as rn
  FROM observations
  WHERE id = {id: String}
    AND project_id = {projectId: String}
    AND DATE(start_time) = DATE({startTime: DateTime})  -- 可选
    AND trace_id = {traceId: String}                    -- 可选
) ranked
WHERE rn = 1
ORDER BY event_ts DESC
```

#### 2.5 其他共用接口

| 接口 | 同上节 |
|------|--------|
| `traces.hasTracingConfigured` | 同 1.1 |
| `scores.getScoreColumns` | 同 1.7 |
| `projects.environmentFilterOptions` | 同 1.8 |
| `TableViewPresets.getDefault` / `getById` | PostgreSQL，无 Doris SQL |

### Beta 模式（ObservationsEventsTable 组件）

| 接口 | 说明 |
|------|------|
| `traces.hasTracingConfigured` | 同 1.1 |
| `events.all` | 获取 observations/events 列表 |
| `events.countAll` | 获取 observations 总数 |
| `events.batchIO` | 批量获取 input/output |
| `events.filterOptions` | 获取筛选器选项 |
| `scores.getScoreColumns` | 同 1.7 |
| `projects.environmentFilterOptions` | 同 1.8 |

> Beta 模式的 events 接口暂不在本文档范围内。

**Mutations（用户操作触发）：**

| 接口 | 说明 |
|------|------|
| `traces.deleteMany` | 批量删除 traces |
| `annotationQueueItems.createMany` | 批量添加到标注队列 |

---

## 3. Sessions

页面路径：`/project/[projectId]/sessions`

### v3（传统模式）

| 接口 | 说明 | 数据源 |
|------|------|--------|
| `sessions.hasAny` | 检查项目是否有 session 数据 | PostgreSQL |
| `sessions.all` | 获取 sessions 列表（分页） | Doris/ClickHouse |
| `sessions.countAll` | 获取 sessions 总数 | Doris/ClickHouse |
| `sessions.metrics` | 获取 sessions 指标（trace count、duration、cost 等） | Doris/ClickHouse |
| `sessions.filterOptions` | 获取筛选器选项 | Doris/ClickHouse |
| `scores.getScoreColumns` | 获取 score 列定义 | Doris/ClickHouse |
| `projects.environmentFilterOptions` | 获取项目的 environment 列表 | Doris/ClickHouse |
| `TableViewPresets.getDefault` | 获取默认表格视图配置 | PostgreSQL |
| `TableViewPresets.getById` | 获取已保存的表格视图配置 | PostgreSQL |

### v4（Events 模式，Beta 功能开启时）

| 接口 | 说明 | 数据源 |
|------|------|--------|
| `sessions.hasAnyFromEvents` | 检查是否有 event-based session 数据 | Doris/ClickHouse |
| `sessions.allFromEvents` | 获取 sessions 列表 | Doris/ClickHouse |
| `sessions.countAllFromEvents` | 获取 sessions 总数 | Doris/ClickHouse |
| `sessions.metricsFromEvents` | 获取 sessions 指标 | Doris/ClickHouse |
| `sessions.filterOptionsFromEvents` | 获取筛选器选项 | Doris/ClickHouse |

**Mutations（用户操作触发）：**

| 接口 | 说明 |
|------|------|
| `annotationQueueItems.createMany` | 批量添加到标注队列 |

---

## 接口汇总（按 Router 分组）

| Router | 接口 | 总数 |
|--------|------|------|
| **traces** | hasTracingConfigured, all, countAll, metrics, filterOptions, byId, deleteMany | 7 |
| **generations** | all, countAll, filterOptions | 3 |
| **observations** | byId | 1 |
| **sessions** | hasAny, hasAnyFromEvents, all, allFromEvents, countAll, countAllFromEvents, metrics, metricsFromEvents, filterOptions, filterOptionsFromEvents | 10 |
| **events** | all, countAll, batchIO, filterOptions | 4 |
| **scores** | getScoreColumns | 1 |
| **projects** | environmentFilterOptions | 1 |
| **TableViewPresets** | getDefault, getById | 2 |
| **annotationQueueItems** | createMany | 1 |

**合计：30 个接口**

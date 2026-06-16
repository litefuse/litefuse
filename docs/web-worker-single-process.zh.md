# Web 和 Worker 单进程合并说明

## 概览

这次改动把原来独立运行的 `worker` 进程合并进 `web` 进程。合并后，
Langfuse 使用一个可部署运行时同时处理用户 HTTP 流量和后台任务。

改动前，Langfuse 有两个应用进程：

```text
web
- Next.js UI
- tRPC 和 public REST API
- public health / readiness endpoint

worker
- 队列消费者
- 定时任务
- cleaners
- background migrations
- worker 启动时的数据同步脚本
- worker 自己的 Express health / readiness endpoint
```

改动后，后台处理从 `web` 进程内启动：

```text
web
- Next.js UI
- tRPC 和 public REST API
- public health / readiness endpoint
- 队列消费者
- 定时任务
- cleaners
- background migrations
- 启动时数据同步脚本
```

原来的独立 worker service、Docker image、Express shell 和 `3030` 端口已经
移除。队列契约和 pg-boss helper 仍然由 `@langfuse/shared` 维护。

## 改了什么

### 后台运行时入口

新增了统一的后台启动模块：

```text
web/src/server/background/bootstrap.ts
```

它暴露两个方法：

```ts
startBackgroundProcessing();
stopBackgroundProcessing();
```

`startBackgroundProcessing()` 负责注册队列消费者、定时任务、cleaners、
background migrations，以及 worker 原来启动时执行的数据同步脚本。

`stopBackgroundProcessing()` 负责停止 cleaners、清理 worker 注册状态、停止
pg-boss、abort 正在运行的 background migration，并释放 tokenizer 资源。

### 启动时机

后台处理现在从这里启动：

```text
web/src/instrumentation.ts
```

启动条件是：

```ts
process.env.NEXT_RUNTIME === "nodejs"
```

这样可以避免在不支持后台任务的 runtime 中启动消费者。bootstrap 内部也有
process-global singleton guard，避免 Next.js dev reload 时在同一个进程里重复
注册队列消费者。

### Shutdown

shutdown 逻辑仍然在：

```text
web/src/utils/shutdown.ts
```

收到 `SIGTERM` 或 `SIGINT` 后，web 进程现在会：

1. 立即把 readiness 标记为失败。
2. 停止 background processing。
3. 保留原来的 web request drain window。
4. 最后关闭 Doris、Redis、Prisma 等 shared resources。

这意味着负载均衡会尽快停止给该实例发送新请求，同时 shared resources 不会在
已有请求 drain 之前被关闭。

### 环境变量

worker 相关的队列开关和运行时配置移动到了：

```text
web/src/env.mjs
```

原来的队列开关继续保留，例如：

```env
QUEUE_CONSUMER_TRACE_UPSERT_QUEUE_IS_ENABLED
QUEUE_CONSUMER_OBSERVATION_UPSERT_QUEUE_IS_ENABLED
QUEUE_CONSUMER_CREATE_EVAL_QUEUE_IS_ENABLED
QUEUE_CONSUMER_EVAL_EXECUTION_QUEUE_IS_ENABLED
QUEUE_CONSUMER_WEBHOOK_QUEUE_IS_ENABLED
QUEUE_CONSUMER_ENTITY_CHANGE_QUEUE_IS_ENABLED
QUEUE_CONSUMER_NOTIFICATION_QUEUE_IS_ENABLED
```

新增了一个全局后台处理开关：

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

当它设置为 `false` 时，web 进程只处理 HTTP 流量，不启动后台消费者、定时任务、
cleaners、background migrations 或启动同步脚本。

这个开关是生产部署中区分 web-only 副本和 background-enabled 副本的关键。

### Package 和 Workspace

独立 `worker` package 已经从以下位置移除：

```text
pnpm-workspace.yaml
package.json scripts
turbo.json
release-it package bump list
```

原来的 root worker 开发命令也移除了：

```text
pnpm run dev:worker
```

原 worker 的运维脚本现在归 `web` package 管理，例如：

```text
pnpm --filter web run refill-queue-event
```

### Docker 和 Compose

独立 worker image 和 service 已经从以下 compose 文件移除：

```text
docker-compose.yml
docker-compose.build.yml
docker-compose.doris.yml
docker-litefuse-doris/docker-compose.yml
docker-litefuse-doris/docker-compose.dev.yml
```

被移除的运行时接口包括：

```text
langfuse-worker Docker image
worker service
worker port 3030
worker /api/health
worker /api/ready
```

保留的 health 和 readiness 接口是：

```text
/api/public/health
/api/public/ready
```

## 原来的 Worker 负责什么

原来的 worker 不是用户直接访问的 UI/API 进程，而是异步任务和定时任务的后台
运行时。

### 队列消费者

worker 负责消费 pg-boss 队列，例如：

```text
TraceUpsert
ObservationUpsert
CreateEvalQueue
EvaluationExecution
EvaluationExecutionSecondaryQueue
LLMAsJudgeExecution
DatasetRunItemUpsert
BatchActionQueue
CloudUsageMeteringQueue
CloudSpendAlertQueue
CloudFreeTierUsageThresholdQueue
ExperimentCreate
PostHogIntegrationQueue
PostHogIntegrationProcessingQueue
MixpanelIntegrationQueue
MixpanelIntegrationProcessingQueue
BlobStorageIntegrationQueue
DataRetentionQueue
DataRetentionProcessingQueue
DeadLetterRetryQueue
WebhookQueue
EntityChangeQueue
NotificationQueue
TraceDelete
ScoreDelete
DatasetDelete
ProjectDelete
CoreDataS3ExportQueue
MeteringDataPostgresExportQueue
```

这些消费者现在由 `web/src/server/background/bootstrap.ts` 注册。

### 定时任务

worker 原来会注册 pg-boss schedule，用于周期性工作，例如：

```text
cloud usage metering
free-tier usage threshold checks
PostHog integration sync
Mixpanel integration sync
blob storage integration sync
data retention
core data S3 export
metering data Postgres export
dead-letter queue retry
```

schedule definition 仍然在 `@langfuse/shared` 中维护。现在由 web background
runtime 调用 shared pg-boss helper 来确保启用的 schedule 存在。

### Cleaners

worker 原来会启动周期性清理器，例如：

```text
BatchProjectCleaner
BatchDataRetentionCleaner
MediaRetentionCleaner
BatchProjectMediaCleaner
BatchTraceDeletionCleaner
```

这些 cleaner 现在在 web background runtime 中运行。

### Background Migrations

worker 原来会处理 background migrations：从数据库读取未完成 migration，抢锁，
运行 migration 脚本，运行期间 heartbeat，完成后标记 finished，失败后标记
failed。

这个 manager 现在移动到了：

```text
web/src/server/background/backgroundMigrations
```

### 启动时数据同步

worker 启动时原来会同步：

```text
default model prices
managed evaluators
Langfuse dashboards
```

这些同步现在在 web background startup 阶段执行。

### Worker HTTP Shell

原 worker 还有一个 Express HTTP shell，只用于 worker 自己的 health 和 readiness。
这个 shell 已经删除。后台处理不再暴露独立 HTTP service。

## 哪些基本没变

这次迁移主要是运行时和代码归属的调整，不是后台业务逻辑重写。

基本没变的部分：

```text
queue payload schemas
queue names
pg-boss queue contracts
processor behavior
cleaner behavior
background migration behavior
webhook/eval/delete/integration job business logic
```

发生实质变化的部分：

```text
process boundary
startup entry point
shutdown path
health/readiness ownership
Docker and compose topology
workspace/package ownership
environment validation location
```

简单说：大部分 job 处理逻辑是移动，运行模型发生了变化。

## 新的运行模型

默认情况下，每个 web 进程都会启动后台处理：

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

这意味着扩容 web 副本时，如果没有额外配置，也可能同时扩容后台消费者。

如果某些副本只应该处理 HTTP 流量，需要设置：

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false
```

## 推荐生产拓扑

虽然现在只有一个可部署应用运行时，但生产环境仍然建议通过环境变量区分角色。

推荐拓扑：

```text
langfuse-web deployment
- 使用 web image
- 接收用户 HTTP 流量
- LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false

langfuse-background deployment
- 使用同一个 web image
- 不接外部用户流量
- LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
- 负责队列消费者、定时任务、cleaners 和 migrations
```

这样可以保持部署 artifact 简单，同时保留用户请求和后台任务之间的运维隔离。

对于小型 self-hosted 部署，一个 `langfuse-web` service 同时启用后台处理也可以，
部署和理解成本最低。

## 优势

### 部署更简单

少了一个 service，需要定义、运行、监控和升级的组件更少。self-hosted compose
不再需要单独的 `langfuse-worker` service，也不再需要 worker 的 `3030` 端口。

### 配置不一致的风险降低

以前 web 和 worker 都需要配置数据库、Redis、Doris、S3、Stripe、queue flags 等。
如果 worker 漏配，可能出现 UI/API 看起来正常，但后台任务不工作的情况。

合并后，web runtime 统一拥有 HTTP 和后台任务配置。

### 版本一致性更好

web API 和后台消费者来自同一个 image 和同一份代码版本。这样可以降低 web 生产
了新 queue payload，但旧 worker image 无法消费的风险。

### 本地开发更方便

本地开发时，一个 `web` 进程理论上可以覆盖 UI、API 和后台消费者。不再需要记得
同时启动独立 worker。

### 运维表面积更小

原 worker 的 Express app、middleware、health endpoints、Dockerfile、entrypoint
和 package scripts 都删除了，需要维护的进程专属代码更少。

## 劣势和风险

### 资源竞争更明显

当后台处理和用户 HTTP 请求在同一个进程中运行时，它们会共享进程资源。

可能竞争的资源包括：

```text
CPU
memory
event loop latency
database connections
Doris connections
Redis connections
S3 bandwidth
Stripe/API rate limits
```

如果高负载后台任务跑在同一批服务用户请求的副本上，可能影响 API latency。

### 故障域变大

以前 worker-only 故障不一定影响 web 请求。合并后，如果 background-enabled web
进程中的后台运行时出现严重问题，可能影响整个 web 进程。

通过 `LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false` 运行 web-only 副本，可以降低
用户流量受到影响的概率。

### 扩容语义变化

以前：

```text
scale web    -> 增加 HTTP 处理能力
scale worker -> 增加后台处理能力
```

现在：

```text
scale web with background enabled -> 同时增加 HTTP 和后台处理能力
scale web with background disabled -> 只增加 HTTP 处理能力
```

所以部署必须明确哪些副本应该跑后台任务。

### 发布和重启影响后台任务

如果某个 web 副本启用了 background processing，那么 web 重启也会重启该副本上的
后台处理。

可能影响包括：

```text
webhook delivery delay
eval execution delay
batch export interruption and retry
cleaner interruption
background migration abort and later retry
integration sync delay
```

pg-boss job 通常可以通过队列语义、锁、retry 和重新处理恢复。但长任务和 migration
仍然需要保证幂等性和可重试性。

### Shutdown 需要更谨慎

shutdown 现在需要在同一个进程中同时协调用户请求 drain 和后台 worker stop。
readiness 应该立即失败，让负载均衡停止发送新用户流量；同时后台任务也应该避免
在不明确状态下中断。

当前实现会在 web shutdown 时停止 background processing。生产上可以考虑增加可
配置的 background drain timeout，在强制停止活跃 job 前给它们一段 graceful
drain 时间。

## 运维建议

### 小型部署

使用一个 web service：

```env
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

这是最简单的部署形态。

### 较大部署

使用同一个 image 运行两个 deployment：

```text
web-only replicas:
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=false

background-enabled replicas:
LITEFUSE_BACKGROUND_PROCESSING_ENABLED=true
```

只把外部用户流量路由到 web-only deployment。background-enabled replicas 保持
内部使用。

### Queue Concurrency

增加 background-enabled 副本数量前，需要重新检查 queue concurrency 设置。更多
副本可能提升总后台吞吐，也可能增加共享资源压力。

重点关注：

```text
eval execution concurrency
trace/observation upsert concurrency
webhook concurrency
entity change concurrency
delete queue concurrency
project deletion concurrency
integration processing rate limits
```

### Migrations

background migrations 通常应该只在少量 background-enabled 副本上运行。如果
migration 资源消耗大或操作敏感，不建议所有 web 副本都启用 background
processing。

### Health 和 Readiness

不要再使用已删除的 worker endpoint：

```text
/api/health
/api/ready
port 3030
```

使用 web endpoint：

```text
/api/public/health
/api/public/ready
```

### Rollout

生产发布建议：

1. 先发布 web-only replicas。
2. 确认 public health 和 readiness。
3. 再发布 background-enabled replicas。
4. 观察 queue depth、failed jobs、数据库负载、Doris 负载、webhook/eval latency。

这样可以避免把用户流量发布成功与后台队列追平强耦合在一起。

## 兼容性说明

移除的公开或运行时接口：

```text
langfuse-worker image
worker service
worker package
worker Dockerfile
worker entrypoint
worker port 3030
worker health endpoint
worker readiness endpoint
pnpm run dev:worker
```

保留的接口：

```text
queue names
queue payload schemas
QUEUE_CONSUMER_* flags
worker concurrency env names
web /api/public/health
web /api/public/ready
```

新增的接口：

```text
LITEFUSE_BACKGROUND_PROCESSING_ENABLED
```

## 已执行验证

这次迁移执行过以下验证：

```text
pnpm --filter @langfuse/shared run build
pnpm --filter web exec eslint src/server/background --max-warnings 0 --no-cache
pnpm --filter web run typecheck
pnpm run build:check
docker compose -f docker-compose.yml config
docker compose -f docker-compose.build.yml config
docker compose -f docker-compose.doris.yml config
docker compose -f docker-litefuse-doris/docker-compose.yml config
docker compose -f docker-litefuse-doris/docker-compose.dev.yml config
```

完整的 web lint 需要后续单独清理，因为当前更大的 `web/src` 树里存在与本次后台
迁移无关的既有 warnings。

## 后续建议

建议后续继续处理：

1. 把原 worker 中最重要的 Vitest 覆盖迁移或重建到 web package。
2. 增加类似 `test:background` 的 web script，用于运行迁移后的后台测试。
3. 增加 web 进程内消费 pg-boss job 的 runtime smoke test。
4. 在部署文档中明确推荐生产拓扑。
5. 考虑增加可配置的 background shutdown drain timeout。
6. 对多 background-enabled web 副本场景重新审查 queue concurrency 默认值。
7. 补充 queue depth、failed jobs、retry counts、background latency 的监控建议。


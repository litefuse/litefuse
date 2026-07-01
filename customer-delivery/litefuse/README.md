# Litefuse 单机部署包

本目录是完整交付包，包含运行 Litefuse 所需的 Compose 文件、Doris 配置、环境变量示例和一键启动脚本。

## 一行命令启动

进入本目录后执行：

```bash
bash start.sh
```

如果从上一级目录执行：

```bash
cd litefuse && bash start.sh
```

启动完成后访问：

```text
http://localhost:3000
```

健康检查：

```bash
curl http://localhost:3000/api/public/health
```

正常返回示例：

```json
{"status":"OK","version":"3.159.0"}
```

## 目录内容

| 文件                          | 说明                                      |
| ----------------------------- | ----------------------------------------- |
| `start.sh`                    | 一键启动脚本。首次运行会自动生成 `.env`。 |
| `stop.sh`                     | 停止并移除容器和网络，保留数据卷。        |
| `.env.example`                | 环境变量模板。                            |
| `docker-compose.yml`          | 单机 Docker Compose 部署定义。            |
| `doris-config/fe_custom.conf` | Doris FE 自定义配置。                     |

## 前置要求

- Docker Engine / Docker Desktop / OrbStack
- Docker Compose v2
- 可用端口：`3000`, `3030`, `5432`, `16379`, `19090`, `19091`, `8030`, `9030`, `9010`, `8040`, `8060`, `9050`, `9060`

Apple Silicon 机器可能出现 `linux/amd64` 镜像平台提示，这是 Docker 的平台提示，不代表启动失败。

## 服务组件

| 服务 | 容器名 | 作用 | 对外端口 |
| --- | --- | --- | --- |
| `litefuse-web` | `litefuse-web` | Web/API 服务 | `3000` |
| `litefuse-worker` | `litefuse-worker` | 后台任务和队列消费者 | `3030` |
| `postgres` | `litefuse-postgres` | 元数据数据库 | `127.0.0.1:5432` |
| `redis` | `litefuse-redis` | 队列和缓存 | `127.0.0.1:16379` |
| `minio` | `litefuse-minio` | S3 兼容对象存储 | `19090`, `127.0.0.1:19091` |
| `doris` | `litefuse-doris` | 分析数据存储 | `8030`, `9030`, `9010`, `8040`, `8060`, `9050`, `9060` |

默认 Docker 网络：

- `litefuse_default`: `10.200.0.0/24`
- `litefuse_doris_internal`: `172.30.0.0/24`

## 环境变量

首次执行 `bash start.sh` 时，如果 `.env` 不存在，脚本会自动生成：

- `NEXTAUTH_SECRET`
- `SALT`
- `ENCRYPTION_KEY`
- `POSTGRES_PASSWORD`
- `REDIS_AUTH`
- `MINIO_ROOT_PASSWORD`

如果要手动配置，先复制模板：

```bash
cp .env.example .env
```

然后编辑 `.env`，再执行：

```bash
bash start.sh
```

## 常用命令

查看状态：

```bash
docker compose --env-file .env -f docker-compose.yml ps
```

查看日志：

```bash
docker compose --env-file .env -f docker-compose.yml logs -f
```

停止服务并保留数据：

```bash
bash stop.sh
```

重新启动：

```bash
bash start.sh
```

删除容器、网络和所有数据卷：

```bash
docker compose --env-file .env -f docker-compose.yml down -v
```

`down -v` 会删除 Postgres、MinIO 和 Doris 的持久化数据，仅在确认不需要旧数据时使用。

## 升级

拉取最新镜像：

```bash
docker compose --env-file .env -f docker-compose.yml pull
```

重新启动：

```bash
bash start.sh
```

## 备份

备份 Postgres 元数据：

```bash
docker exec litefuse-postgres pg_dump -U postgres postgres > litefuse-postgres.sql
```

以下 Docker volumes 保存持久化数据：

- `litefuse_postgres_data`
- `litefuse_minio_data`
- `litefuse_doris_fe_meta`
- `litefuse_doris_be_storage`

## 常见问题

### 网络网段冲突

错误示例：

```text
invalid pool request: Pool overlaps with other one on this address space
```

原因是本机已有 Docker 网络占用了 `10.200.0.0/24` 或 `172.30.0.0/24`。

查看网络：

```bash
docker network ls
docker network inspect <network-name> --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

如果旧网络可以删除：

```bash
docker network rm <network-name>
```

如果旧网络需要保留，请修改 `docker-compose.yml` 里的 `networks.*.ipam.config.subnet` 和 `gateway`。

### 容器名冲突

错误示例：

```text
Conflict. The container name "/litefuse-doris" is already in use
```

查看占用容器：

```bash
docker ps -a --filter name='^/litefuse-doris$'
```

如果确认旧容器不需要：

```bash
docker rm -f litefuse-doris
```

### Doris 启动慢或不健康

Doris 首次启动需要一段时间。查看日志：

```bash
docker logs --tail 200 litefuse-doris
```

如果看到代理相关报错，当前 Compose 已对 Doris 清空 `http_proxy`、`https_proxy` 等代理环境变量。请确认宿主机或 Docker 运行环境没有额外覆盖这些变量。

### Web 或 Worker 重启

查看日志：

```bash
docker logs --tail 200 litefuse-web
docker logs --tail 200 litefuse-worker
```

当前 Compose 已补齐底层镜像需要的 ClickHouse 兼容环境变量，并禁用了 ClickHouse migration。修改 `.env` 后请重建 Web 和 Worker：

```bash
docker compose --env-file .env -f docker-compose.yml up -d --force-recreate litefuse-web litefuse-worker
```

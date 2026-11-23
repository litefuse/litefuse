# Litefuse 部署指南（Docker Compose 外部依赖版）

本方案在一台主机上运行 `litefuse-web` 和 `litefuse-worker`，连接已有的 PostgreSQL、Redis、S3 兼容对象存储和 Apache Doris。Web 通过宿主机的 `3000` 端口提供页面和 API，Worker 在容器内部处理队列。使用已有域名和 HTTPS 入口时，将入口流量转发到部署主机的 `3000` 端口。

## 1. 准备外部服务

部署主机需要可用的 Docker Engine 和 Docker Compose 插件。以下地址均须从 Web 和 Worker **容器内**可达。配置外部服务时，请填写实际域名或 IP；容器内的 `localhost` 指向容器自身。

| 服务 | 部署前准备 |
| --- | --- |
| PostgreSQL | 创建 Litefuse 专用数据库和账号，授予目标 schema 的建表、变更结构和读写权限。若业务流量经过连接池，另准备可用于迁移的直连地址。 |
| Redis | 准备主机、端口和认证信息，将 `maxmemory-policy` 设为 `noeviction`，避免队列任务因内存淘汰而丢失。 |
| S3 或 MinIO | 预先创建私有桶，给应用账号授予列举桶及读取、写入、删除桶内对象的权限。此配置在同一桶中使用 `events/`、`media/` 和 `exports/` 前缀。 |
| Apache Doris | 准备 FE 的 HTTP 地址（通常为 `8030`）和同一主机的 MySQL 查询端口（通常为 `9030`）。确保容器可访问 FE 重定向到的 BE HTTP 地址（通常为 `8040`）。账号须能执行目标库的迁移、建表和读写。 |

## 2. 准备部署目录和 `.env`

将同一版本的 [docker-compose.external.yml](../docker-compose.external.yml) 和 [.env.external.example](../.env.external.example) 放入部署主机上的同一目录。以下命令均在该目录执行。

```bash
docker compose version
cp -i .env.external.example .env
chmod 600 .env
```

编辑 **`.env`**。Compose 会自动读取当前目录中的这个文件。首次部署时，分别运行三次 `openssl rand -hex 32`，将三个独立结果依次填入 `NEXTAUTH_SECRET`、`SALT` 和 `ENCRYPTION_KEY`。妥善备份 `.env`，升级或迁移已有实例时沿用原有密钥，以便继续验证已有 API Key 和解密已存凭据。

| 配置项 | 填写方式 |
| --- | --- |
| `NEXTAUTH_URL` | 填用户实际访问的完整地址，如 `https://litefuse.example.com`。直接通过 IP 访问时，填 `http://<部署主机IP>:3000`。 |
| `DATABASE_URL`、`DIRECT_URL` | 示例为 `postgresql://litefuse:PASSWORD@pg.example.com:5432/litefuse`。用户名和密码中的特殊字符需做 URL 编码。按服务商要求附加连接参数。使用连接池时将 `DIRECT_URL` 填为直连地址，否则默认沿用 `DATABASE_URL`。 |
| `REDIS_HOST`、`REDIS_PORT`、`REDIS_USERNAME`、`REDIS_AUTH`、`REDIS_TLS_ENABLED` | 主机名与端口分开填写。默认端口为 `6379`，默认用户名为 `default`。启用 TLS 的服务填 `REDIS_TLS_ENABLED=true`，端口按实例设置填写。 |
| `DORIS_FE_HTTP_URL`、`DORIS_FE_QUERY_PORT` | 例如 `http://doris-fe.example.com:8030` 和 `9030`。前者用于 HTTP 写入，迁移程序还会从该 URL 提取主机名并连接查询端口。 |
| `DORIS_DB`、`DORIS_USER`、`DORIS_PASSWORD`、`DORIS_REPLICATION_NUM` | 指定库名和账号。单 BE 部署将副本数设为 `1`；支持三副本的集群可沿用默认值 `3`。 |
| `S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` | 填已有桶名、区域和应用访问密钥。 |
| `S3_ENDPOINT`、`S3_FORCE_PATH_STYLE` | 填服务地址，例如 `https://s3.us-east-1.amazonaws.com`，桶名单独填写。使用按路径访问桶的 MinIO 时设为 `true`，AWS S3 默认使用 `false`。 |
| `S3_PUBLIC_ENDPOINT` | 可选，默认沿用 `S3_ENDPOINT`。若内部地址仅容器可达，填写浏览器和容器都能访问的对象存储地址，用于媒体签名链接和导出下载。桶可保持私有。 |
| `LITEFUSE_VERSION`、`LITEFUSE_S3_BATCH_EXPORT_ENABLED` | 可选。前者同时指定 Web 和 Worker 的镜像标签，当前 Compose 默认 `26.3.0`；后者默认 `false`，需要批量导出时设为 `true`。 |

## 3. 校验配置并启动

```bash
docker compose -f docker-compose.external.yml config --quiet
docker compose -f docker-compose.external.yml config --services
docker compose -f docker-compose.external.yml pull
docker compose -f docker-compose.external.yml up -d
docker compose -f docker-compose.external.yml ps -a
```

第一条命令成功时无输出，第二条应仅列出 `litefuse-web` 和 `litefuse-worker`。首次启动时 Web 先执行 PostgreSQL 和 Doris 迁移。等待 Web 显示 `healthy`，随后 Worker 应显示 `Up`。

## 4. 验收

```bash
# 在部署主机上检查 Web 和 PostgreSQL
curl -fsS 'http://127.0.0.1:3000/api/public/health?failIfDatabaseUnavailable=true'

# 从 Worker 容器内检查 Worker、PostgreSQL 和 Redis
docker compose -f docker-compose.external.yml exec -T litefuse-worker \
  wget -qO- http://127.0.0.1:3030/api/health
```

Web 应返回含 `"status":"OK"` 的 JSON，Worker 应返回 `{"status":"ok"}`。再用浏览器打开 `NEXTAUTH_URL`，登录并创建测试项目。将测试应用的 SDK 指向该地址，使用项目密钥发送一条有唯一名称的 trace，在项目的 Traces 页面按名称找到它，确认对象存储、队列和 Doris 的写入与查询链路已打通。

## 5. 常见问题

| 现象 | 检查项 |
| --- | --- |
| 校验提示必填变量为空 | 确认当前目录同时有 `.env` 和 `docker-compose.external.yml`，并已在 `.env` 中填入报错点名的变量。 |
| Web 反复重启，Worker 一直等待 | 使用 `docker compose -f docker-compose.external.yml logs --tail=100 litefuse-web` 查看首次失败的迁移。检查 PostgreSQL 直连地址、目标 schema 权限、Doris 查询端口和副本数。对外分享日志前请遮盖凭据，Doris 迁移脚本可能输出密码。 |
| Worker 健康检查失败 | 查看 Worker 日志，检查 PostgreSQL 连接、Redis ACL 用户、密码、TLS 设置和端口。 |
| API 已接收数据，界面找不到 trace | 在 Worker 日志中查找 S3 访问错误或 Doris Stream Load 错误，核对桶权限、存储区域以及容器到 BE 地址的网络连通性。 |
| 浏览器打不开媒体或导出链接 | 从浏览器所在网络检查 `S3_PUBLIC_ENDPOINT` 的 DNS 和证书。若通过代理访问对象存储，须保留签名时使用的 Host、路径和查询串。 |

修改 `.env` 后重新执行 `docker compose -f docker-compose.external.yml up -d`，让 Compose 将新配置应用到容器。

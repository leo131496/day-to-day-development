# 免费、免绑卡发布项目工作台

默认方案：**GitHub Pages 访问入口 + Northflank Sandbox 应用 + Turso Free 数据库**。本机继续使用 SQLite。

**当前业务网站尚未完成发布。** GitHub 入口可访问、云数据库已完成迁移，不代表公网登录和填写功能已上线。原 Render Blueprint 流程在当前账号弹出银行卡验证，已暂停，不填写银行卡或确认预授权。

2026-10-28 核对的 Northflank [官方定价页](https://northflank.com/pricing)标注 Sandbox 为 **Free / No card needed**，包含有限数量的服务和免费资源。新的应用托管仍需账号授权、实际构建和联调；不能把官方免费说明当作本项目已上线的证据。

## 1. 本机环境继续可用

本机仍执行：

```bash
python3 -B server.py --port 8765
```

访问 <http://127.0.0.1:8765>，Mac 也可双击 `开始使用.command`。默认数据为 `data/project.sqlite3`，沿用原账号、密码和填写记录。默认 `Dockerfile` / Compose 仍使用持久 SQLite 卷；不要删除原库或卷。

云部署单独使用 `Dockerfile.cloud`，固定 `BOARD_DATABASE_MODE=turso`。私密云连接文件不会被本机启动器自动读取，也不会进入 GitHub 或镜像。自动测试使用独立临时数据库，浏览器测试会移除云连接配置。

本机 SQLite 与云端 Turso 是不同的数据副本，迁移后不会自动双向同步。正式切换入口前再次核对迁移后的本机填写变化，不能用旧备份覆盖任一端的新记录。

## 2. 免费云端配置

- Northflank 免费账号：<https://app.northflank.com/signup>
- 官方套餐说明：<https://northflank.com/pricing>
- 官方部署说明：<https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code>
- Turso Free 套餐：<https://turso.tech/pricing>

登录 Northflank，选择 **Sandbox 免费套餐**，运行位置使用 **Northflank Cloud**。免费计划中的 BYOC 指连接自有云，其云资源可能另行计费，不用于本方案。若实际账号要求绑卡或升级，暂停创建，不输入支付资料。

创建项目（例如 `project-plan`），在项目中创建可同时构建和部署的 **Combined service**：

| 设置 | 内容 |
| --- | --- |
| GitHub 仓库 | `leo131496/day-to-day-development` |
| 分支 | `main` |
| 构建方式 | Dockerfile |
| Dockerfile path | `Dockerfile.cloud` |
| Build context | 仓库根目录 |
| 资源和实例 | Sandbox 包含的免费规格，1 个实例 |
| 公开端口 | `8765`，HTTP，Public |
| 健康检查 | HTTP `GET /api/health`，成功状态 200 |

默认 `Dockerfile` 是本机持久 SQLite 版本，云应用须使用 `Dockerfile.cloud`。云镜像先安装哈希校验的官方驱动，并运行隔离测试，通过后才生成运行镜像；运行镜像不包含测试、Git、密码、数据库或私密备份。

将本机私密的 `data/northflank-environment.env` 中三项填到 **运行时**环境变量 / Secrets，而非构建参数：

| 变量 | 内容 |
| --- | --- |
| `TURSO_DATABASE_URL` | 已迁移的 Turso 数据库完整 URL |
| `TURSO_AUTH_TOKEN` | 同一个数据库的读写令牌 |
| `BOARD_PASSWORD` | 至少 12 位的初始化密码；迁移后不会覆盖原密码 |

镜像已设置 `PORT=8765`、`BOARD_HOST=0.0.0.0`、`BOARD_DATABASE_MODE=turso`、`BOARD_COOKIE_SECURE=1` 和临时备份缓存目录，无需购买或挂载持久磁盘。公开访问使用平台生成的 HTTPS 域名。

HTTPS 默认按 Secure Cookie 设置和当前 Host 校验来源。使用固定域名时可设置 `BOARD_ORIGIN=https://实际域名`，不带末尾斜线。未配置 Turso、令牌失效或达到免费配额时，应用会报错，不降级到本机存储。

## 3. 迁移与数据保护

**已迁移的数据库不重复初始化或导入。** 本项目原项目、50 条工作项、50 条历史及账号已迁移至 Turso，并核对完整内容。本机原数据和私密备份均保留。登录沿用当前账号密码；初始密码文件可能已经过期。

对于尚未迁移的新安装，先生成一致备份，再向空数据库迁移（Python 3.10+）：

```bash
python3 -B scripts/prepare_migration.py --output data/migration/project-cloud.sqlite3
python -m pip install --require-hashes -r requirements-cloud.txt
python -B scripts/migrate_turso.py --source data/migration/project-cloud.sqlite3
```

运行迁移前通过私密环境变量配置 Turso URL 和读写令牌。迁移仅接受空数据库，整个事务核对数量和关联；目标已有数据时停止，不覆盖。迁移必须在新云库首次启动应用前完成。本机源文件不变。

已使用真实 Turso 验证事务迁移、数据完整性、全新缓存读取及云快照恢复；Northflank 托管环境仍待联调。私密备份包含业务内容和密码哈希，不上传到公开 GitHub、Pages、Releases 或分享链接。

应用启动、每小时、导入前及正常停止会做完整备份，最近 8 份压缩快照保存在 Turso 内并校验、去重；临时磁盘仅用于下载缓存。管理员定期从 **账号设置 → 下载完整备份** 另存私人电脑或独立存储。

同库快照不能抵御整个云数据库或账号被删除。全库恢复使用新的空数据库，保留旧库和备份供回退。免费平台均有资源和配额限制，不升级、不启用付费超额，也不承诺永久免费或数据绝不丢失。

不同账号当前拥有独立项目空间。上线后同事和客户可注册自己的账号；共同编辑同一项目仍需要增加邀请及成员权限，不应共享管理员密码。

## 4. 验证并接通入口

先检查实际构建、启动日志和公开健康接口，再验证登录、项目工作清单、保存、导入及重启持久性。只有这些检查通过才视为业务系统发布成功，不把 GitHub 推送成功当作应用上线。

拿到平台提供的真实 HTTPS 地址（通常为 `code.run` 子域名）后执行：

```bash
python3 -B scripts/configure_public_url.py https://实际云端域名
git add docs/config.json
git commit -m "Connect verified hosted workspace"
git push origin main
```

脚本在健康接口返回 `{"ok":true}` 后才更新入口。Pages 来源为 `main / docs`，入口仅保存公开应用网址。未验证的地址不要填写。

`render.yaml` 仅作为其他使用者的可选 Render 配置保留；当前账号要求绑卡，免绑卡发布不继续走此路径。

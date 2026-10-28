# 免费发布项目工作台

当前默认方案：**GitHub Pages 免费访问入口 + Render Free 应用服务 + Turso Free 云数据库**。不创建付费实例、付费磁盘或付费数据库。

- 公开入口：<https://leo131496.github.io/day-to-day-development/>
- 免费数据库：<https://turso.tech/>
- 免费应用发布：<https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fleo131496%2Fday-to-day-development>
- 官方套餐与配额：<https://turso.tech/pricing>、<https://render.com/docs/free>

入口显示“待发布”时，完整业务系统尚未上线。云平台账号需要由使用者注册、登录并授权；不需要把数据库公开或上传 GitHub。

## 1. 创建免费数据库

在 Turso 注册 / 登录，选择 **Free（$0）**，创建独立的项目数据库。在数据库设置中取得数据库 URL（形如 `turso://数据库名-组织名.turso.io`）和具有读写权限的 Auth Token。

Turso 官方页面当前显示 Free 无需信用卡，包含 5GB 存储、每月 5 亿行读取及 1000 万行写入。配额包含业务数据、索引和备份，以平台控制台最新规则为准。达到免费配额可能停止服务，不开通付费套餐或付费超额使用。

应用使用官方 `turso-serverless` 驱动直接提交云数据库事务；不通过临时 SQLite 文件或稍后同步来保存业务数据。连接失败、令牌失效或配额不足时明确报错，不切换本机存储。驱动版本和哈希固定在 `requirements-cloud.txt`；云端需要 Python 3.10+，本机 SQLite 版本继续支持原 Python 环境。

接入代码已用官方驱动连接本机 SQL-over-HTTP 模拟服务验证事务、重启持久性及备份恢复；真实 Turso 数据库仍需在账号授权后联调，不能把模拟测试当作真实服务已上线。

## 2. 先迁移本机记录，再发布应用

若沿用本机项目、账号、密码和历史，先将完整备份迁移到**空的 Turso 数据库**，不要先启动应用填入新数据后再覆盖。

本机生成一致的私密备份，可在本机服务运行时执行：

```bash
python3 -B scripts/prepare_migration.py --output data/migration/project-cloud.sqlite3
```

已经准备的迁移文件可以直接使用；不覆盖旧备份。文件包含私密业务数据、密码哈希及恢复码哈希，禁止上传公开 GitHub、Pages、Releases 或公开分享链接。

在本机 Python 3.10+ 环境安装云驱动，并在私密环境变量中配置 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`。令牌不要放进公开 issue、提交或部署日志。执行：

```bash
python -m pip install --require-hashes -r requirements-cloud.txt
python -B scripts/migrate_turso.py --source data/migration/project-cloud.sqlite3
```

迁移仅接受空数据库，目标已有表时整批停止。迁移在一个事务内创建结构、复制记录、核对数量和关联；保留账号、工作项、历史、日历和导入预览，清除会话及限流记录。本机原库不变。若中断后无法确认提交，先检查云端状态，不盲目重复。

若不需要本机填写，可直接使用空数据库发布：应用初始化原始计划和新管理员。**初始化种子不等于迁移现有填写内容。**

## 3. 发布免费应用

打开 Render 发布链接，登录并授权当前仓库，核对 `render.yaml`：

- 实例为 `plan: free`，单实例，不添加磁盘。
- `BOARD_DATABASE_MODE=turso`，直接使用云数据库。
- `BOARD_DATA_DIR=/tmp/project-space-cache` 只放下载备份缓存，不放业务数据库。
- 将 Turso URL 和读写 Token 填入 Render 环境变量。
- 设置至少 12 个字符的 `BOARD_PASSWORD`，仅在空库首次创建管理员时使用。迁移后沿用原账号密码，不被该变量重置。

若平台要求升级或购买磁盘，先停止，不确认付费。正常免费配置无需购买磁盘，持久数据由 Turso Free 保存。

构建阶段安装校验过的驱动并运行测试；通过后启动服务，检查 `/api/health`。缺少数据库配置时启动失败，避免把业务数据误写到免费服务临时磁盘。

Render 提供 `PORT`、`RENDER_EXTERNAL_URL`，应用校验 HTTPS 来源并使用 Secure Cookie。可直接使用平台提供的 HTTPS 子域名，无需购买域名；自定义域名时再配置 `BOARD_ORIGIN` 与平台域名 / 证书。

## 4. 免费限制与备份

免费应用无人访问时可能休眠，首次打开需要等待唤醒；构建、运行时长、网络和数据库有配额，不提供付费服务的可用性保障。休眠、重新部署不会清除独立云数据库中已提交的记录。删除云数据库、关闭账号、误删或服务商政策变化仍会影响数据，不能承诺绝不丢失。

云数据库中保留最近 **8 份**完整快照，按内容去重并压缩分块保存，覆盖项目、账号、历史、日历和导入记录；不递归包含其他快照。自动备份在启动、每小时、导入前及正常停止触发。备份失败时批量导入停止；已有记录保留，普通保存仍使用事务和逐项历史。

云快照与业务数据位于同一个 Turso 数据库，不能抵御整个数据库或账号被删除。管理员请定期从 **账号设置 → 下载完整备份** 另存私人电脑或独立存储；其他账号无权导出全库。项目原有 JSON / CSV 导出保留。

`cloud_store.restore_archive(store, backup_id, target)` 可校验并下载一个新的 SQLite 文件，不覆盖在线数据。全库恢复应迁移到新的空云数据库，再在维护窗口切换配置，保留原库供回退。

## 5. 连接 GitHub 入口

服务实际显示 Live 后，将真实 HTTPS 网址发回当前对话，核对账号、记录数量、历史、导入及重启持久性。检查完成后：

```bash
python3 -B scripts/configure_public_url.py https://实际云端域名
git add docs/config.json
git commit -m "Connect verified free hosted workspace"
git push origin main
```

脚本先检查数据库健康接口，成功后设置入口。GitHub Pages 来源为 `main / docs`，仓库 About → Website 指向公开入口。入口不包含数据库 Token 或业务内容。

GitHub 推送触发 Render 自动部署；以平台测试、启动和健康检查结果判断更新是否成功，不能把推送成功当成网站已上线。单实例更新或免费服务唤醒可能短暂中断访问。

不同账号目前使用独立项目空间。同事和客户上线后可注册；共同编辑同一个项目需要另外增加成员权限，不应共享管理员密码。

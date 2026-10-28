# 从 GitHub 发布项目工作台

GitHub 仓库保存代码，GitHub Pages 提供可分享的访问入口；Python 服务和 SQLite 数据库使用 Render 常驻实例及持久磁盘。工作台的所有操作仍在同一个云服务来源下进行，不依赖跨站登录 Cookie。

- 仓库：<https://github.com/leo131496/day-to-day-development>
- GitHub 访问入口：<https://leo131496.github.io/day-to-day-development/>
- 云服务发布：<https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fleo131496%2Fday-to-day-development>

**访问入口发布不等于完整应用已上线。** `docs/config.json` 的 `appUrl` 为空时，页面显示“云端工作台待发布”，不会展示无法工作的登录或保存操作。云端地址只能在实际发布后确认，不能预先假定某个 `.onrender.com` 地址已经属于当前账号。

## 一、登录云平台并发布

1. 打开上述 Render 发布链接，用自己的账号登录，并授权读取此 GitHub 仓库。
2. 核对 `render.yaml` 中的配置：Python Web 服务、Singapore 区域、单个 Starter 实例、5GB 持久磁盘、挂载 `/var/data`。此配置需要付费，按平台确认页的最新价格决定是否创建；不在代码中保存付款信息。
3. 为 `BOARD_PASSWORD` 设置至少 12 个字符的管理员初始密码。只在 Render 环境变量中设置，不提交 GitHub。
4. 确认创建。构建阶段运行 Python 自动测试；通过后启动服务并检查 `/api/health`。代码不需要第三方运行库。
5. 等服务显示 Live，复制实际 HTTPS 地址。浏览器打开 `/api/health` 应看到 `{"ok":true}`；再打开根地址检查登录、注册和项目页面。

Render 原生 Python 服务自带运行环境；未固定过时的小版本。`PORT` 和 `RENDER_EXTERNAL_URL` 由平台提供，应用自动使用后者校验 HTTPS 请求来源。自定义域名时，将 `BOARD_ORIGIN` 设置为实际 HTTPS 域名，并在平台完成域名绑定及证书配置。登录 Cookie 使用 Secure，仅通过 HTTPS 传送。

数据库、历史记录、导入预览和应用备份均放在 `/var/data`。不得删除持久磁盘、改用代码目录作为数据库路径，或开多个保存独立 SQLite 文件的实例。服务更新会读取原数据库，初始化计划只写入一次。删除云平台服务或磁盘属于数据删除操作；应用备份也在同一磁盘，仍需定期另存到独立存储。

## 二、迁移现有本机数据

首次空盘部署会创建初始项目和新的管理员；**它不会自动带走本机已有数据**。如果要保留本机账号、项目填写和历史，必须迁移完整数据库，而非只导入代码中的种子计划。

在本机生成一致、可校验的迁移文件（可在本机服务运行时生成）：

```bash
python3 -B scripts/prepare_migration.py --output data/migration/project-cloud.sqlite3
```

目标文件已存在时不会覆盖。迁移副本保留所有业务记录、用户密码哈希、工作日历和导入记录，清除会话及限流记录，让云端设备重新登录；不会修改原数据库。文件权限为仅当前用户可读写，包含私密数据，**不要上传公开仓库、GitHub Releases、Pages 或公开下载链接**。

迁移必须在邀请使用前安排维护窗口：

1. 在云平台暂停应用进程，避免迁移时仍有人写入；保留当前云数据库及全部相关文件的完整备份。本机数据库继续保留，不删除。
2. 经平台支持的私密文件传输 / SSH 通道，将迁移文件上传到持久磁盘的临时目录。实际传输方式和远程连接权限由云平台账号提供；不要用公开分享来中转数据库。
3. 确认应用已经停止后，将迁移文件放到**新的空目录**（例如 `/var/data/migrated`）并命名为 `project.sqlite3`，将 `BOARD_DATA_DIR` 改为该目录，保留旧数据目录供回退。不要在运行时覆盖数据库或丢弃 WAL 文件。
4. 启动服务，使用本机原有账号密码登录。已有账号不会被 `BOARD_PASSWORD` 重置。核对项目、任务数量、具体填写、历史记录、日历及导入记录，再用临时测试项目验证保存 / 重启后保留。
5. 完成迁移和核对后再公布正式工作台。迁移后的新增数据以云端为准，避免同时在本机和云端分别填写。

## 三、连接 GitHub 访问入口

云服务完成数据迁移和验收后，在仓库目录运行：

```bash
python3 -B scripts/configure_public_url.py https://实际云端域名
git add docs/config.json
git commit -m "Connect verified hosted workspace"
git push origin main
```

脚本先检查数据库健康接口，再更新入口地址；检查失败时保留旧配置。发布后同事和客户可从 GitHub 访问入口点击“进入项目工作台”，也可直接使用云端 HTTPS 网址。入口与部署说明不会包含密码、令牌或业务数据。

GitHub 仓库 Settings → Pages 的来源为 **Deploy from a branch / main / docs**；About → Website 指向 GitHub Pages 入口地址。Pages 构建就绪后公开访问；如果修改配置后暂未更新，等待 GitHub Pages 发布结束再刷新。

## 四、日常更新与验收

`render.yaml` 开启代码自动部署。推送后先运行测试，启动成功并通过健康检查后再接受流量；失败时应检查 Render 日志及部署状态，不把 GitHub 推送成功视为服务发布成功。单实例 SQLite 更新可能短暂中断服务，不提供多实例高可用。

至少检查：公开 HTTPS 地址可达；账号登录及注册；创建项目与工作项；导入预览再保存；看板统计；修改密码；版本冲突；服务重启后数据保留；完整备份可用。

当前账号的项目互相隔离。同事和客户可以注册使用各自空间；共享同一个项目仍需独立的团队成员 / 邀请权限功能，不应通过公开数据库或共享管理员密码实现。

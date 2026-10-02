# 🎭 联排提示板 · Rehearsal Callboard

面向剧场团队的 **Web 联排提示板**：舞台监督（舞监）在浏览器里编排提示项并发布只读联排版本；灯光、音响、机械等执行岗位在现场登记实际开始 / 完成 / 预计结束，系统按前置关系自动重算后续时间线，并展示顺延造成的岗位冲突。

技术栈：**Node.js + Express + SQLite（better-sqlite3）+ 原生浏览器前端**，Docker / Docker Compose 一键启动。

---

## 一、快速开始（推荐：Docker Compose）

```bash
# 可选：复制环境变量样例并按需修改
cp .env.example .env

# 构建镜像并后台启动（自动完成依赖安装、建表与数据初始化）
docker compose up -d --build
```

浏览器访问：

> **http://localhost:3000**

查看运行状态 / 停止：

```bash
docker compose ps
docker compose logs -f
docker compose down            # 停止并删除容器（数据卷保留）
docker compose down -v         # 同时删除数据库卷（清空全部数据）
```

## 二、本地直接运行（需 Node.js ≥ 20）

```bash
npm install            # 安装依赖
npm run init-db        # 建表 + 初始数据（幂等，可重复执行）
npm start              # 启动 Web 服务
```

浏览器访问：**http://localhost:3000**

> 服务启动时也会自动执行一次幂等的建表与播种，因此 `npm start` 一条命令同样可用。

## 三、初始账号

首次启动、且数据库为空时自动创建（仅 `SEED_DEMO=true`）：

| 角色 | 账号 | 密码 | 说明 |
| --- | --- | --- | --- |
| 舞台监督 | `sm` | `admin123` | 编排、校验、发布；现场板只读 |
| 灯光执行 | `lighting` | `exec123` | 仅可登记灯光岗位提示项 |
| 音响执行 | `sound` | `exec123` | 仅可登记音响岗位提示项 |
| 机械执行 | `machinery` | `exec123` | 仅可登记机械岗位提示项 |

同时写入一份可直接使用的示范联排版本（C1–C6），执行岗位登录后即可在「现场板」登记。**正式环境请自行改密或在数据库中替换账号。**

## 四、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内监听端口 |
| `HOST_PORT` | `3000` | Compose 映射到宿主机的端口，改它即可换访问端口 |
| `DB_PATH` | `./data/callboard.db`（本地）/ `/data/callboard.db`（容器） | SQLite 数据文件路径；Compose 挂载命名卷持久化 |
| `SESSION_SECRET` | 开发默认值 | 会话 Cookie 签名密钥，生产环境务必修改 |
| `TZ` | `Asia/Shanghai`（容器） | 时区，影响时间显示与浏览器时间输入解析 |
| `SEED_DEMO` | `true` | 空库启动时是否写入演示账号与示范数据 |
| `NODE_ENV` | `development` | 运行环境标识 |

## 五、功能与业务规则

### 5.1 舞监编排（草稿，乐观锁版本号）

- 维护提示项：编号、标题、**岗位**、**计划开始**、**时长**、备注、**前置项**（可多选）。
- 每次新增 / 编辑 / 删除，草稿版本号 `draft.version` 自增；**所有写请求必须携带当前版本号**。
- 版本号过期（别人已改动）时返回 `409 STALE_VERSION`，界面明确提示「版本已过期，请刷新」，拒绝覆盖。

### 5.2 发布校验（失败必须指出冲突项）

只有同时满足下列规则，才能发布只读联排版本，否则返回 `409 PUBLISH_CONFLICT` 并逐项列出：

1. **前置时序**：前置项计划结束 **不晚于** 后项计划开始（首尾相接允许）；
2. **同岗位时段不重叠**：同一岗位的计划时段不得交叉（首尾相接允许）；
3. **依赖无环**：前置关系不允许出现环路，错误信息给出环路上的提示项顺序。

也可先点「校验发布规则」预览全部冲突而不发布。

### 5.3 发布版本（只读、可回看）

- 发布即把当时的提示项、计划时间、前置关系整体快照为不可变版本（v1、v2…）。
- 「版本回看」页可打开任意历史版本，查看其快照与现场登记时间线；**历史版本只读，不能登记**。
- 只有最新版本接受现场登记；舞监发布新版本后，旧页面的提交会因现场版本号过期被拒绝（`STALE_VERSION`）。

### 5.4 现场登记（仅本岗位、版本号校验）

- 执行岗位只能对**自己岗位**的提示项登记：`实际开始`、`完成`、`预计结束`；舞监账号在现场板只读。
- 登记请求携带当前联排版本号；发布新版本后旧提交明确报错。
- 防重复：开始 / 完成各只能登记一次；完成时间不得早于实际开始；预计结束不得早于开始。

### 5.5 自动重算（顺延）

每次现场登记后，系统对最新版本重新计算：

- **已开始 / 已完成项保留实际时间**，不被顺延改动；
- **尚未开始的后项**按前置链路上各前置的「实际结束或预计结束」重算开始时刻；
- 重算开始时刻 **只顺延、绝不早于原计划**（前置提前完成不会让后项提前）；
- 顺延导致的**同岗位时段重叠**在现场板顶部红色横幅逐条展示（涉及岗位、两个提示项编号与重叠时段）；
- 页面每 8 秒自动刷新，也可手动操作后即时刷新。

## 六、目录结构

```
.
├── Dockerfile               # 多环境通用镜像：依赖安装 + 数据初始化 + 启动
├── docker-compose.yml       # 一键启动（端口/卷/健康检查/环境变量）
├── .env.example             # 配置项样例
├── package.json
├── src/
│   ├── config.js            # 环境变量配置
│   ├── db.js                # SQLite 连接与建表
│   ├── initdb.js            # 初始化入口（npm run init-db）
│   ├── seed.js              # 演示账号与示范联排版本
│   ├── errors.js            # 统一 API 错误（含 STALE_VERSION / PUBLISH_CONFLICT）
│   ├── scheduler.js         # 规则引擎：环检测 / 发布校验 / 现场顺延重算
│   ├── repo-draft.js        # 草稿与提示项 CRUD（草稿版本号乐观锁）
│   ├── repo-publication.js  # 发布快照、版本回看、现场登记、岗位权限
│   └── server.js            # Express 路由与静态站点托管
└── public/                  # 浏览器单页界面（原生 HTML/CSS/JS）
    ├── index.html
    ├── styles.css
    └── app.js
```

## 七、主要 HTTP API（均需登录会话）

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/login` / `POST /api/logout` | 全部 | 登录 / 退出 |
| `GET /api/draft` | 全部 | 草稿 + 版本号 + 提示项 + 前置关系 |
| `POST/PUT/DELETE /api/draft/cues[/:id]` | 舞监 | 提示项增改删（必须带 `draft_version`） |
| `POST /api/draft/validate` | 舞监 | 仅校验三类发布规则 |
| `POST /api/draft/publish` | 舞监 | 发布只读版本（校验版本号 + 全部规则） |
| `GET /api/publications` / `/api/publications/:id` | 全部 | 版本列表 / 只读回看详情 |
| `GET /api/live` | 全部 | 最新版本现场板（重算时间线 + 顺延冲突） |
| `POST /api/live/cues/:cueId/register` | 本岗位执行 | `op=start/complete/estimate`，带 `publication_id`、`version` |

错误响应统一形如：

```json
{ "error": { "code": "STALE_VERSION", "message": "版本已过期，请刷新后重试（当前版本 4）", "details": { "currentVersion": 4 } } }
```

## 八、数据持久化与备份

- Compose 使用命名卷 `callboard-data`（挂载于容器 `/data`），`docker compose down` 不会删除。
- 备份：停止写入后复制 `callboard.db`（连同 `*-wal`、`*-shm`）即可，或使用 `sqlite3 .backup`。

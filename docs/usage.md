# plumb 使用说明

> 版本：1.0.0 | 更新日期：2026-09-17

plumb（铅垂线）是一个**个人本地 AI Native 任务管理系统**。设计原则：系统只做确定性的存储与约束，全部智能由 AI Agent（如 opencode）在外部完成。

---

## 目录

1. [快速开始](#1-快速开始)
2. [核心概念](#2-核心概念)
3. [任务管理](#3-任务管理)
4. [任务关系与依赖](#4-任务关系与依赖)
5. [Inbox 原始捕获队列](#5-inbox-原始捕获队列)
6. [聚合视图](#6-聚合视图)
7. [数据查询与逃生舱](#7-数据查询与逃生舱)
8. [数据管理](#8-数据管理)
9. [与 AI Agent 协作](#9-与-ai-agent-协作)
10. [退出码与错误处理](#10-退出码与错误处理)
11. [数据模型速查](#11-数据模型速查)
12. [常见场景示例](#12-常见场景示例)

---

## 1. 快速开始

### 安装

```bash
# 已全局安装，直接使用
plumb --help
plumb version
```

### 第一个任务

```bash
# 创建任务
plumb issue create --title "完成季度报告" --priority high --due-date 2026-09-30 --labels work

# 查看任务列表
plumb issue list --pretty

# 查看今日看板
plumb board --pretty

# 查看今日摘要
plumb snapshot --pretty
```

### 输出模式

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| 默认（JSON） | stdout 输出结构化 JSON | AI Agent 消费、脚本处理 |
| `--pretty` | 人类可读的文本格式 | 直接在终端浏览 |

> **写命令**（create/update/delete 等）始终只输出 JSON，不支持 `--pretty`。

---

## 2. 核心概念

### 任务标识

每个任务有两种 ID，任何接受 `<idOrSeq>` 的命令均可互换使用：

| 类型 | 示例 | 说明 |
|------|------|------|
| 序号 | `T-42` | 短号，全局自增，供人口头引用 |
| nanoid | `aVozy49e0AdfVyHRGz1Zl` | 内部唯一 ID |

### 状态（state）

```
backlog → todo → in_progress → done
                             ↘ canceled
```

任意方向均允许流转（个人工具不强制单向）。进入 `done` / `canceled` 时系统自动记录 `done_at`，离开时自动清空。

| 状态 | 含义 |
|------|------|
| `backlog` | 想法收集，暂不计划 |
| `todo` | 已计划，待开始（默认） |
| `in_progress` | 进行中 |
| `done` | 已完成 |
| `canceled` | 已取消 |

### 优先级（priority）

`urgent` > `high` > `medium` > `low` > `none`

### 数据存储位置

```
plumb/data/
├── tasks.db            # SQLite 数据库（WAL 模式）
├── descriptions/       # 每个任务的 description Markdown 文件
│   └── {id}.md
├── files/              # 手动放置的附件
└── backups/            # VACUUM INTO 备份文件
```

**备份即拷贝**：将整个 `data/` 目录复制到新机器即完成迁移。

---

## 3. 任务管理

### 3.1 创建任务

```bash
plumb issue create --title <标题> [选项]
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `--title` | string | **必填**，任务标题 |
| `--state` | enum | 初始状态，默认 `todo` |
| `--priority` | enum | 优先级，默认 `none` |
| `--project` | string | 项目分组标签（可选字符串） |
| `--labels` | string | 标签列表，逗号分隔，如 `work,q4` |
| `--start-date` | YYYY-MM-DD | 开始日期 |
| `--due-date` | YYYY-MM-DD | 截止日期 |
| `--parent` | idOrSeq | 父任务 ID（设为子任务） |
| `--description -` | stdin | 从 stdin 读取 Markdown 描述 |

**示例：**

```bash
# 基础创建
plumb issue create --title "修复登录页面 bug"

# 完整参数
plumb issue create \
  --title "Q4 技术方案评审" \
  --priority high \
  --state todo \
  --project "tech-review" \
  --labels "work,q4,review" \
  --start-date 2026-10-01 \
  --due-date 2026-10-15

# 带 Markdown 描述（从 stdin 读取，避免 shell 引号转义）
cat << 'EOF' | plumb issue create --title "接口设计文档" --description -
## 目标
设计用户认证模块的 REST API

## 要点
- POST /auth/login
- POST /auth/refresh
- DELETE /auth/logout
EOF

# 文件内容作为描述
plumb issue create --title "重构方案" --description - < design.md
```

**返回：** 完整的 issue JSON 对象，包含分配的 `seq`（如 `T-1`）。

---

### 3.2 查看任务

```bash
plumb issue get <idOrSeq> [--pretty]
```

返回任务完整信息，包含：description 内容、所有关联关系（relations）、子任务列表（subtasks）。

```bash
# JSON 输出（Agent 使用）
plumb issue get T-42

# 人类可读
plumb issue get T-42 --pretty
```

**输出示例（--pretty）：**
```
T-42  完成季度报告
  state:    todo
  priority: high
  labels:   work, q4
  due:      2026-09-30
  created:  2026-09-17T07:00:00.000Z
  updated:  2026-09-17T07:00:00.000Z

--- description ---
详细说明内容...
```

---

### 3.3 列表查询

```bash
plumb issue list [过滤参数] [--pretty]
```

| 参数 | 说明 |
|------|------|
| `--state <state>` | 按状态过滤 |
| `--project <name>` | 按项目过滤 |
| `--label <tag>` | 按标签过滤（精确匹配，非子串） |
| `--due-before <date>` | 截止日期早于（含） |
| `--due-after <date>` | 截止日期晚于（含） |
| `--q <keyword>` | 标题关键字搜索 |
| `--sort priority` | 按优先级排序（默认按 seq） |
| `--limit <n>` | 最多返回条数（上限 1000） |

```bash
# 查看所有 todo 状态任务
plumb issue list --state todo --pretty

# 查看本周截止的高优任务
plumb issue list --priority --due-before 2026-09-22 --sort priority --pretty

# 查看 work 标签下所有任务
plumb issue list --label work --pretty

# 查看某个项目下进行中的任务
plumb issue list --project tech-review --state in_progress

# 关键字搜索（标题）
plumb issue list --q "报告" --pretty
```

---

### 3.4 更新任务

```bash
plumb issue update <idOrSeq> [--field value ...]
```

**Patch 语义**：只更新传入的字段，未传入的字段保持不变。

```bash
# 开始任务
plumb issue update T-42 --state in_progress

# 完成任务（系统自动写入 done_at）
plumb issue update T-42 --state done

# 修改优先级和截止日期
plumb issue update T-42 --priority urgent --due-date 2026-09-20

# 添加标签
plumb issue update T-42 --labels "work,q4,urgent"

# 设置父任务（变为子任务）
plumb issue update T-42 --parent T-10

# 更新描述
echo "新的描述内容" | plumb issue update T-42 --description -

# 取消任务
plumb issue update T-42 --state canceled
```

---

### 3.5 批量更新（原子事务）

```bash
echo '[...] ' | plumb issue batch-update --stdin
```

接受 JSON 数组，**单事务执行**：任意一条失败则整体回滚，所有任务均不变。

```bash
# 批量将多个任务标为完成
echo '[
  {"id": "T-1", "patch": {"state": "done"}},
  {"id": "T-2", "patch": {"state": "done"}},
  {"id": "T-3", "patch": {"state": "in_progress"}}
]' | plumb issue batch-update --stdin

# 从文件读取
cat updates.json | plumb issue batch-update --stdin
```

**updates.json 格式：**
```json
[
  {
    "id": "T-5",
    "patch": {
      "state": "done",
      "priority": "high"
    }
  },
  {
    "id": "T-6",
    "patch": {
      "due_date": "2026-10-01",
      "labels": ["work", "q4"]
    }
  }
]
```

---

### 3.6 删除任务

```bash
plumb issue delete <idOrSeq>
```

**硬删除**，级联效果：
- 关联的 `issue_links` 边自动删除
- `data/descriptions/{id}.md` 文件删除
- inbox 中 `resolved_issue_id` 置为 NULL

> **注意**：存在子任务时拒绝删除（exit 3），需先删除或移出所有子任务。

```bash
# 删除任务
plumb issue delete T-42

# 如果有子任务，先处理子任务
plumb issue delete T-6   # 先删子任务
plumb issue delete T-5   # 再删父任务

# 或者将子任务移出（清除 parent）
plumb issue update T-6 --parent ""
plumb issue delete T-5
```

---

### 3.7 子任务

子任务通过 `--parent` 参数创建，支持单层引用（实际嵌套深度建议 ≤ 5）。

```bash
# 创建子任务
plumb issue create --title "子任务：编写单元测试" --parent T-10

# 查看父任务（含子任务列表）
plumb issue get T-10 --pretty

# 将现有任务设为子任务
plumb issue update T-15 --parent T-10
```

---

## 4. 任务关系与依赖

### 4.1 关系类型

| 类型 | 方向 | 语义 |
|------|------|------|
| `blocks` | 有向 | source **阻塞** target：source 是前置，target 被阻塞 |
| `relates` | 对称 | 两个任务相关联 |
| `duplicate` | 对称 | 一个任务是另一个的重复 |

**方向约定（全文唯一口径）：**
> `plumb link A B --type blocks` = A 阻塞 B = B 必须等 A 完成才能开始

### 4.2 建立关系

```bash
plumb link <source> <target> --type <type>
```

```bash
# "T-1 完成后才能开始 T-2"
plumb link T-1 T-2 --type blocks

# 链式依赖：T-1 → T-2 → T-3
plumb link T-1 T-2 --type blocks
plumb link T-2 T-3 --type blocks

# 标记关联
plumb link T-4 T-5 --type relates

# 标记重复（T-6 是 T-5 的重复）
plumb link T-5 T-6 --type duplicate
```

**环检测**：添加 `blocks` 边时，系统自动检测是否形成环。若成环，返回 exit 3 并在 stderr 输出环路径：

```bash
plumb link T-3 T-1 --type blocks
# 若已有 T-1→T-2→T-3 的 blocks 链，则报错：
# stderr: {"error": {"code": "CYCLE", "message": "Cycle detected: T-3→T-1→T-2→T-3"}}
```

### 4.3 删除关系

```bash
plumb unlink <source> <target> --type <type>
```

```bash
plumb unlink T-1 T-2 --type blocks
plumb unlink T-4 T-5 --type relates
```

### 4.4 查询依赖树

```bash
plumb deps <idOrSeq> [--pretty]
```

返回指定任务的**所有传递前置**（递归展开），以及每个前置的当前完成状态。

```bash
# 查看 T-3 的全部前置依赖
plumb deps T-3 --pretty
# 输出示例：
# Dependencies for T-3:
#   T-1 [done]  基础架构搭建
#   T-2 [todo]  接口联调        ← 未完成，T-3 被阻塞

# JSON 输出（含 is_blocked 字段）
plumb deps T-3
```

---

## 5. Inbox 原始捕获队列

Inbox 是一个**纯存储队列**，用于快速记录想法，之后再由 Agent 整理成正式任务。无任何自动解析，原文原样保存。

### 5.1 加入队列

```bash
# 从参数
plumb inbox add "下周五前要准备演讲材料，高优"

# 从 stdin（适合多行内容）
echo "记得联系张三确认需求细节" | plumb inbox add

# 管道方式
cat idea.txt | plumb inbox add --stdin
```

### 5.2 查看队列

```bash
plumb inbox list [--status pending|resolved] [--pretty]
```

```bash
# 查看所有待处理条目
plumb inbox list --status pending --pretty

# 查看全部（含已处理）
plumb inbox list --pretty
```

**输出示例（--pretty）：**
```
[pending] cxPN3M3VKJln4pGt135VB 2026-09-17T07:15:46.594Z
  下周五前要准备演讲材料，高优
[pending] yOr4fCNidswcTRDBQQ2gg 2026-09-17T07:15:47.000Z
  记得联系张三确认需求细节
```

### 5.3 处理并关联任务

```bash
plumb inbox resolve <inbox_id> [--issue <idOrSeq>]
```

```bash
# 先创建任务
plumb issue create --title "准备演讲材料" --priority high --due-date 2026-09-25

# 标记 inbox 条目已处理，并关联到创建的任务
plumb inbox resolve cxPN3M3VKJln4pGt135VB --issue T-13

# 仅标记已处理，不关联（条目废弃）
plumb inbox resolve yOr4fCNidswcTRDBQQ2gg
```

---

## 6. 聚合视图

### 6.1 今日快照（snapshot）

```bash
plumb snapshot [--stale-days <n>] [--pretty]
```

**一次调用**返回六组结构化数据，是每日规划的核心命令：

| 分组 | 说明 |
|------|------|
| `overdue` | 已过截止日期，未完成 |
| `due_today` | 今日到期 |
| `in_progress` | 当前进行中 |
| `actionable` | 可立即开始（无未完成前置，已按优先级+截止日期排序） |
| `blocked` | 被阻塞（含前置任务清单） |
| `stale` | 长期未更新（默认 30 天，可调） |

```bash
# 人类阅读
plumb snapshot --pretty

# 调整停滞天数阈值
plumb snapshot --stale-days 14 --pretty

# JSON 输出（供 Agent 分析）
plumb snapshot
```

**--pretty 输出示例：**
```
=== OVERDUE (1) ===
  T-3    todo        🔵 low       接口文档 due:2026-09-15

=== DUE TODAY (2) ===
  T-7    todo        🟠 high      季度报告 due:2026-09-17
  T-9    todo        🟡 medium    周会准备 due:2026-09-17

=== IN PROGRESS (1) ===
  T-5    in_progress 🔴 urgent    紧急 bug 修复

=== ACTIONABLE (3) ===
  T-1    todo        🔴 urgent    架构评审
  T-4    todo        🟠 high      需求澄清
  T-8    todo        🟡 medium    单元测试

=== BLOCKED (1) ===
  T-6    todo        🔵 low       部署上线
    ← blocked by: T-5 [in_progress] 紧急 bug 修复

=== STALE (>30d) (0) ===
  (none)
```

---

### 6.2 文本看板（board）

```bash
plumb board [--project <name>] [--label <tag>]
```

输出五列纯文本看板，始终为人类可读格式。

```bash
# 全部任务看板
plumb board

# 按项目过滤
plumb board --project tech-review

# 按标签过滤
plumb board --label work
```

**输出示例：**
```
BACKLOG                        | TODO                           | IN PROGRESS                    | DONE                           | CANCELED
-------------------------------+--------------------------------+--------------------------------+--------------------------------+-------------------------------
                               | T-1 架构评审                    | T-5 紧急 bug 修复               | T-2 需求文档                    |
                               | T-4 需求澄清                    |                                |                                |
                               | T-7 季度报告                    |                                |                                |
```

---

### 6.3 全文搜索（search）

```bash
plumb search <关键字> [--pretty]
```

同时搜索任务**标题**和 `data/descriptions/` 下的 **Markdown 描述文件**。

```bash
plumb search "报告" --pretty
plumb search "bug" --pretty

# JSON 输出
plumb search "认证"
```

---

## 7. 数据查询与逃生舱

### 7.1 查看 Schema

在编写自定义 SQL 前，先运行此命令了解完整表结构：

```bash
plumb schema
```

输出内容：
- 完整 DDL（CREATE TABLE 语句）
- 字段语义说明
- 示例查询

### 7.2 只读 SQL 查询

```bash
plumb query "<SQL>" [--limit <n>]
```

**安全约束：**
- 只允许 `SELECT` / `WITH` 语句
- 禁止多语句（分号分隔）
- 结果自动包裹 `LIMIT`（默认 200，最大 1000）
- 使用独立只读连接，不影响写路径

```bash
# 查询所有 todo 任务
plumb query "SELECT seq, title, priority, due_date FROM issues WHERE state = 'todo' ORDER BY due_date"

# 查询带 work 标签的任务（用 json_each，不用 LIKE）
plumb query "SELECT seq, title FROM issues WHERE EXISTS (SELECT 1 FROM json_each(labels) je WHERE je.value = 'work')"

# 查询超过 30 天未更新的进行中任务
plumb query "SELECT seq, title, updated_at FROM issues WHERE state = 'in_progress' AND updated_at < datetime('now', '-30 days')"

# 查询某任务的所有前置依赖
plumb query "
  WITH RECURSIVE deps(id) AS (
    SELECT source_id FROM issue_links WHERE target_id = (SELECT id FROM issues WHERE seq = 5) AND type = 'blocks'
    UNION
    SELECT l.source_id FROM issue_links l JOIN deps d ON l.target_id = d.id WHERE l.type = 'blocks'
  )
  SELECT i.seq, i.title, i.state FROM issues i WHERE i.id IN (SELECT id FROM deps)
"

# 统计各状态任务数量
plumb query "SELECT state, COUNT(*) as count FROM issues GROUP BY state ORDER BY count DESC"

# 限制返回条数
plumb query "SELECT * FROM issues ORDER BY created_at DESC" --limit 10
```

---

## 8. 数据管理

### 8.1 备份

```bash
plumb backup
```

使用 SQLite `VACUUM INTO` 创建**在线一致性备份**（WAL 模式下安全，不直接 cp 文件）。

- 备份路径：`data/backups/tasks-YYYYMMDD.db`
- 自动保留最近 **14 份**，超出自动删除旧备份
- 可挂 launchd/cron 定期执行

```bash
# 手动备份
plumb backup
# 返回: {"path": "/path/to/data/backups/tasks-20260917.db"}

# 添加到 crontab（每天凌晨 2 点）
# crontab -e
# 0 2 * * * /usr/local/bin/plumb backup
```

### 8.2 数据迁移

```bash
# 迁移到新机器：直接拷贝 data/ 目录
cp -r /path/to/plumb/data/ /new-machine/path/to/plumb/data/

# 验证恢复
plumb issue list --pretty
```

### 8.3 直接编辑描述文件

description 以 Markdown 文件存储，可直接用编辑器修改：

```bash
# 用 vim 编辑 T-42 的描述
vim data/descriptions/$(plumb issue get T-42 | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])").md

# 或通过 plumb 命令更新
echo "新的描述" | plumb issue update T-42 --description -
```

---

## 9. 与 AI Agent 协作

plumb 的设计目标是 **Agent-first**：Agent 用 JSON 输出做精确处理，人用 `--pretty` 做浏览。

### 9.1 在 opencode 中加载 skill

plumb skill 已安装到 `~/.config/opencode/skills/plumb/`，在 opencode 中直接描述需求即可：

```
# opencode 对话示例
"帮我规划今天的工作"
"处理一下我的 inbox"
"把所有超期任务都整理一下"
"下周要出差，帮我把相关任务都整理好"
```

Agent 会自动加载 plumb skill，编排相应命令。

### 9.2 日常工作流

**早间规划（daily-review）：**
```
用户 → Agent: "今天干什么"
Agent → plumb: plumb snapshot
Agent → 用户: 分析六组数据，推荐今日任务，等待确认
用户 → Agent: 确认/调整
Agent → plumb: plumb issue batch-update --stdin（批量更改状态）
```

**快速捕获（quick-capture）：**
```
用户 → Agent: "下周五前完成 API 文档，高优，标签 work"
Agent → 自行解析: title/due_date/priority/labels
Agent → plumb: plumb issue create --title "完成 API 文档" --priority high --due-date 2026-09-25 --labels work
Agent → 用户: 转述确认 "已创建 T-44：完成 API 文档，高优，截止 9/25"
```

**Inbox 整理（inbox-triage）：**
```
用户 → Agent: "帮我处理一下 inbox"
Agent → plumb: plumb inbox list --status pending
Agent → 逐条解析: 创建任务 + resolve inbox 条目
Agent → 用户: "处理了 5 条，创建了 3 个任务，废弃了 2 条"
```

### 9.3 手动直接使用

```bash
# 人工日常操作（--pretty 模式）
plumb issue list --state in_progress --pretty
plumb board --pretty
plumb snapshot --pretty
plumb search "关键词" --pretty

# 快速记录想法
plumb inbox add "明天早上记得回复 PR 评论"
```

---

## 10. 退出码与错误处理

| 退出码 | 含义 | 典型场景 |
|--------|------|---------|
| `0` | 成功 | — |
| `2` | 入参校验失败 / 非法 SQL | 缺少必填参数、状态值拼写错误、传入 UPDATE SQL |
| `3` | 业务冲突 | 环检测失败、删除含子任务的任务、batch-update 中某条失败 |
| `4` | 资源不存在 | 查询/更新不存在的 `T-N` |

### 错误输出格式

所有错误输出到 **stderr**，格式为 JSON：

```json
{
  "error": {
    "code": "CYCLE",
    "message": "Cycle detected: T-3→T-1→T-2→T-3",
    "cycle_path": "T-3→T-1→T-2→T-3"
  }
}
```

### 常见错误处理

**环检测（exit 3）：**
```bash
plumb link T-3 T-1 --type blocks
# 已有 T-1→T-2→T-3，形成环
# 解决：改用 relates，或检查依赖方向是否正确
plumb link T-3 T-1 --type relates
```

**删除含子任务（exit 3）：**
```bash
plumb issue delete T-5
# {"error": {"code": "HAS_SUBTASKS", "message": "Cannot delete: issue has subtasks: T-6: 子任务名"}}
# 解决：先删子任务
plumb issue delete T-6
plumb issue delete T-5
```

**任务不存在（exit 4）：**
```bash
plumb issue get T-999
# {"error": {"code": "NOT_FOUND", "message": "Issue not found: T-999"}}
```

---

## 11. 数据模型速查

### 核心表结构

```sql
-- 任务主表
issues (
  id          TEXT  -- nanoid，主键
  seq         INT   -- 自增序号，T-N 的 N
  title       TEXT  -- 标题（必填）
  state       TEXT  -- backlog|todo|in_progress|done|canceled
  priority    TEXT  -- urgent|high|medium|low|none
  project     TEXT  -- 可选分组字符串
  parent_id   TEXT  -- 父任务 id（子任务）
  labels      TEXT  -- JSON 数组，如 ["work","q4"]
  start_date  TEXT  -- 本地日期 YYYY-MM-DD
  due_date    TEXT  -- 本地日期 YYYY-MM-DD
  done_at     TEXT  -- UTC ISO8601，系统自动维护
  created_at  TEXT  -- UTC ISO8601
  updated_at  TEXT  -- UTC ISO8601
)

-- 任务关系表
issue_links (
  source_id   TEXT  -- 源任务（blocks 类型中为前置/blocker）
  target_id   TEXT  -- 目标任务（blocks 类型中为被阻塞方）
  type        TEXT  -- blocks|relates|duplicate
  created_at  TEXT
  PRIMARY KEY (source_id, target_id, type)
)

-- 原始捕获队列
inbox (
  id                TEXT  -- nanoid
  raw               TEXT  -- 原始文本
  status            TEXT  -- pending|resolved
  resolved_issue_id TEXT  -- 关联的任务 id（可选）
  created_at        TEXT
)
```

### 关键规则

- **blocks 方向**：`(source_id, target_id, 'blocks')` = source **阻塞** target
  - "B 等 A 做完" → `plumb link A B --type blocks`（A 是 source）
- **relates/duplicate**：对称关系，查询时双向匹配
- **labels**：JSON 数组，查询时用 `json_each(labels)`，不要用 `LIKE '%tag%'`
- **时间格式**：`created_at/updated_at/done_at` 为 UTC ISO8601；`start_date/due_date` 为本地 `YYYY-MM-DD`

---

## 12. 常见场景示例

### 场景 1：完整任务生命周期

```bash
# 1. 创建
plumb issue create --title "重构用户认证模块" --priority high --due-date 2026-10-31 --labels "work,backend"

# 2. 拆分子任务
plumb issue create --title "编写单元测试" --parent T-20
plumb issue create --title "更新 API 文档" --parent T-20

# 3. 开始工作
plumb issue update T-20 --state in_progress

# 4. 完成子任务
plumb issue update T-21 --state done
plumb issue update T-22 --state done

# 5. 完成父任务（系统自动记录 done_at）
plumb issue update T-20 --state done

# 6. 查看最终状态
plumb issue get T-20 --pretty
```

### 场景 2：依赖链管理

```bash
# 项目：A 完成 → B 才能开始 → C 才能发布

plumb issue create --title "数据库迁移脚本" --priority urgent  # T-30
plumb issue create --title "后端接口开发" --priority high       # T-31
plumb issue create --title "前端联调上线" --priority high       # T-32

# 建立依赖链
plumb link T-30 T-31 --type blocks  # 数据库迁移完成后才能开发接口
plumb link T-31 T-32 --type blocks  # 接口完成后才能联调

# 查看 T-32 的全部前置
plumb deps T-32 --pretty

# snapshot 会自动将 T-31、T-32 标为 blocked
plumb snapshot --pretty
```

### 场景 3：批量处理周末积压

```bash
# 查看所有积压任务
plumb issue list --state backlog --pretty

# 批量激活几个本周要做的
echo '[
  {"id": "T-15", "patch": {"state": "todo", "due_date": "2026-09-19"}},
  {"id": "T-16", "patch": {"state": "todo", "priority": "high"}},
  {"id": "T-17", "patch": {"state": "canceled"}}
]' | plumb issue batch-update --stdin
```

### 场景 4：自定义 SQL 统计

```bash
# 本月完成了多少任务
plumb query "SELECT COUNT(*) as done_count FROM issues WHERE state = 'done' AND done_at >= '2026-09-01'"

# 各优先级任务数量分布
plumb query "SELECT priority, state, COUNT(*) as cnt FROM issues GROUP BY priority, state ORDER BY priority, state"

# 找出所有阻塞其他任务的未完成任务
plumb query "
  SELECT DISTINCT i.seq, i.title, i.state, i.priority
  FROM issues i
  JOIN issue_links l ON l.source_id = i.id AND l.type = 'blocks'
  JOIN issues t ON t.id = l.target_id
  WHERE i.state NOT IN ('done', 'canceled')
  ORDER BY i.seq
"
```

### 场景 5：快速查看今日工作

```bash
# 一行看全局
plumb board --pretty

# 详细分析
plumb snapshot --pretty

# 开始今天第一个任务
plumb issue update T-7 --state in_progress
```

---

## 附录：命令速查表

| 命令 | 功能 |
|------|------|
| `plumb issue create` | 创建任务 |
| `plumb issue get <id>` | 查看任务详情 |
| `plumb issue list` | 列表查询 |
| `plumb issue update <id>` | 更新任务字段 |
| `plumb issue delete <id>` | 删除任务 |
| `plumb issue batch-update --stdin` | 批量更新（原子事务） |
| `plumb link <src> <tgt> --type <t>` | 建立任务关系 |
| `plumb unlink <src> <tgt> --type <t>` | 删除任务关系 |
| `plumb deps <id>` | 查询依赖树 |
| `plumb snapshot` | 今日六组聚合摘要 |
| `plumb board` | 五列文本看板 |
| `plumb search <q>` | 全文搜索 |
| `plumb inbox add` | 加入原始捕获队列 |
| `plumb inbox list` | 查看 inbox 列表 |
| `plumb inbox resolve <id>` | 处理 inbox 条目 |
| `plumb query "<sql>"` | 只读 SQL 查询 |
| `plumb schema` | 查看数据库结构 |
| `plumb backup` | 创建数据库备份 |
| `plumb version` | 查看版本号 |
| `plumb --help` | 查看帮助 |

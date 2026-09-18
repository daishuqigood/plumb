# plumb 使用说明

> 版本：3.0.0 | 更新日期：2026-09-18

plumb（铅垂线）是一个**个人本地 AI-Native 任务管理系统**，定位为 **Agent 的事件溯源记忆基座**。设计原则：系统只做确定性的存储与约束，全部智能由 AI Agent（如 opencode/workspace）在外部完成。

**v3 核心升级**：事件溯源（全历史可审计/可撤销/可重建）、派生可执行性层（readiness_score/is_blocked/is_overdue 等查询时现算）、内容寻址 description（CAS）、完整时间模型（UTC + IANA 时区 + RRULE 重复）、provenance（每字段来源与置信度）、验收标准结构化（verify/verify_run）。

---

## 目录

1. [快速开始](#1-快速开始)
2. [核心概念](#2-核心概念)
3. [任务管理](#3-任务管理)
4. [任务关系与依赖](#4-任务关系与依赖)
5. [Inbox 原始捕获队列](#5-inbox-原始捕获队列)
6. [聚合视图](#6-聚合视图)
7. [事件溯源：审计/撤销/重建](#7-事件溯源审计撤销重建)
8. [验收标准（verify）](#8-验收标准verify)
9. [数据查询与逃生舱](#9-数据查询与逃生舱)
10. [数据管理](#10-数据管理)
11. [与 AI Agent 协作](#11-与-ai-agent-协作)
12. [退出码与错误处理](#12-退出码与错误处理)
13. [数据模型速查](#13-数据模型速查)
14. [常见场景示例](#14-常见场景示例)

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

# 查看今日摘要（含 readiness 排序 + 7 组分类）
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

### 2.1 事件溯源

v3 的真相载体是 **`events` 表**（append-only 全历史），`issues` 退化为可重建的物化投影。所有写操作 = 追加事件 + 更新投影，在同一事务内完成。

- **审计**：`plumb events T-42` 查看任务完整历史
- **撤销**：`plumb undo <op_id>` 追加补偿事件（原始事件不删除）
- **重建**：`plumb rebuild` 从事件流重放重建全部投影

### 2.2 任务标识

每个任务有两种 ID，任何接受 `<idOrSeq>` 的命令均可互换使用：

| 类型 | 示例 | 说明 |
|------|------|------|
| 序号 | `T-42` | 短号，全局自增，供人口头引用 |
| nanoid | `aVozy49e0AdfVyHRGz1Zl` | 内部唯一 ID |

### 2.3 状态（state）

```
backlog → todo → in_progress → done
                             ↘ canceled
```

任意方向均允许流转。进入 `done` / `canceled` 时系统自动记录 `done_at`，离开时自动清空。

| 状态 | 含义 |
|------|------|
| `backlog` | 想法收集，暂不计划 |
| `todo` | 已计划，待开始（默认） |
| `in_progress` | 进行中 |
| `done` | 已完成 |
| `canceled` | 已取消 |

### 2.4 优先级（priority）

`urgent` > `high` > `medium` > `low` > `none`

### 2.5 派生可执行性层

以下字段**查询时现算**（不写库），由系统确定性公式派生：

| 派生字段 | 定义 |
|----------|------|
| `is_blocked` | 存在有效 blocks 边且前置未完成 |
| `is_overdue` | due_ts < now 且未 done/canceled |
| `is_stale` | 长期未更新且未 done/canceled |
| `is_snoozed` | snooze_until > now |
| `is_verified` | 最近一次 verify_run.result == 'pass'（无 verify 定义则为 null） |
| `readiness_score` | 0..1 综合评分（priority × 0.4 + due_urgency × 0.4 − blocked × 0.5 − stale × 0.3） |
| `next_action_hint` | 派生提示：blocked/reschedule_or_complete/verify/start 等 |

### 2.6 数据存储位置

数据目录按优先级解析：

| 优先级 | 来源 | 路径 |
|--------|------|------|
| 1 | `PLUMB_DIR` env | 任意路径（测试/CI 隔离用） |
| 2 | XDG 默认 | `$XDG_DATA_HOME/plumb`（未设则 `~/.local/share/plumb`） |

```
~/.local/share/plumb/          # 默认 live 数据目录
├── tasks.db                   # SQLite 数据库（WAL 模式）
├── descriptions/              # 内容寻址 CAS description 文件
│   └── {sha256prefix}.md      # 以内容 hash 命名，天然去重
├── files/                     # 手动放置的附件
└── backups/                   # VACUUM INTO 备份文件
```

> 首次运行时，若包根 `data/tasks.db` 存在，会自动整体搬迁到 XDG 目录。

---

## 3. 任务管理

### 3.1 创建任务

```bash
plumb issue create --title <标题> [选项]
```

**基础字段：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `--title` | string | **必填**，任务标题 |
| `--state` | enum | 初始状态，默认 `todo` |
| `--priority` | enum | 优先级，默认 `none` |
| `--project` | string | 项目分组标签 |
| `--labels` | string | 标签列表，逗号分隔，如 `work,q4` |
| `--parent` | idOrSeq | 父任务 ID |
| `--description -` | stdin | 从 stdin 读取 Markdown 描述 |

**v3 时间字段（精确时刻）：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `--due-ts` | UTC ISO8601 | 精确截止时刻（如 `2026-09-30T16:00:00.000Z`） |
| `--due-tz` | IANA 时区 | 如 `Asia/Shanghai`，用于日界计算 |
| `--start-ts` | UTC ISO8601 | 精确开始时刻 |
| `--due-date` | YYYY-MM-DD | 本地日期（自动转为 due_ts，时区取默认 `Asia/Shanghai`） |
| `--start-date` | YYYY-MM-DD | 本地日期（同上） |
| `--rrule` | RRULE 子集 | 重复规则，如 `FREQ=WEEKLY;INTERVAL=1` |
| `--snooze-until` | UTC ISO8601 | 推迟到此时刻前不出现在 actionable |

**v3 扩展字段：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `--attr k=v` | 可重复 | 写入 attrs JSON（Agent 自定义维度） |
| `--verify '<json>'` | JSON | 验收标准（见第 8 节） |

**v3 Provenance 字段（所有写命令通用）：**

| 参数 | 说明 |
|------|------|
| `--actor <who>` | 来源主体，如 `user`、`agent:claude`（默认 `user`） |
| `--reason <text>` | 操作理由（写入事件 reason 字段） |
| `--conf <0..1>` | 置信度（Agent 推断时使用，`1.0` 为确定） |
| `--session <id>` | 关联会话 ID（同一次拆分操作共享） |
| `--op-id <uuid>` | 幂等键（重试时传相同值防重复写入） |
| `--raw-input <text>` | 产生此操作的原始用户话语 |

**示例：**

```bash
# 基础创建
plumb issue create --title "修复登录页面 bug"

# 完整参数
plumb issue create \
  --title "Q4 技术方案评审" \
  --priority high \
  --due-date 2026-10-15 \
  --labels "work,q4,review" \
  --project tech-review

# 精确 UTC 时刻 + 时区
plumb issue create \
  --title "每周站会" \
  --due-ts "2026-09-19T02:00:00.000Z" \
  --due-tz "Asia/Shanghai" \
  --rrule "FREQ=WEEKLY;INTERVAL=1"

# 带 Markdown 描述
cat << 'EOF' | plumb issue create --title "接口设计文档" --description -
## 目标
设计用户认证模块的 REST API

## 要点
- POST /auth/login
- POST /auth/refresh
- DELETE /auth/logout
EOF

# 带 provenance（Agent 推断，0.8 置信度）
plumb issue create \
  --title "准备演讲材料" \
  --priority high \
  --due-date 2026-09-25 \
  --actor "agent:claude" \
  --conf 0.8 \
  --raw-input "下周五前要准备演讲材料，高优"

# 带自定义属性
plumb issue create --title "API 设计" --attr complexity=high --attr team=backend

# 带验收标准
plumb issue create \
  --title "修复登录 bug" \
  --verify '{"type":"command","cmd":"pnpm test auth","expect":"exit 0"}'
```

**返回：** 完整的 issue JSON 对象，含 `seq`（如 `T-1`）、`id`、所有字段及派生字段。

---

### 3.2 查看任务

```bash
plumb issue get <idOrSeq> [--pretty]
```

v3 返回包含：description 内容（从 CAS 解析）、attrs、field_meta（provenance 快照）、派生字段（readiness_score/is_blocked/is_overdue/is_verified 等）、verify 定义、最近 verify_run 记录、关联关系、子任务列表。

```bash
# JSON 输出（Agent 使用）
plumb issue get T-42

# 人类可读
plumb issue get T-42 --pretty
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
| `--label <tag>` | 按标签过滤（精确匹配） |
| `--due-before <date>` | 截止日期早于（含） |
| `--due-after <date>` | 截止日期晚于（含） |
| `--q <keyword>` | 标题关键字搜索 |
| `--sort priority` | 按优先级排序（默认按 seq） |
| `--limit <n>` | 最多返回条数（上限 1000） |

```bash
# 查看所有 todo 状态任务
plumb issue list --state todo --pretty

# 查看本周截止高优任务
plumb issue list --due-before 2026-09-22 --sort priority --pretty

# 查看某项目进行中的任务
plumb issue list --project tech-review --state in_progress

# 关键字搜索
plumb issue list --q "报告" --pretty
```

---

### 3.4 更新任务

```bash
plumb issue update <idOrSeq> [--field value ...]
```

**Patch 语义**：只更新传入的字段，未传入的字段保持不变。支持所有 `create` 的字段（`--title`/`--state`/`--priority`/`--labels`/`--due-ts`/`--due-tz`/`--due-date`/`--rrule`/`--snooze-until`/`--attr`/`--verify` 等）及全部 provenance 标志。

```bash
# 开始任务
plumb issue update T-42 --state in_progress

# 完成任务（done_at 自动写入）
plumb issue update T-42 --state done

# 修改优先级和截止日期
plumb issue update T-42 --priority urgent --due-date 2026-09-20

# 推迟任务（三天内不出现在 actionable）
plumb issue update T-42 --snooze-until "2026-09-21T00:00:00.000Z"

# 更新描述
echo "新的描述内容" | plumb issue update T-42 --description -

# 设置重复规则（每月第一天）
plumb issue update T-42 --rrule "FREQ=MONTHLY;INTERVAL=1"

# Agent 更新（带 provenance）
plumb issue update T-42 --state done \
  --actor "agent:claude" \
  --reason "所有子任务已完成" \
  --session "sess_abc123"
```

---

### 3.5 批量更新（原子事务）

```bash
echo '[...]' | plumb issue batch-update --stdin
```

接受 JSON 数组，**单事务执行**：任意一条失败则整体回滚。

```bash
echo '[
  {"id": "T-1", "patch": {"state": "done"}},
  {"id": "T-2", "patch": {"state": "done"}},
  {"id": "T-3", "patch": {"state": "in_progress"}}
]' | plumb issue batch-update --stdin
```

---

### 3.6 删除任务

```bash
plumb issue delete <idOrSeq>
```

v3 使用 tombstone（`deleted=1`）：投影保留事件溯源完整性，`issues_live` 视图过滤已删除任务。级联效果：edges 自动删除（`ON DELETE CASCADE`），inbox 中 `resolved_issue_id` 置 NULL。

> 存在子任务时拒绝删除（exit 3），需先删除或移出子任务。

```bash
plumb issue delete T-42

# 如有子任务，先处理子任务
plumb issue update T-6 --parent ""   # 清除 parent
plumb issue delete T-5
```

---

### 3.7 子任务

```bash
# 创建子任务
plumb issue create --title "编写单元测试" --parent T-10

# 查看父任务（含子任务列表）
plumb issue get T-10 --pretty

# 将现有任务设为子任务
plumb issue update T-15 --parent T-10
```

---

### 3.8 RRULE 重复任务

重复任务完成（`state→done`）时，系统**自动推进** due_ts 并重开（`state→todo`，`done_at=null`），同时追加事件记录。

支持的 RRULE 子集：

| 关键字 | 示例 |
|--------|------|
| `FREQ=DAILY` | 每天 |
| `FREQ=WEEKLY;INTERVAL=2` | 每两周 |
| `FREQ=MONTHLY;INTERVAL=1` | 每月 |
| `COUNT=5` | 最多重复 5 次 |
| `UNTIL=<UTC-ts>` | 到某时刻截止 |

```bash
# 每周一晨会
plumb issue create \
  --title "周一晨会准备" \
  --due-ts "2026-09-21T01:00:00.000Z" \
  --due-tz "Asia/Shanghai" \
  --rrule "FREQ=WEEKLY;INTERVAL=1"

# 完成后自动推进到下周
plumb issue update T-50 --state done
# → 系统自动将 T-50 的 due_ts 推进 7 天，state 重置为 todo
```

---

## 4. 任务关系与依赖

### 4.1 关系类型

v3 关系类型为**开放词表**（不限于枚举），内置约定：

| 类型 | 方向 | 语义 | 环检测 |
|------|------|------|--------|
| `blocks` | 有向 | source **阻塞** target | 是 |
| `relates` | 对称 | 相关联 | 否 |
| `duplicate` | 对称 | 重复任务 | 否 |
| `needs` | 有向 | source 等待 target 提供资源/信息 | 否 |
| 自定义 | 任意 | 如 `follows`、`part_of` | 否 |

**方向约定：**
> `plumb link A B --type blocks` = A 阻塞 B = B 必须等 A 完成才能开始

### 4.2 建立关系

```bash
plumb link <source> <target> --type <type> [选项]
```

| 参数 | 说明 |
|------|------|
| `--type` | 关系类型（默认 `relates`） |
| `--weight` | 权重（正数，默认 1.0） |
| `--valid-from` | 关系生效时刻（UTC，默认 now） |
| `--valid-to` | 关系失效时刻（UTC，null 为当前有效） |

```bash
# T-1 完成后才能开始 T-2
plumb link T-1 T-2 --type blocks

# 链式依赖
plumb link T-1 T-2 --type blocks
plumb link T-2 T-3 --type blocks

# 标记关联
plumb link T-4 T-5 --type relates

# 标记重复
plumb link T-5 T-6 --type duplicate

# 资源请求（T-10 需要用户提供 API Key）
plumb issue create --title "提供 OpenAI API Key" --state todo
plumb link T-10 T-51 --type needs

# 自定义类型
plumb link T-7 T-8 --type follows --weight 2.0
```

**blocks 环检测：**

```bash
plumb link T-3 T-1 --type blocks
# 若已有 T-1→T-2→T-3 的 blocks 链，则报错（exit 3）：
# stderr: {"error": {"code": "CYCLE", "message": "Cycle detected: T-3→T-1→T-2→T-3"}}
```

### 4.3 删除关系

```bash
plumb unlink <source> <target> --type <type>
```

v3 通过设置 `valid_to` 实现软删除（事件溯源），`edges` 表保留历史记录。

```bash
plumb unlink T-1 T-2 --type blocks
plumb unlink T-4 T-5 --type relates
```

### 4.4 查询依赖树

```bash
plumb deps <idOrSeq> [--type <type>] [--pretty]
```

返回指定任务的所有传递前置（递归展开）及其完成状态。`--type` 过滤关系类型（默认 `blocks`）。

```bash
# 查看 T-3 的全部前置依赖
plumb deps T-3 --pretty

# 查看 needs 类型的依赖（awaiting_user 资源）
plumb deps T-10 --type needs --pretty
```

---

## 5. Inbox 原始捕获队列

Inbox 是**纯存储队列**，用于快速记录想法，由 Agent 整理成正式任务。无任何自动解析，原文原样保存。

### 5.1 加入队列

```bash
# 从参数
plumb inbox add "下周五前要准备演讲材料，高优"

# 从 stdin
echo "记得联系张三确认需求细节" | plumb inbox add

# 带 provenance
plumb inbox add "紧急：修复线上登录问题" \
  --actor user \
  --session sess_xyz
```

### 5.2 查看队列

```bash
plumb inbox list [--status pending|resolved] [--pretty]

# 查看待处理条目
plumb inbox list --status pending --pretty

# 查看全部（含已处理）
plumb inbox list --pretty
```

### 5.3 处理并关联任务

```bash
plumb inbox resolve <inbox_id> [--issue <idOrSeq>]

# 先创建任务
plumb issue create --title "准备演讲材料" --priority high --due-date 2026-09-25

# 标记 inbox 条目已处理，关联到创建的任务
plumb inbox resolve cxPN3M3VKJln4pGt135VB --issue T-13

# 仅标记已处理，不关联
plumb inbox resolve yOr4fCNidswcTRDBQQ2gg
```

---

## 6. 聚合视图

### 6.1 今日快照（snapshot）

```bash
plumb snapshot [--stale-days <n>] [--pretty]
```

v3 返回**七组**结构化数据，是每日规划的核心命令：

| 分组 | 说明 |
|------|------|
| `overdue` | 已过截止日期，未完成 |
| `due_today` | 今日到期（按 due_tz 日界） |
| `in_progress` | 当前进行中 |
| `actionable` | 可立即开始（无未完成前置，按 readiness_score 排序，snoozed 任务排除） |
| `blocked` | 被阻塞（含前置任务清单） |
| `stale` | 长期未更新（默认 30 天，可调） |
| `awaiting_user` | 等待用户提供资源（needs 边的目标未完成任务） |

v3 每个任务附加派生字段：`readiness_score`、`next_action_hint`、`is_snoozed`、`is_verified`。done 且 verify 未通过的任务标记为 `done_unverified`（软提示）。

```bash
# 人类阅读
plumb snapshot --pretty

# 调整停滞天数阈值
plumb snapshot --stale-days 14 --pretty

# JSON 输出（供 Agent 分析）
plumb snapshot
```

---

### 6.2 文本看板（board）

```bash
plumb board [--project <name>] [--label <tag>]

# 全部任务
plumb board

# 按项目过滤
plumb board --project tech-review
```

输出五列纯文本看板：BACKLOG / TODO / IN PROGRESS / DONE / CANCELED。

---

### 6.3 全文搜索（search）

```bash
plumb search <关键字> [--pretty]
```

同时搜索任务**标题**和 CAS **description 文件**内容。语义匹配由 Agent 拉全量数据在自身上下文完成（见第 11 节）。

```bash
plumb search "报告" --pretty
plumb search "认证"
```

---

## 7. 事件溯源：审计/撤销/重建

### 7.1 查看实体事件历史

```bash
plumb events <idOrSeq> [--limit N] [--entity issue|edge|inbox]
```

返回某任务（或边/inbox 条目）的完整事件流，含每条事件的 actor/reason/raw_input/conf/session_id。

```bash
# 查看 T-42 的全部历史
plumb events T-42

# 最近 10 条
plumb events T-42 --limit 10

# inbox 条目历史
plumb events abc123 --entity inbox
```

### 7.2 查看自某时刻以来的变更（diff）

```bash
plumb diff --since <ts|op_id> [--entity issue|edge|inbox] [--limit N]
```

跨实体变更列表，支持回答"昨天以来发生了什么""上次 review 后谁动了什么"。

```bash
# 自昨天以来的所有变更
plumb diff --since "2026-09-17T00:00:00.000Z"

# 自某个操作以来的变更
plumb diff --since op_abc123

# 只看 issue 类型
plumb diff --since "2026-09-17T00:00:00.000Z" --entity issue
```

### 7.3 撤销操作（undo）

```bash
plumb undo <op_id>
```

追加**补偿事件**撤销某次操作（原始事件保留，审计链完整）。支持撤销 create/update/delete/link/unlink 等所有写操作。

```bash
# 查找 op_id（从 plumb events 或 JSON 返回中获取）
plumb events T-42 | jq '.[0].op_id'

# 撤销该操作
plumb undo op_abc123
```

### 7.4 重建投影（rebuild）

```bash
plumb rebuild
```

从 `events` 表按 seq 升序重放，重建 `issues`/`edges` 全部投影及 field_meta。用于：投影损坏修复、schema 升级回填、一致性校验。

```bash
plumb rebuild
# 返回: {"rebuilt": true, "issues": 42, "edges": 15}
```

---

## 8. 验收标准（verify）

v3 支持为任务定义**结构化验收标准**，并记录验证证据，实现需求执行闭环。

### 8.1 定义验收标准

通过 `--verify` 传入 JSON：

```bash
# command 类型：Agent 可自动执行的命令
plumb issue create \
  --title "修复登录 bug" \
  --verify '{"type":"command","cmd":"pnpm test auth","expect":"exit 0"}'

# manual 类型：需要人工验收
plumb issue create \
  --title "周报内容撰写" \
  --verify '{"type":"manual","note":"用户人工确认内容质量"}'

# 更新现有任务的验收标准
plumb issue update T-42 --verify '{"type":"command","cmd":"pnpm build","expect":"exit 0"}'
```

### 8.2 记录验证结果

```bash
plumb verify <idOrSeq> --result pass|fail [--evidence -] [--cmd <cmd>]
```

Agent 在外部执行验证命令后，将结果写入事件流。`plumb verify` **不修改** issue state，只追加 `verify_run` 事件。

```bash
# Agent 跑测试通过后记录
pnpm test auth && plumb verify T-42 --result pass --cmd "pnpm test auth"

# 测试失败
plumb verify T-42 --result fail --cmd "pnpm test auth" --evidence "3 tests failed: auth.spec.ts"

# 从 stdin 传入详细证据
cat test-output.txt | plumb verify T-42 --result pass --evidence -

# 人工验收
plumb verify T-42 --result pass --actor user
```

### 8.3 验证状态

- `is_verified=true`：最近一次 verify_run.result == pass
- `is_verified=false`：最近一次 verify_run.result == fail
- `is_verified=null`：无 verify 定义（不适用）

done 且 verify 非空但未 pass 的任务在 snapshot 中标记为 `done_unverified`，daily-review workflow 会提示。**软门禁**：不强制 done 前必须 verify pass（不做 exit 3 硬拒绝）。

---

## 9. 数据查询与逃生舱

### 9.1 查看 Schema

```bash
plumb schema
```

输出完整 DDL（含 events/issues/edges/inbox 表）、字段语义说明、派生公式、RRULE 子集说明及示例查询。在编写自定义 SQL 前先运行。

### 9.2 只读 SQL 查询

```bash
plumb query "<SQL>" [--limit <n>] [--include-deleted]
```

**安全约束：**
- 只允许 `SELECT` / `WITH` 语句
- 默认读 `issues_live` 视图（过滤 tombstone）
- `--include-deleted` 读全投影（含已删除任务）
- 结果自动包裹 `LIMIT`（默认 200，最大 1000）

```bash
# 查询所有 todo 任务
plumb query "SELECT seq, title, priority, due_date FROM issues_live WHERE state = 'todo' ORDER BY due_date"

# 查询带 work 标签的任务（用 json_each）
plumb query "SELECT seq, title FROM issues_live WHERE EXISTS (SELECT 1 FROM json_each(labels) je WHERE je.value = 'work')"

# 读取某任务的 attrs
plumb query "SELECT seq, attrs FROM issues_live WHERE seq = 42"

# 查询 field_meta（provenance）
plumb query "SELECT seq, field_meta FROM issues_live WHERE seq = 42"

# 查询事件流
plumb query "SELECT ts, type, field, old, new, actor, reason FROM events WHERE entity_id = (SELECT id FROM issues WHERE seq = 42) ORDER BY seq"

# 统计各状态任务数量
plumb query "SELECT state, COUNT(*) as count FROM issues_live GROUP BY state ORDER BY count DESC"

# 查找所有阻塞其他任务的未完成任务
plumb query "
  SELECT DISTINCT i.seq, i.title, i.state
  FROM issues_live i
  JOIN edges e ON e.source_id = i.id AND e.type = 'blocks' AND e.valid_to IS NULL
  WHERE i.state NOT IN ('done', 'canceled')
"

# 限制条数
plumb query "SELECT * FROM issues_live ORDER BY created_at DESC" --limit 10
```

---

## 10. 数据管理

### 10.1 备份

```bash
plumb backup
```

使用 SQLite `VACUUM INTO` 创建**在线一致性备份**（WAL 模式安全）。

- 备份路径：`<data_dir>/backups/tasks-YYYYMMDD.db`
- 自动保留最近 **14 份**，超出自动删除旧备份

```bash
plumb backup
# 返回: {"path": "/home/user/.local/share/plumb/backups/tasks-20260918.db"}
```

### 10.2 数据迁移

```bash
# 迁移到新机器：直接拷贝 XDG 数据目录
cp -r ~/.local/share/plumb/ /new-machine/path/

# 验证恢复
plumb issue list --pretty
```

### 10.3 GC（清理无引用 CAS blob）

```bash
plumb gc
```

清理 `descriptions/` 目录中没有任何 issue `desc_hash` 引用的孤立 `.md` 文件（content-addressable 存储的垃圾回收）。

```bash
plumb gc
# 返回: {"deleted_blobs": 3, "freed_bytes": 1024}
```

### 10.4 直接读取 description 文件

description 以 hash 命名的 Markdown 文件存储，可直接读取，但写回需通过 plumb 命令以保持 CAS 一致性：

```bash
# 读取 T-42 的 description（从返回 JSON 的 desc 字段读更简单）
plumb issue get T-42 | jq -r '.desc'

# 通过命令更新
echo "新的描述" | plumb issue update T-42 --description -
cat design.md | plumb issue update T-42 --description -
```

---

## 11. 与 AI Agent 协作

plumb 的设计目标是 **Agent-first**：Agent 用 JSON 输出做精确处理，人用 `--pretty` 做浏览。

### 11.1 在 opencode/workspace 中加载 skill

plumb skill 已安装到 `~/.config/opencode/skills/plumb/`（或 `~/.agents/skills/plumb/`），在 AI Agent 中直接描述需求即可：

```
# 对话示例
"帮我规划今天的工作"
"处理一下我的 inbox"
"把所有超期任务都整理一下"
"需求 X 帮我拆分成子任务，并设计好依赖链和验收标准"
```

### 11.2 核心工作流

**早间规划（daily-review）：**
```
用户 → Agent: "今天干什么"
Agent → plumb snapshot     → 分析七组数据（含 readiness_score/done_unverified）
Agent → 用户: 推荐今日任务（按 readiness 排序），提示未验证完成项
用户 → Agent: 确认/调整
Agent → plumb issue batch-update --stdin
```

**需求执行闭环（requirement-loop）：**
```
用户 → Agent: "实现用户认证功能"
Agent → plumb inbox add（原始话语入队）
Agent → issue create（主任务 + 子任务 + blocks 链）
       全部带 --session <sid> --raw-input "<原话>"
Agent → 为资源缺口建供给任务 + link --type needs
Agent → plumb snapshot 展示 awaiting_user 组
用户  → 提供资源 → resolve 供给任务
Agent → 按 readiness 执行任务
Agent → pnpm test && plumb verify T-N --result pass
Agent → state→done
Agent → plumb diff --since <sid> 生成闭环报告
```

**审计溯源（audit-trail）：**
```
用户 → Agent: "上次 review 后发生了什么变化"
Agent → plumb diff --since 2026-09-15T00:00:00Z
Agent → 归纳变更，提出建议
```

**撤销错误（undo-mistake）：**
```
用户 → Agent: "刚才那次操作搞错了，撤回"
Agent → plumb events T-N --limit 1 → 获取最近 op_id
Agent → plumb undo <op_id>
```

**语义去重（semantic-dedup）：**
```
用户要创建新任务时
Agent → plumb query "SELECT seq, title FROM issues_live WHERE state NOT IN ('done','canceled')"
Agent → 在自身上下文中匹配语义相似任务
Agent → 发现相似项 → 建 duplicate 边 或 追加到现有任务
```

### 11.3 手动直接使用

```bash
# 日常浏览
plumb issue list --state in_progress --pretty
plumb board --pretty
plumb snapshot --pretty

# 快速记录想法
plumb inbox add "明天早上记得回复 PR 评论"

# 查看某任务为何被修改
plumb events T-42 --pretty

# 验证完成
pnpm build && plumb verify T-50 --result pass
```

---

## 12. 退出码与错误处理

| 退出码 | 含义 | 典型场景 |
|--------|------|---------|
| `0` | 成功 | — |
| `2` | 入参校验失败 / 非法 SQL | 缺少必填参数、状态值拼写错误、传入 UPDATE SQL |
| `3` | 业务冲突 | blocks 环检测失败、删除含子任务的任务、batch-update 中某条失败、undo 已撤销的操作 |
| `4` | 资源不存在 | 查询/更新不存在的 `T-N`、undo 不存在的 op_id |

所有错误输出到 **stderr**，JSON 格式：

```json
{
  "error": {
    "code": "CYCLE",
    "message": "Cycle detected: T-3→T-1→T-2→T-3",
    "cycle_path": "T-3→T-1→T-2→T-3"
  }
}
```

---

## 13. 数据模型速查

### 核心表结构（v3）

```sql
-- 唯一真相：append-only 事件日志
events (
  id          TEXT    -- nanoid 主键
  seq         INTEGER -- 单调递增，重放顺序
  ts          TEXT    -- UTC ISO8601
  entity      TEXT    -- issue|edge|inbox
  entity_id   TEXT    -- 对应实体主键
  type        TEXT    -- create|update|state_change|description_change|delete|link|unlink|resolve|verify_run
  field       TEXT    -- update 时变更的字段名
  old         TEXT    -- JSON 编码旧值
  new         TEXT    -- JSON 编码新值
  actor       TEXT    -- user|agent:<name>|system
  reason      TEXT    -- 操作理由
  raw_input   TEXT    -- 产生此操作的原始用户话语
  conf        REAL    -- 0..1 置信度；null = 确定
  session_id  TEXT    -- 关联会话
  op_id       TEXT    -- 幂等键
)

-- 投影：当前态（可由 events 重建）
issues (
  id          TEXT    -- nanoid 主键
  seq         INTEGER -- T-N 人类别名
  title       TEXT    -- 标题
  state       TEXT    -- backlog|todo|in_progress|done|canceled
  priority    TEXT    -- urgent|high|medium|low|none
  project     TEXT    -- 可选分组
  parent_id   TEXT    -- 父任务 id
  labels      TEXT    -- JSON 数组 ["work","q4"]
  attrs       TEXT    -- 开放属性 JSON（Agent 自定义维度）
  field_meta  TEXT    -- 每字段 provenance 快照 JSON
  start_ts    TEXT    -- UTC 精确开始时刻
  due_ts      TEXT    -- UTC 精确截止时刻
  due_tz      TEXT    -- IANA 时区（Asia/Shanghai 等）
  due_date    TEXT    -- 派生本地 YYYY-MM-DD（兼容/人类可读）
  rrule       TEXT    -- 重复规则子集
  snooze_until TEXT   -- UTC；推迟到期前不出现在 actionable
  done_at     TEXT    -- UTC，系统自动维护
  created_at  TEXT    -- UTC ISO8601
  updated_at  TEXT    -- UTC ISO8601
  desc_hash   TEXT    -- CAS 内容寻址：data/descriptions/{hash}.md
  verify      TEXT    -- 验收标准 JSON（type: command|manual）
  deleted     INTEGER -- tombstone（0/1），issues_live 视图过滤
)

-- 读路径：过滤 tombstone
issues_live AS SELECT * FROM issues WHERE deleted = 0

-- 图边（开放类型/带权重/带时效）
edges (
  id          TEXT    -- nanoid 主键
  source_id   TEXT    -- 源任务
  target_id   TEXT    -- 目标任务
  type        TEXT    -- 开放词表：blocks|relates|duplicate|needs|...
  weight      REAL    -- 默认 1.0
  valid_from  TEXT    -- UTC，生效时刻
  valid_to    TEXT    -- UTC，失效时刻（null = 当前有效）
  created_at  TEXT
)

-- 原始捕获队列
inbox (
  id                 TEXT    -- nanoid
  raw                TEXT    -- 原始文本
  status             TEXT    -- pending|resolved
  resolved_issue_id  TEXT    -- 关联任务 id（可选）
  origin             TEXT    -- cli|voice|paste|import
  session_id         TEXT
  created_at         TEXT
)
```

### 关键规则

- **blocks 方向**：`(source_id, target_id, 'blocks')` = source 阻塞 target
  - "B 等 A 做完" → `plumb link A B --type blocks`（A 是 source）
- **relates/duplicate**：对称关系，查询时双向匹配
- **labels**：JSON 数组，查询时用 `json_each(labels)`，不要用 `LIKE '%tag%'`
- **时间格式**：`created_at/updated_at/done_at/due_ts/start_ts` 均为 UTC ISO8601；`due_date` 为本地 `YYYY-MM-DD`（派生字段）
- **读路径默认用 `issues_live`** 视图，过滤已删除任务

---

## 14. 常见场景示例

### 场景 1：完整任务生命周期（含验收）

```bash
# 1. 创建，含验收标准
plumb issue create \
  --title "重构用户认证模块" \
  --priority high \
  --due-date 2026-10-31 \
  --labels "work,backend" \
  --verify '{"type":"command","cmd":"pnpm test auth","expect":"exit 0"}'

# 2. 拆分子任务，建 blocks 依赖
plumb issue create --title "编写单元测试" --parent T-20   # T-21
plumb issue create --title "更新 API 文档" --parent T-20  # T-22
plumb link T-21 T-22 --type blocks  # 先写测试，再写文档

# 3. 开始工作
plumb issue update T-20 --state in_progress

# 4. 完成子任务，验证
pnpm test auth && plumb verify T-21 --result pass
plumb issue update T-21 --state done
plumb issue update T-22 --state done

# 5. 完成父任务前验证
pnpm test auth && plumb verify T-20 --result pass --cmd "pnpm test auth"
plumb issue update T-20 --state done
```

### 场景 2：需求执行闭环

```bash
# 1. 捕获需求原文
plumb inbox add "实现 OAuth2 登录，支持 Google 和 GitHub，本月底上线"

# 2. Agent 拆分任务（带 session + raw_input）
SID="sess_$(date +%s)"
plumb issue create --title "OAuth2 登录主任务" --priority high \
  --session "$SID" --raw-input "实现 OAuth2 登录，支持 Google 和 GitHub，本月底上线"

plumb issue create --title "Google OAuth 集成" --parent T-60 \
  --verify '{"type":"command","cmd":"pnpm test oauth-google","expect":"exit 0"}' \
  --session "$SID"

plumb issue create --title "GitHub OAuth 集成" --parent T-60 \
  --verify '{"type":"command","cmd":"pnpm test oauth-github","expect":"exit 0"}' \
  --session "$SID"

# 3. 资源请求（需要用户提供 Client ID/Secret）
plumb issue create --title "提供 Google OAuth Client ID/Secret" --state todo  # T-63
plumb link T-61 T-63 --type needs

# 4. 查看 awaiting_user（snapshot 第七组）
plumb snapshot --pretty

# 5. 用户提供凭证后，完成供给任务
plumb issue update T-63 --state done

# 6. 执行并验证
pnpm test oauth-google && plumb verify T-61 --result pass
plumb issue update T-61 --state done

# 7. 审计报告
plumb diff --since "$SID"
```

### 场景 3：撤销操作

```bash
# 误将任务标为 done
plumb issue update T-42 --state done

# 查找刚才操作的 op_id
OP=$(plumb events T-42 --limit 1 | jq -r '.[0].op_id')

# 撤销
plumb undo "$OP"

# 确认已恢复
plumb issue get T-42 --pretty
```

### 场景 4：周期性任务

```bash
# 创建每周五下午 4 点的周报任务
plumb issue create \
  --title "撰写周报" \
  --priority medium \
  --due-ts "2026-09-19T08:00:00.000Z" \
  --due-tz "Asia/Shanghai" \
  --rrule "FREQ=WEEKLY;INTERVAL=1" \
  --verify '{"type":"manual","note":"检查周报内容是否完整"}'

# 完成后自动推进到下周（系统自动执行）
plumb issue update T-70 --state done
# T-70 的 due_ts 自动推进 7 天，state 重置为 todo
```

### 场景 5：自定义 SQL 统计

```bash
# 本月完成了多少任务
plumb query "SELECT COUNT(*) FROM issues_live WHERE state = 'done' AND done_at >= '2026-09-01'"

# 各优先级任务分布
plumb query "SELECT priority, state, COUNT(*) FROM issues_live GROUP BY priority, state ORDER BY priority"

# 未验证的 done 任务（done_unverified）
plumb query "
  SELECT i.seq, i.title, e.new
  FROM issues_live i
  LEFT JOIN (
    SELECT entity_id, new, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY seq DESC) rn
    FROM events WHERE type = 'verify_run'
  ) e ON e.entity_id = i.id AND e.rn = 1
  WHERE i.state = 'done'
    AND i.verify IS NOT NULL
    AND (e.new IS NULL OR json_extract(e.new, '$.result') != 'pass')
"

# 查看 readiness 最高的 10 个可执行任务（Agent 排序逻辑参考）
plumb query "
  SELECT seq, title, priority, due_date
  FROM issues_live
  WHERE state IN ('todo','in_progress')
  ORDER BY
    CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
    due_date ASC NULLS LAST
  LIMIT 10
"
```

---

## 附录：命令速查表

| 命令 | 功能 |
|------|------|
| `plumb issue create` | 创建任务 |
| `plumb issue get <id>` | 查看任务详情（含派生字段/verify/field_meta） |
| `plumb issue list` | 列表查询 |
| `plumb issue update <id>` | 更新任务字段（patch 语义） |
| `plumb issue delete <id>` | 删除任务（tombstone） |
| `plumb issue batch-update --stdin` | 批量更新（原子事务） |
| `plumb link <src> <tgt> --type <t>` | 建立任务关系（开放词表） |
| `plumb unlink <src> <tgt> --type <t>` | 删除任务关系（软删除） |
| `plumb deps <id> [--type <t>]` | 查询依赖树（支持类型过滤） |
| `plumb snapshot` | 今日七组聚合摘要（含 readiness/awaiting_user/done_unverified） |
| `plumb board` | 五列文本看板 |
| `plumb search <q>` | 全文搜索（标题 + CAS description） |
| `plumb inbox add` | 加入原始捕获队列 |
| `plumb inbox list` | 查看 inbox 列表 |
| `plumb inbox resolve <id>` | 处理 inbox 条目 |
| `plumb events <id>` | 查看实体事件历史 |
| `plumb diff --since <ts\|op_id>` | 查看自某时刻以来的变更 |
| `plumb undo <op_id>` | 撤销操作（追加补偿事件） |
| `plumb rebuild` | 从事件流重建投影 |
| `plumb verify <id> --result pass\|fail` | 记录验证结果（verify_run 事件） |
| `plumb gc` | 清理无引用 CAS blob |
| `plumb query "<sql>"` | 只读 SQL 查询（默认读 issues_live） |
| `plumb schema` | 查看数据库结构（含事件语义/派生公式） |
| `plumb backup` | 创建数据库备份（VACUUM INTO） |
| `plumb version` | 查看版本号 |
| `plumb --help` | 查看帮助 |

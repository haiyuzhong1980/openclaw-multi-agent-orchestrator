# OMA (OpenClaw Multi-Agent Orchestrator) 功能描述

**版本**: v3.1.0
**更新日期**: 2026-03-21
**位置**: `~/.openclaw/extensions/multi-agent-orchestrator/`

---

## 一、概述

OMA 是 OpenClaw 的多 Agent 编排扩展，提供任务分解、Agent 协调、执行策略控制、跨 Agent 通信等核心能力。

### 核心能力

| 能力 | 说明 |
|------|------|
| **任务分解** | 将复杂请求分解为多个 research track |
| **Agent 编排** | 创建项目、分配任务、协调多 Agent 协作 |
| **执行策略** | Enforcement Ladder 自适应执行控制 |
| **跨 Agent 通信** | 邮箱系统支持 Agent 间消息传递 |
| **模板系统** | TOML 格式的可扩展任务模板 |
| **状态监控** | 守护脚本实时评估系统健康状态 |

---

## 二、命令列表

### 2.1 任务管理

| 命令 | 用途 |
|------|------|
| `/mao-board` | 显示任务看板 (所有项目和任务) |
| `/mao-project <id>` | 查看指定项目详情 |
| `/mao-task-create` | 创建新任务 |
| `/mao-task-update` | 更新任务状态 |
| `/mao-task-dependencies <taskId>` | 查看任务依赖关系 |
| `/mao-task-block <taskId> --by <otherId>` | 设置任务阻塞关系 |

### 2.2 消息系统

| 命令 | 用途 |
|------|------|
| `/mao-inbox` | 查看待处理消息 |
| `/mao-inbox-send <toAgent> <message>` | 发送消息给其他 Agent |
| `/mao-inbox-done <messageId>` | 标记消息已处理 |
| `/mao-inbox-history [limit]` | 查看已处理消息历史 |

### 2.3 模板系统

| 命令 | 用途 |
|------|------|
| `/mao-templates` | 列出内置模板 |
| `/mao-template <id>` | 查看模板详情 |
| `/mao-toml-templates` | 列出 TOML 模板 |
| `/mao-toml-template <id>` | 查看 TOML 模板详情 |
| `/mao-toml-validate <file>` | 验证 TOML 模板文件 |
| `/mao-template-create <id>` | 交互式创建 TOML 模板 |

### 2.4 执行策略

| 命令 | 用途 |
|------|------|
| `/mao-enforce` | 显示当前执行策略状态 |
| `/mao-evolution` | 运行演进周期 (自动调整策略) |
| `/mao-evolution-history` | 查看演进历史 |
| `/mao-enforcement-status` | 详细的 Enforcement Ladder 状态 |

### 2.5 审计与监控

| 命令 | 用途 |
|------|------|
| `/mao-audit` | 显示最近审计日志 |
| `/mao-state` | 显示当前会话状态 |
| `/mao-review` | 审查当前项目结果 |
| `/mao-stats` | 显示统计信息 |
| `/mao-intents` | 显示意图注册表 |

### 2.6 辅助命令

| 命令 | 用途 |
|------|------|
| `/mao-agents` | 列出可用 Agent 类型 |
| `/mao-agent-search <query>` | 搜索 Agent |
| `/mao-observation` | 显示观察日志摘要 |
| `/mao-patterns` | 显示发现的模式 |
| `/mao-suggest` | 显示建议 |

---

## 三、Tool Action

OMA 提供一个统一的 Tool，支持以下 action：

### `plan_tracks`
将请求分解为多个 research track。

**参数**:
```typescript
{
  action: "plan_tracks",
  request: string,           // 用户请求
  agentType?: string,        // Agent 类型筛选
  agentCategory?: string,    // Agent 分类筛选
  customTracks?: Array<{     // 自定义 track
    trackId: string,
    label: string,
    goal: string
  }>,
  templateIds?: string[],    // TOML 模板 ID
  ofmsSharedRoot?: string    // OFMS 共享目录
}
```

### `orchestrate`
创建多 Agent 编排项目。

**参数**:
```typescript
{
  action: "orchestrate",
  request: string,
  projectId?: string,
  agents?: Array<{
    name: string,
    type: string,
    task: string
  }>,
  tasks?: Array<{
    subject: string,
    owner: string,
    blockedBy?: string[]
  }>,
  templateId?: string,       // TOML 模板 ID
  taskDependencies?: Array<{ // 任务依赖
    task: string,
    blockedBy: string[]
  }>
}
```

### `enforce_execution_policy`
执行策略检查，验证当前状态是否符合要求。

**参数**:
```typescript
{
  action: "enforce_execution_policy",
  request?: string,
  taskState?: string,
  hasTaskBus?: boolean,
  hasPlan?: boolean,
  hasCheckpoint?: boolean,
  hasWorkerStart?: boolean,
  hasTrackedExecution?: boolean,
  hasCompletedStep?: boolean,
  hasFinalMerge?: boolean,
  currentStep?: number,
  totalSteps?: number
}
```

### `validate_and_merge`
验证结果并合并到最终输出。

### `evolve`
运行演进周期，自动调整执行策略。

---

## 四、TOML 模板系统

### 4.1 模板结构

```toml
# 模板元数据
[template]
id = "template-id"
name = "Template Name"
description = "What this template does"

# Leader Agent (可选)
[template.leader]
name = "leader-name"
type = "agent-type"
task = """
Leader's task description.
Can span multiple lines.
"""

# Worker Agents
[[template.agents]]
name = "worker-1"
type = "agent-type"
task = "Worker task description"

[[template.agents]]
name = "worker-2"
type = "agent-type"
task = "Another task"

# 任务定义
[[template.tasks]]
subject = "First task"
owner = "worker-1"

[[template.tasks]]
subject = "Second task"
owner = "worker-2"
blockedBy = ["First task"]  # 等待第一个任务完成
```

### 4.2 内置模板

| 模板 ID | 用途 | Agents |
|---------|------|--------|
| `code-review-team` | 多视角代码审查 | leader + security-reviewer + performance-reviewer + style-reviewer |
| `security-audit` | 安全漏洞审计 | security-lead + vulnerability-scanner + code-auditor |
| `performance-review` | 性能瓶颈分析 | performance-lead + bottleneck-analyzer + memory-analyzer |
| `dependency-audit` | 依赖安全/许可证审计 | dep-auditor + license-checker + health-checker |
| `competitive-analysis` | 竞品分析 | analyst-lead |
| `documentation-review` | 文档质量审查 | docs-reviewer |
| `market-research` | 市场趋势研究 | market-researcher |
| `github-issues` | GitHub 议题研究 | issues-researcher |
| `ops-health-check` | 运维健康检查 | ops-lead + service-checker + resource-monitor |

### 4.3 自定义模板

用户可在 `~/.openclaw/templates/` 目录创建自定义模板：

```bash
# 创建新模板
/mao-template-create my-custom-review

# 验证模板
/mao-toml-validate ~/.openclaw/templates/my-custom-review.toml

# 使用模板
# 在 plan_tracks 或 orchestrate 中指定 templateId: "my-custom-review"
```

---

## 五、跨 Agent 通信层

### 5.1 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      OMA Communication                       │
│                                                             │
│  ┌─────────────┐    ┌─────────────────┐    ┌───────────┐  │
│  │ Mailbox API │───▶│ MailboxManager  │───▶│ Transport │  │
│  │ /mao-inbox  │    │ send/receive    │    │ File      │  │
│  └─────────────┘    └─────────────────┘    └───────────┘  │
│                                                            │
│  存储: ~/.openclaw/shared-memory/inbox/{team}/{agent}/     │
│        ├── pending/    (待处理消息)                        │
│        ├── processed/  (已处理消息)                        │
│        └── events.log  (事件日志)                          │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 消息类型

```typescript
enum MessageType {
  message = "message",              // 普通消息
  join_request = "join_request",    // 加入团队请求
  join_approved = "join_approved",  // 加入批准
  plan_approval_request = "plan_approval_request",  // 计划审批请求
  plan_approved = "plan_approved",  // 计划批准
  task_blocked = "task_blocked",    // 任务阻塞通知
  task_completed = "task_completed", // 任务完成通知
  shutdown_request = "shutdown_request", // 关闭请求
  broadcast = "broadcast",          // 广播消息
}
```

### 5.3 使用示例

```bash
# 发送消息
/mao-inbox-send security-reviewer "请检查 src/auth.ts 中的认证逻辑"

# 查看收件箱
/mao-inbox

# 标记已处理
/mao-inbox-done msg-abc123

# 查看历史
/mao-inbox-history 50
```

---

## 六、任务依赖系统

### 6.1 数据结构

```typescript
interface Task {
  id: string;
  subject: string;
  status: "pending" | "dispatched" | "running" | "done" | "failed";
  owner: string;

  // 依赖关系
  blockedBy: string[];  // 等待这些 taskId 完成
  blocks: string[];     // 阻塞这些 taskId

  // 锁定机制
  lockedBy: string;     // 当前锁定的 agentId
  lockedAt: string;     // 锁定时间戳
}
```

### 6.2 依赖操作

```bash
# 查看任务依赖
/mao-task-dependencies task-001

# 设置阻塞关系
/mao-task-block task-002 --by task-001
```

### 6.3 依赖检测

- **阻塞检测**: `isTaskBlocked()` 检查任务是否被阻塞
- **循环检测**: `detectDependencyCycle()` 检测依赖循环
- **下游获取**: `getDownstreamTasks()` 获取所有下游任务

---

## 七、执行策略 (Enforcement Ladder)

### 7.1 级别定义

| 级别 | 名称 | 触发条件 | 行为 |
|------|------|----------|------|
| 0 | Observational | 初始状态 | 仅观察，无强制 |
| 1 | Advisory | ≥50 观察记录 | 给出建议提示 |
| 2 | Enforced | ≥100 观察记录 + 准确率>80% | 强制执行策略 |
| 3 | Strict | ≥200 观察记录 + 准确率>90% | 严格模式，每次操作需验证 |

### 7.2 自适应调整

- **升级条件**: 观察记录达到阈值 + 准确率达标
- **降级条件**: 连续 3 天误判
- **冷却期**: 24 小时内不可连续升降

### 7.3 演进周期

运行 `/mao-evolution` 触发演进周期：
1. 分析最近观察记录
2. 计算准确率和改进空间
3. 调整执行策略级别
4. 记录演进报告

---

## 八、守护监控脚本

### 8.1 位置

```
~/.openclaw/scripts/oma-watchdog.ts
~/.openclaw/scripts/oma-status (启动器)
```

### 8.2 用法

```bash
# 单次评估
oma-status

# 持续监控 (每30秒刷新)
oma-status --watch

# 自定义刷新间隔 (每10秒)
oma-status --watch 10

# JSON 格式输出
oma-status --json
```

### 8.3 监控指标

| 指标 | 数据源 | 说明 |
|------|--------|------|
| 执行策略级别 | enforcement-state.json | Enforcement Ladder 当前级别 |
| 观察日志统计 | observation-log.jsonl | 总数/24h/派遣比例 |
| 演进周期 | evolution-history.json | 运行次数/平均改进 |
| 意图注册 | intent-registry.json | 已注册意图数/Top 5 |
| 消息队列 | inbox/ | 待处理/已处理/团队 |
| 任务状态 | orchestrator/tasks/ | 进行中/完成/失败 |

### 8.4 健康评分

```
基础分: 100

扣分项:
- 执行级别 < 1: -20
- 连续降级 > 3天: -15
- 24h无观察: -15
- 派遣比例 > 50%: -10
- 消息积压 > 100: -10
- 失败任务 > 完成任务: -15

状态:
- 80-100: HEALTHY ✅
- 50-79:  WARNING ⚠️
- 0-49:   CRITICAL 🚨
```

---

## 九、API 集成

### 9.1 作为 OpenClaw 插件

OMA 通过 OpenClaw 插件系统集成：

```json
// openclaw.json
{
  "extensions": [
    "./extensions/multi-agent-orchestrator/index.ts"
  ]
}
```

### 9.2 与 OAG 集成

OMA 与 OAG (Observability & Anomaly Gateway) 共享状态：

- 观察日志: `~/.openclaw/shared-memory/observation-log.jsonl`
- 执行策略: `~/.openclaw/shared-memory/enforcement-state.json`
- 意图注册: `~/.openclaw/shared-memory/intent-registry.json`

---

## 十、文件结构

```
extensions/multi-agent-orchestrator/
├── index.ts                 # 入口，命令注册
├── src/
│   ├── tool.ts              # Tool action 实现
│   ├── task-board.ts        # 任务看板
│   ├── mailbox.ts           # 邮箱管理器
│   ├── transport.ts         # 传输层 (FileTransport)
│   ├── message-manager.ts   # 消息管理
│   ├── toml-parser.ts       # TOML 解析器
│   ├── track-templates.ts   # 模板系统
│   ├── enforcement-ladder.ts # 执行策略
│   ├── evolution-cycle.ts   # 演进周期
│   ├── hooks/
│   │   └── subagent-hooks.ts # Agent 生命周期钩子
│   └── ...
├── tests/                   # 测试文件
├── docs/
│   ├── OMA-UPGRADE-ROADMAP.md
│   └── OMA-TECHNICAL-GUIDE.md
└── package.json
```

---

## 十一、版本历史

| 版本 | 日期 | 主要更新 |
|------|------|----------|
| v3.1.0 | 2026-03-21 | M5-M8 全部完成，TOML 模板系统，跨 Agent 通信 |
| v3.0.0 | 2026-03-18 | Enforcement Ladder，演进周期 |
| v2.0.0 | 2026-03-10 | Task Board，项目编排 |
| v1.0.0 | 2026-03-05 | 初始版本，plan_tracks |

---

## 十二、参考文档

- **技术指南**: `docs/OMA-TECHNICAL-GUIDE.md`
- **升级路线图**: `docs/OMA-UPGRADE-ROADMAP.md`
- **README**: `README.md`
- **中文 README**: `README.zh-CN.md`

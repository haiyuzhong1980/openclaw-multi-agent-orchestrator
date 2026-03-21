# OMA 升级路线图 (v3.1.0)

> 基于 ClawTeam 功能对比分析，规划 OMA 下一代升级

---

## 里程碑概览

| 里程碑 | 周期 | 核心目标 |
|--------|------|---------|
| **M5** | 1 周 | 任务依赖链 + 锁定机制 |
| **M6** | 1 周 | Agent 身份系统 + 消息类型扩展 |
| **M7** | 2 周 | 跨 Agent 通信层 |
| **M8** | 1 周 | 模板系统升级 (TOML 支持) |

---

## M5: 任务依赖链 + 锁定机制

### 背景

当前 OMA TaskBoard 缺少任务依赖关系表达，无法实现：
- "任务 B 等待任务 A 完成后才能开始"
- "任务 C 阻塞了任务 D 和 E"

ClawTeam 已有成熟实现：`blocked_by` / `blocks` + 任务锁定。

### 任务清单

| ID | 任务 | 优先级 | 依赖 | 状态 |
|----|------|--------|------|------|
| M5-01 | 扩展 Task 类型添加 `blockedBy: string[]` 字段 | P0 | - | ⏳ |
| M5-02 | 扩展 Task 类型添加 `blocks: string[]` 字段 | P0 | - | ⏳ |
| M5-03 | 扩展 Task 类型添加 `lockedBy: string` 字段 | P0 | - | ⏳ |
| M5-04 | 扩展 Task 类型添加 `lockedAt: string` 字段 | P0 | - | ⏳ |
| M5-05 | 实现 `isTaskBlocked(task): boolean` 函数 | P0 | M5-01 | ⏳ |
| M5-06 | 实现 `acquireTaskLock(task, agentId): boolean` 函数 | P0 | M5-03 | ⏳ |
| M5-07 | 实现 `releaseTaskLock(task): void` 函数 | P0 | M5-03 | ⏳ |
| M5-08 | 修改 `updateTaskStatus()` 检查依赖是否满足 | P0 | M5-05 | ⏳ |
| M5-09 | 修改 `updateTaskStatus()` 自动解除下游阻塞 | P0 | M5-08 | ⏳ |
| M5-10 | 添加 `/mao-task-dependencies <taskId>` 命令 | P1 | M5-08 | ⏳ |
| M5-11 | 添加 `/mao-task-block <taskId> --by <otherTaskId>` 命令 | P1 | M5-08 | ⏳ |
| M5-12 | 扩展 `orchestrate` action 支持 `taskDependencies` 参数 | P1 | M5-08 | ⏳ |
| M5-13 | 更新 TaskBoard 存储格式向后兼容 | P0 | M5-01~04 | ⏳ |
| M5-14 | 编写依赖链单元测试 (阻塞/解除/循环检测) | P0 | M5-08 | ⏳ |
| M5-15 | 更新文档 `OMA-TECHNICAL-GUIDE.md` | P2 | M5-14 | ⏳ |

### 数据结构变更

```typescript
// 扩展前
interface Task {
  id: string;
  status: TaskStatus;
  // ...
}

// 扩展后
interface Task {
  id: string;
  status: TaskStatus;
  blockedBy: string[];     // 等待这些 taskId 完成
  blocks: string[];        // 阻塞这些 taskId
  lockedBy: string;        // 当前锁定的 agentId
  lockedAt: string;        // 锁定时间戳
  // ...
}
```

### 新增函数

```typescript
// src/task-board.ts

/** 检查任务是否被阻塞（依赖任务未完成） */
export function isTaskBlocked(board: TaskBoard, task: Task): boolean;

/** 尝试获取任务锁，返回是否成功 */
export function acquireTaskLock(board: TaskBoard, taskId: string, agentId: string): boolean;

/** 释放任务锁 */
export function releaseTaskLock(board: TaskBoard, taskId: string): void;

/** 获取任务的所有下游任务 */
export function getDownstreamTasks(board: TaskBoard, taskId: string): Task[];

/** 检测依赖循环 */
export function detectDependencyCycle(board: TaskBoard, taskId: string): string[] | null;
```

---

## M6: Agent 身份系统 + 消息类型扩展

### 背景

当前 OMA 的 Agent 身份信息分散，Preamble 注入的 agent 信息不完整。
ClawTeam 有成熟的 `AgentIdentity` 数据类和丰富的消息类型。

### 任务清单

| ID | 任务 | 优先级 | 依赖 | 状态 |
|----|------|--------|------|------|
| M6-01 | 创建 `AgentIdentity` 类型定义 | P0 | - | ⏳ |
| M6-02 | 在 PluginState 中添加 `agentIdentity: AgentIdentity` | P0 | M6-01 | ⏳ |
| M6-03 | 修改 `buildUnifiedPreamble()` 注入完整身份信息 | P0 | M6-02 | ⏳ |
| M6-04 | 创建 `MessageType` 枚举 (message, join_request, plan_approval, etc.) | P0 | - | ⏳ |
| M6-05 | 创建 `TeamMessage` 类型定义 | P0 | M6-04 | ⏳ |
| M6-06 | 扩展 `subagent_spawned` hook 支持消息类型 | P1 | M6-05 | ⏳ |
| M6-07 | 扩展 `subagent_ended` hook 支持消息类型 | P1 | M6-05 | ⏳ |
| M6-08 | 添加 `/mao-inbox-send <toAgent> <message>` 命令 | P1 | M6-05 | ⏳ |
| M6-09 | 添加 `/mao-inbox-receive` 命令 | P1 | M6-05 | ⏳ |
| M6-10 | 实现消息持久化到 `~/.openclaw/shared-memory/inbox/` | P1 | M6-05 | ⏳ |
| M6-11 | 编写身份系统单元测试 | P0 | M6-03 | ⏳ |
| M6-12 | 编写消息系统单元测试 | P0 | M6-10 | ⏳ |

### 数据结构定义

```typescript
// src/identity.ts

export interface AgentIdentity {
  agentId: string;         // 唯一标识
  agentName: string;       // 显示名称
  agentType: string;       // 类型: "leader" | "worker" | "reviewer" | ...
  teamName: string | null; // 所属团队
  isLeader: boolean;       // 是否是 Leader
  joinedAt: string;        // 加入时间
}

// src/message.ts

export enum MessageType {
  message = "message",
  join_request = "join_request",
  join_approved = "join_approved",
  plan_approval_request = "plan_approval_request",
  plan_approved = "plan_approved",
  task_blocked = "task_blocked",
  task_completed = "task_completed",
  shutdown_request = "shutdown_request",
  broadcast = "broadcast",
}

export interface TeamMessage {
  id: string;
  type: MessageType;
  from: string;           // 发送者 agentId
  to: string | null;      // 接收者 agentId，null = broadcast
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
```

---

## M7: 跨 Agent 通信层

### 背景

当前 OMA 的 Agent 间通信依赖 OpenClaw SDK 事件，功能有限。
ClawTeam 有完整的 Mailbox + P2P (ZeroMQ) 通信层。

### 任务清单

| ID | 任务 | 优先级 | 依赖 | 状态 |
|----|------|--------|------|------|
| M7-01 | 设计 OMA 通信层抽象接口 `Transport` | P0 | - | ⏳ |
| M7-02 | 实现 `FileTransport` (文件系统消息队列) | P0 | M7-01 | ⏳ |
| M7-03 | 实现 `MailboxManager` (收发消息管理) | P0 | M7-02 | ⏳ |
| M7-04 | 实现消息确认机制 (ACK) | P1 | M7-03 | ⏳ |
| M7-05 | 实现消息过期清理 | P2 | M7-03 | ⏳ |
| M7-06 | 集成到 `subagent_hooks` (自动接收消息) | P0 | M7-03 | ⏳ |
| M7-07 | 扩展 Preamble 注入通信指令 | P0 | M7-06 | ⏳ |
| M7-08 | 添加 `/mao-inbox-pending` 查看待处理消息 | P1 | M7-03 | ⏳ |
| M7-09 | 添加 `/mao-inbox-history` 查看消息历史 | P2 | M7-03 | ⏳ |
| M7-10 | 可选: 实现 `P2PTransport` (ZeroMQ) | P3 | M7-01 | ⏳ |
| M7-11 | 编写通信层单元测试 | P0 | M7-03 | ⏳ |
| M7-12 | 编写集成测试 (Agent A 发消息给 Agent B) | P1 | M7-06 | ⏳ |

### 通信层架构

```
┌─────────────────────────────────────────────────────────────┐
│                      OMA Communication                       │
│                                                             │
│  ┌─────────────┐    ┌─────────────────┐    ┌───────────┐  │
│  │ Mailbox API │───▶│ MailboxManager  │───▶│ Transport │  │
│  │ /mao-inbox  │    │ send/receive    │    │ File/P2P  │  │
│  └─────────────┘    └─────────────────┘    └───────────┘  │
│                                                            │
│  存储: ~/.openclaw/shared-memory/inbox/{team}/{agent}/     │
│        ├── pending/    (待处理消息)                        │
│        ├── processed/  (已处理消息)                        │
│        └── events.log  (事件日志)                          │
└─────────────────────────────────────────────────────────────┘
```

---

## M8: 模板系统升级 (TOML 支持)

### 背景

当前 OMA 使用 TypeScript 定义模板，用户无法自定义。
ClawTeam 使用 TOML 模板，用户可轻松创建和分享。

### 任务清单

| ID | 任务 | 优先级 | 依赖 | 状态 |
|----|------|--------|------|------|
| M8-01 | 设计 TOML 模板 Schema | P0 | - | ⏳ |
| M8-02 | 实现 TOML 解析器 (使用 `@iarna/toml`) | P0 | M8-01 | ⏳ |
| M8-03 | 实现 TOML 模板加载器 | P0 | M8-02 | ⏳ |
| M8-04 | 转换现有 10 个 TypeScript 模板为 TOML | P0 | M8-03 | ⏳ |
| M8-05 | 支持 `~/.openclaw/templates/` 自定义模板目录 | P1 | M8-03 | ⏳ |
| M8-06 | 添加 `/mao-template-create` 命令 (交互式创建) | P2 | M8-05 | ⏳ |
| M8-07 | 添加 `/mao-template-validate <file>` 命令 | P1 | M8-03 | ⏳ |
| M8-08 | 更新 `plan_tracks` action 支持 TOML 模板 | P0 | M8-03 | ⏳ |
| M8-09 | 编写模板系统单元测试 | P0 | M8-04 | ⏳ |
| M8-10 | 创建模板示例文档 | P2 | M8-04 | ⏳ |

### TOML 模板示例

```toml
# ~/.openclaw/templates/code-review.toml

[template]
id = "code-review"
name = "Code Review Team"
description = "Multi-perspective code review with security focus"

[template.leader]
name = "review-lead"
type = "code-reviewer"
task = """
你是代码审查团队的 Leader。组织审查工作：
1. 使用 `mao-task-create` 分配审查任务
2. 收集各方反馈
3. 汇总审查报告
"""

[[template.agents]]
name = "security-reviewer"
type = "security-reviewer"
task = """
你是安全审查专家。检查：
- SQL 注入
- XSS 漏洞
- 敏感信息泄露
"""

[[template.agents]]
name = "performance-reviewer"
type = "performance-reviewer"
task = """
你是性能审查专家。检查：
- 时间复杂度
- 内存泄漏
- N+1 查询
"""

[[template.tasks]]
subject = "Security review"
owner = "security-reviewer"

[[template.tasks]]
subject = "Performance review"
owner = "performance-reviewer"
blockedBy = ["Security review"]  # 等待安全审查完成
```

---

## 积压优化 (已有代码清理)

| ID | 任务 | 优先级 | 说明 |
|----|------|--------|------|
| B01 | 拆分 `index.ts` (689 行) | P2 | 按命令分组拆分 |
| B02 | 拆分 `src/tool.ts` (350+ 行) | P2 | 按 action 拆分 |
| B03 | 拆分 `src/task-board.ts` (350+ 行) | P2 | 拆分状态机逻辑 |
| B04 | 异步化 AI 引擎调用 | P1 | 避免阻塞 Hook |

---

## 总体进度追踪

```
M5: [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ]  0/15
M6: [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ]            0/12
M7: [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ]       0/12
M8: [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ] [ ]               0/10
B:  [ ] [ ] [ ] [ ]                                            0/4

总计: 0/53 任务
```

---

## 版本规划

| 版本 | 里程碑 | 发布日期 |
|------|--------|---------|
| v3.1.0 | M5 | 2026-03-28 |
| v3.2.0 | M5 + M6 | 2026-04-04 |
| v3.3.0 | M5 + M6 + M7 | 2026-04-18 |
| v4.0.0 | M5-M8 全部完成 | 2026-04-25 |

---

*文档版本: v1.0.0 / 创建时间: 2026-03-21*

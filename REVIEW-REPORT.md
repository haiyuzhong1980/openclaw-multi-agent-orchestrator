# OpenClaw Multi-Agent Orchestrator (OMA) 插件审查报告

**审查日期**: 2026-03-22
**审查工具**: Hermes Agent 子代理 × 3 + Codex CLI 交叉确认
**项目**: `~/.openclaw/extensions/multi-agent-orchestrator`
**规模**: 42 个 TypeScript 文件，~8465 行

---

## 项目概述

**OpenClaw Multi-Agent Orchestrator (OMA) v3.0.0** — 自进化的多 Agent 编排系统

核心功能：
- 三级意图识别 (light/tracked/delegation)
- 任务调度与状态机管理
- 模式学习与自进化
- 跨进程消息传输

---

## 严重问题 (P0) - 必须立即修复

### 1. 任务锁竞态条件 (Codex 确认)

**文件**: `src/task-board.ts:486-506`

```typescript
// 问题代码
if (task.lockedBy && task.lockedBy !== agentId) {
  return false;
}
// 竞态窗口：另一个 agent 可能已获取锁
task.lockedBy = agentId;
```

**Codex 分析**:
- 单进程单事件循环场景：基本可用，但不算严格线程安全
- 多线程、多进程、多实例共享 board 文件场景：**不安全**

**附加问题**:
- `releaseTaskLock` 没有校验持锁者，任何调用方都能解别人的锁

**修复建议**: 使用 CAS (Compare-And-Swap) 或乐观锁

---

### 2. Board 读写竞态 (Codex 确认)

**文件**: `src/tool.ts:176,244`, `src/task-board.ts`

```typescript
// 典型 read-modify-write 竞态
const board = loadBoard(sharedRoot);
// ... 修改 board ...
saveBoard(sharedRoot, board); // 可能覆盖其他进程的修改
```

**影响**: 多进程同时操作会丢失数据

**修复建议**: 实现 `board.version` 乐观锁检查

---

### 3. 消息处理竞态条件 (Codex 确认)

**文件**: `src/transport.ts:180,211`, `src/mailbox.ts:102`

```typescript
// TOCTOU 竞态
if (!existsSync(pendingFile)) return false;
renameSync(pendingFile, processedFile); // 非原子操作
```

**Codex 分析**:
- `receive()` 不占有消息，多个进程可同时读到同一消息
- `ack()` 的 `existsSync + renameSync` 是典型 TOCTOU
- **没有文件锁或等价并发保护**

**修复建议**: 添加文件锁或原子 claim 目录机制

---

### 4. 数据持久化漏洞 (Codex 确认)

**文件**: `src/observation-engine.ts`

**问题**: `updateObservationFeedback()` 和 `updateObservationOutcome()`
- 只修改内存对象并设置 `bufferDirty = true`
- 实际写盘要等 `flushBuffer()`
- `flushBuffer()` 基本只在 `process.on("exit")` 触发

**影响**: 进程异常退出、被强杀时，feedback/outcome 更新会丢失

---

### 5. ProjectStatus 状态机不完整

**文件**: `src/task-board.ts:211-266`

**问题**: 定义了 7 种状态，但 `advanceProjectStatus` 只处理了 5 种
- 完全忽略了 `"planning"` 和 `"dispatching"` 状态

---

## 重要问题 (P1)

| 问题 | 文件 | 影响 |
|------|------|------|
| `updateTaskStatus` 静默失败 | task-board.ts:172-177 | 调用方无法感知操作失败 |
| `loadBoard` 错误时丢失数据 | task-board.ts:83-85 | JSON 解析失败返回空 board |
| 任务依赖添加失败静默跳过 | tool.ts:229-239 | 返回值未检查 |
| 静默吞掉所有错误 | transport.ts 多处 | 无法追踪问题 |
| ACK 失败后消息状态未知 | transport.ts | 消息可能丢失 |
| 缺少否定学习机制 | observation-engine.ts | 无法从正确反馈中学习 |
| 模式冲突未处理 | intent-registry.ts:192-225 | 多模式匹配时仅返回第一个 |

---

## 一般问题 (P2)

| 问题 | 文件 | 影响 |
|------|------|------|
| 中文分词精度不足 | intent-registry.ts, pattern-discovery.ts | 2-6字符窗口产生无语义组合 |
| 置信度阈值硬编码 | intent-registry.ts:204-206 | 缺乏自适应能力 |
| 全量数据加载 | observation-engine.ts:254-276 | 性能瓶颈 |
| 代码重复 | transport.ts vs message-manager.ts | `generateMessageId` 等重复实现 |
| 同步 I/O 阻塞 | transport.ts | `writeFileSync` 阻塞主线程 |
| 缺少测试 | tests/ | transport, message-manager, oag-bridge 无测试 |

---

## 安全性问题

| 风险 | 描述 |
|------|------|
| 路径注入 | `agentId`, `teamName` 直接拼接路径，无校验 |
| 无认证 | 任何进程可读写消息文件 |
| 无消息签名 | 消息可被篡改 |

---

## 测试覆盖评估

| 模块 | 测试文件 | 覆盖率评估 |
|------|---------|-----------|
| task-board | tests/task-board.test.ts | 中等 |
| execution-policy | tests/execution-policy.test.ts | 良好 |
| observation-engine | tests/observation-engine.test.ts | 中等 |
| transport | **无** | 缺失 |
| message-manager | **无** | 缺失 |
| oag-bridge | tests/oag-bridge.test.ts | 存在 |

---

## 综合评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 任务调度逻辑 | 6/10 | 基本完整，边界情况不足 |
| 状态机完整性 | 4/10 | ProjectStatus 状态机有明显缺陷 |
| 错误处理机制 | 4/10 | 静默错误过多，无重试 |
| 并发安全性 | 3/10 | 多处竞态条件，需重新设计 |
| 数据持久化 | 5/10 | 存在丢失风险 |
| 测试覆盖 | 5/10 | 核心模块测试不足 |
| **综合** | **4.5/10** | 需要重大改进 |

---

## 修复优先级

### 立即修复 (本周)

1. 任务锁竞态条件 - 使用 CAS 或乐观锁
2. Board 读写竞态 - 实现 `version` 检查
3. 消息处理竞态 - 添加文件锁
4. 数据持久化漏洞 - 定时 flush 或写后立即持久化

### 短期改进 (本月)

1. 完善 ProjectStatus 状态机
2. 统一错误处理，添加结构化日志
3. 添加 transport/message-manager 测试
4. 实现否定学习机制

### 长期优化

1. 引入中文分词库
2. 异步 I/O 改造
3. 添加消息签名和认证
4. 动态阈值调整

---

## 审查方法

| 工具 | 模型 | 角色 |
|------|------|------|
| Hermes Agent × 3 | qianfan-code-latest | 并行初步审查 |
| Codex CLI | gpt-5.4 (本地) | 交叉确认关键问题 |

**审查时间**: 2026-03-22 20:20 - 20:45 (约 25 分钟)

---

*报告生成时间: 2026-03-22 20:45*

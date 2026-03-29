# OMA 插件修复任务清单

**项目**: `~/.openclaw/extensions/multi-agent-orchestrator`
**创建时间**: 2026-03-22 20:50
**预计工期**: 2-3 周

---

## P0 - 严重问题 (必须立即修复)

### TASK-001: 任务锁竞态条件修复
- **文件**: `src/task-board.ts:486-506`
- **问题**: `acquireTaskLock` 检查和设置不是原子操作
- **影响**: 多进程场景下任务锁失效
- **修复方案**: 
  - [ ] 实现乐观锁 (CAS) 机制
  - [ ] 添加 `lockVersion` 字段
  - [ ] `releaseTaskLock` 添加持锁者校验
- **预计时间**: 4h

### TASK-002: Board 读写竞态修复
- **文件**: `src/task-board.ts`, `src/tool.ts`
- **问题**: `loadBoard → 修改 → saveBoard` 非原子操作
- **影响**: 多进程同时操作会丢失数据
- **修复方案**:
  - [ ] 使用 `board.version` 实现乐观锁
  - [ ] 添加 `saveBoardWithVersionCheck()` 函数
  - [ ] 冲突时返回错误，由调用方决定重试或放弃
- **预计时间**: 3h

### TASK-003: 消息处理竞态修复
- **文件**: `src/transport.ts:180,211`, `src/mailbox.ts:102`
- **问题**: `receive()` 不占有消息，`ack()` 存在 TOCTOU
- **影响**: 消息重复处理或丢失
- **修复方案**:
  - [ ] 实现原子 claim 机制 (创建 `.claiming` 临时目录)
  - [ ] 或使用 `flock` 文件锁
  - [ ] `receive()` 返回时标记消息为 processing
- **预计时间**: 4h

### TASK-004: 数据持久化漏洞修复
- **文件**: `src/observation-engine.ts`
- **问题**: feedback/outcome 更新只在内存，flush 延迟到 exit
- **影响**: 进程崩溃时数据丢失
- **修复方案**:
  - [ ] `updateObservationFeedback()` 写后立即持久化
  - [ ] 或添加定时 flush (每 30 秒)
  - [ ] 添加 `flushOnUpdate` 配置项
- **预计时间**: 2h

### TASK-005: ProjectStatus 状态机修复
- **文件**: `src/task-board.ts:211-266`
- **问题**: `advanceProjectStatus` 忽略了 planning/dispatching 状态
- **影响**: 状态转换不完整，可能导致卡住
- **修复方案**:
  - [ ] 定义完整的状态转换表
  - [ ] 添加 `VALID_PROJECT_TRANSITIONS` 映射
  - [ ] 实现状态转换验证函数
- **预计时间**: 3h

---

## P1 - 重要问题 (尽快修复)

### TASK-006: 错误处理统一化
- **文件**: 多处
- **问题**: 静默吞掉错误，无法追踪
- **修复方案**:
  - [ ] 引入 `Result<T, E>` 类型
  - [ ] 替换所有 `catch {}` 为带日志的处理
  - [ ] 添加 `logger` 模块
- **预计时间**: 4h

### TASK-007: updateTaskStatus 返回值修复
- **文件**: `src/task-board.ts:172-177`
- **问题**: 任务被阻塞时静默返回，调用方无法感知
- **修复方案**:
  - [ ] 返回 `{ success: boolean, error?: string }`
  - [ ] 调用方检查返回值并处理
- **预计时间**: 1h

### TASK-008: loadBoard 数据保护
- **文件**: `src/task-board.ts:68-86`
- **问题**: JSON 解析失败返回空 board，丢失原有数据
- **修复方案**:
  - [ ] 解析失败时备份原文件到 `.bak`
  - [ ] 返回 `{ board: TaskBoard, error?: string }`
  - [ ] 记录错误日志
- **预计时间**: 2h

### TASK-009: 任务依赖添加校验
- **文件**: `src/tool.ts:229-239`
- **问题**: `addTaskDependency` 返回值未检查
- **修复方案**:
  - [ ] 检查返回值并处理失败情况
  - [ ] 添加重试机制
- **预计时间**: 1h

### TASK-010: 否定学习机制
- **文件**: `src/observation-engine.ts`, `src/intent-registry.ts`
- **问题**: 无法从正确反馈中学习
- **修复方案**:
  - [ ] 添加 `recordConfirmation()` 函数
  - [ ] 确认时增加模式置信度
- **预计时间**: 3h

### TASK-011: 模式冲突处理
- **文件**: `src/intent-registry.ts:192-225`
- **问题**: 多模式匹配时仅返回第一个
- **修复方案**:
  - [ ] 实现投票机制
  - [ ] 或加权融合多个匹配结果
- **预计时间**: 3h

---

## P2 - 一般问题 (后续优化)

### TASK-012: 中文分词优化
- **文件**: `src/pattern-discovery.ts`, `src/intent-registry.ts`
- **问题**: 2-6字符窗口产生无语义组合
- **修复方案**:
  - [ ] 引入轻量级分词库 (如 jieba-wasm 或词典)
  - [ ] 或改进 n-gram 策略
- **预计时间**: 4h

### TASK-013: 动态阈值调整
- **文件**: `src/intent-registry.ts:204-206`
- **问题**: 置信度阈值硬编码为 0.7
- **修复方案**:
  - [ ] 根据历史准确率动态调整
  - [ ] 添加配置项
- **预计时间**: 2h

### TASK-014: 性能优化 - 全量加载
- **文件**: `src/observation-engine.ts:254-276`
- **问题**: `loadRecentObservations` 每次读整个文件
- **修复方案**:
  - [ ] 添加索引文件
  - [ ] 或内存缓存 + TTL
- **预计时间**: 3h

### TASK-015: 代码重复消除
- **文件**: `src/transport.ts`, `src/message-manager.ts`
- **问题**: `generateMessageId` 等函数重复
- **修复方案**:
  - [ ] 合并到公共模块
  - [ ] 明确 message-manager 为格式化层
- **预计时间**: 2h

### TASK-016: 异步 I/O 改造
- **文件**: `src/transport.ts`
- **问题**: `writeFileSync` 阻塞主线程
- **修复方案**:
  - [ ] 使用 `fs.promises` 异步 API
  - [ ] 添加写入队列
- **预计时间**: 4h

### TASK-017: 补充测试
- **文件**: `tests/`
- **缺失**: transport.test.ts, message-manager.test.ts
- **修复方案**:
  - [ ] 添加 transport 模块测试
  - [ ] 添加 message-manager 模块测试
  - [ ] 添加竞态条件边界测试
- **预计时间**: 6h

---

## 安全性问题 (独立任务)

### TASK-018: 路径注入防护
- **文件**: `src/transport.ts`, `src/mailbox.ts`
- **问题**: `agentId`, `teamName` 直接拼接路径
- **修复方案**:
  - [ ] 添加路径字符白名单校验
  - [ ] 或使用 hash 编码
- **预计时间**: 2h

### TASK-019: 消息签名 (可选)
- **文件**: `src/transport.ts`
- **问题**: 消息可被篡改
- **修复方案**:
  - [ ] 添加 HMAC 签名
  - [ ] 添加 `signature` 字段
- **预计时间**: 3h

---

## 任务统计

| 优先级 | 任务数 | 预计时间 |
|--------|--------|----------|
| P0 | 5 | 16h |
| P1 | 6 | 14h |
| P2 | 6 | 21h |
| 安全 | 2 | 5h |
| **总计** | **19** | **56h** |

---

## 建议执行顺序

**第 1 周** (P0):
- TASK-001 → TASK-002 → TASK-005 → TASK-003 → TASK-004

**第 2 周** (P1):
- TASK-006 → TASK-007 → TASK-008 → TASK-009 → TASK-010 → TASK-011

**第 3 周** (P2 + 安全):
- TASK-012 → TASK-013 → TASK-014 → TASK-015 → TASK-016 → TASK-017 → TASK-018

---

*清单创建时间: 2026-03-22*

# OpenClaw Multi-Agent Orchestrator (OMA)

> **版本:** v3.0.1
> **测试覆盖:** 979 个单元测试，全部通过
> **源文件数:** 38 个（src/ 目录 34 个 + hooks/ 目录 4 个）

---

## 一句话描述

OMA 是 OpenClaw 平台的多 Agent 编排引擎，**自动识别用户意图复杂度**，在需要时强制派遣子 Agent 执行并行任务，并通过自进化系统持续优化分类准确率。

---

## 核心价值

| 用户场景 | OMA 行为 |
|---------|---------|
| "好的" | 识别为 light tier，不干预 |
| "帮我检查 gateway 日志" | 识别为 tracked tier，建议单 Agent 执行 |
| "全面审查代码质量，派出多个 agent 分别检查安全性、性能和测试覆盖率" | 识别为 delegation tier，**强制派遣** 3+ 子 Agent |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenClaw Runtime                              │
│                                                                      │
│   用户消息 ──▶ message_received Hook ──▶ 意图分类 ──▶ 观察记录       │
│                   │                        │                         │
│                   │                        ├─ light: 无干预          │
│                   │                        ├─ tracked: 建议指引      │
│                   │                        └─ delegation: 强制委派   │
│                   │                                                   │
│                   ▼                                                   │
│           before_prompt_build Hook                                    │
│                   │                                                   │
│                   ├─ 注入 Preamble（角色定位、完整性原则）            │
│                   ├─ 注入 Dispatch Guidance（待执行任务）             │
│                   └─ 注入 Delegation Mandate（强制委派指令）          │
│                                                                      │
│   Agent 工具调用 ──▶ before_tool_call Hook ──▶ Level 2/3 阻塞检查   │
│                   │                                                   │
│                   ├─ L2: 首次警告，第二次阻塞                         │
│                   └─ L3: 直接阻塞（直到派遣子 Agent）                 │
│                                                                      │
│   子 Agent 事件 ──▶ subagent_spawned/subagent_ended Hook             │
│                   │                                                   │
│                   └─ 更新 TaskBoard 状态                              │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                    TaskBoard                                 │   │
│   │   Project → Tasks → Sprint Stage                            │   │
│   │   ~/.openclaw/shared-memory/task-board.json                 │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                 自进化引擎（每小时检查，每天执行）              │   │
│   │                                                              │   │
│   │   observation-log.jsonl ──▶ 模式发现 ──▶ 关键词学习           │   │
│   │                            │                                  │   │
│   │                            ▼                                  │   │
│   │                      Enforcement Ladder                       │   │
│   │                      L0 → L1 → L2 → L3                        │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四大核心模块

### 1. 意图识别层

**入口:** `src/execution-policy.ts` → `inferExecutionComplexity()`

**分类决策树:**

```
用户消息
    │
    ├─ 极短确认词（≤6字，如"好的"、"OK"）→ light
    ├─ 问候语（"你好"、"hi"）→ light
    ├─ 用户自定义 light 关键词命中 → light
    ├─ 用户自定义 delegation 关键词命中 → delegation
    ├─ 已学习的模式置信度 ≥ 70% → 返回学习结果
    ├─ DELEGATION_MARKERS 命中（"全力推进"、"并行"、"多 agent"）→ delegation
    ├─ 动词数 ≥ 4 → delegation
    ├─ 编号列表 ≥ 3 项 且长度 > 80 → delegation
    ├─ 动词数 ≥ 3 → tracked
    ├─ TRACKED_MARKERS ≥ 2 → tracked
    ├─ 长度 > 100 且动词数 ≥ 1 → tracked
    └─ 默认 → tracked（大多数消息都是工作请求）
```

### 2. Enforcement Ladder（强制阶梯）

**四级渐进式强制:**

| Level | 名称 | 行为 | 触发条件 |
|-------|------|------|---------|
| **L0** | Observation | 仅记录，无干预 | 新安装（已改为默认 L2） |
| **L1** | Advisory | 注入软建议 | 累计观察 ≥ 20 条 |
| **L2** | Guided | 注入 dispatch plan + **软阻塞** | 准确率 ≥ 75% |
| **L3** | Enforced | **硬阻塞**非派遣工具 | 准确率 ≥ 85% 且连续 5 天准确 |

**L2 软阻塞机制（v3.0.1 新增）:**
- 第 1 次调用非派遣工具 → 允许，但记录警告
- 第 2 次调用非派遣工具 → **阻塞**

**升降级阈值:**

```
升级:
  L0 → L1: 累计观察 ≥ 20 条
  L1 → L2: 准确率 ≥ 75%
  L2 → L3: 准确率 ≥ 85% 且连续 5 天准确

降级:
  L3 → L2: 24h 内纠正 ≥ 5 次（需连续 2 天超标）
  L2 → L1: 连续错误 ≥ 5 次（需连续 2 天超标）

保护:
  - 冷却期: Level 变更后 3 天内不再变更
  - 降级缓冲: 需连续 2 天超标才降级
```

**默认启动级别（v3.0.1 改动）:**
- 新安装直接从 **L2** 启动，而非 L0
- 理由: L0 沉默期太长，新用户无法体验核心功能

### 3. TaskBoard（任务看板）

**数据结构:**

```typescript
TaskBoard
  └── Project[]
        ├── id: "proj-20260321-a3f2"
        ├── name: string
        ├── status: "pending" | "running" | "reviewing" | "done" | "failed"
        ├── request: string              // 原始用户请求
        ├── currentStage: SprintStage    // "plan"|"build"|"review"|"test"|"ship"
        └── tasks: Task[]
              ├── id: "task-3a1f2b"
              ├── label: string          // 任务描述
              ├── status: TaskStatus     // pending|dispatched|completed|approved|rejected
              ├── sessionKey?: string    // 关联的子 Agent session
              ├── retryCount: number     // 当前重试次数
              ├── maxRetry: number       // 最大重试次数（默认 2）
              └── resultText?: string    // 执行结果
```

**Sprint 五阶段 Agent 映射:**

| 阶段 | Agent 类型 |
|------|-----------|
| plan | planner, architect, analyst |
| build | executor, coder |
| review | code-reviewer, security-reviewer |
| test | tdd-guide, test-engineer, qa-tester |
| ship | git-master, doc-updater |

### 4. 自进化引擎

**四大组件:**

| 组件 | 文件 | 功能 |
|------|------|------|
| Observation Engine | `observation-engine.ts` | 记录每条消息、工具调用、结果 |
| Pattern Discovery | `pattern-discovery.ts` | TF-IDF 分析提取 delegation 关键词 |
| Intent Registry | `intent-registry.ts` | 存储学习到的意图模式 |
| Evolution Cycle | `evolution-cycle.ts` | 每日自动执行：分析→发现→应用→升降级 |

**每日进化流程:**

```
1. 加载最近 7 天观察记录
2. 计算准确率、纠正率、tier 分布
3. 运行模式发现（TF-IDF）
4. 置信度 ≥ 80% 的关键词自动加入 userKeywords
5. 置信度 60-80% 的关键词放入待审核队列
6. 执行 Enforcement Ladder 升降级评估
7. 清理超过 30 天的观察记录
8. 生成进化报告
```

---

## Hook 层详解

### message_received Hook

**职责:**
1. 分类用户消息复杂度
2. 记录观察到 JSONL 文件
3. 检测用户纠正信号
4. 设置 `pendingDelegationRequest` 状态

### before_prompt_build Hook

**注入优先级:**

```
1. 入门引导（首次使用，未完成 onboarding）
2. Preamble（角色定位、完整性原则、升级协议）
3. Dispatch Guidance（待执行任务列表）
4. Delegation Mandate（强制委派指令）
5. L1 软建议
```

### before_tool_call Hook

**阻塞逻辑:**

```typescript
// 白名单工具永不阻塞
const ALWAYS_ALLOWED_TOOLS = new Set([
  "multi-agent-orchestrator",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "todowrite",
  "todoupdate",
]);

// L2 软阻塞
if (behavior.softBlockNonDispatchTools && spawnCount === 0) {
  warningCount++;
  if (warningCount > 1) {
    return { blockReason: "OMA enforcement level 2: 需要先派遣子 agent..." };
  }
}

// L3 硬阻塞
if (behavior.blockNonDispatchTools && spawnCount === 0) {
  return { blockReason: "OMA enforcement level 3: 需要先派遣子 agent..." };
}
```

### subagent_spawned / subagent_ended Hook

**职责:**
- 追踪子 Agent 生命周期
- 更新 TaskBoard 任务状态
- 触发自动审查（review gate）

---

## 工具 API

### 四大 Action

| Action | 用途 |
|--------|------|
| `plan_tracks` | 将用户请求分解为多个 research track |
| `enforce_execution_policy` | 检查执行策略违规，返回下一步指令 |
| `validate_and_merge` | 合并子 Agent 输出，去重，生成报告 |
| `orchestrate` | 一键操作：plan + create project + dispatch guidance |

### 斜杠命令

| 命令 | 用途 |
|------|------|
| `/mao-agents [keyword]` | 列出或搜索可用 Agent |
| `/mao-agent <name>` | 查看 Agent 详情 |
| `/mao-templates` | 列出任务模板 |
| `/mao-board` | 查看任务看板 |
| `/mao-project <id>` | 查看项目详情 |
| `/mao-review` | 审查当前项目结果 |
| `/mao-resume` | 恢复中断的工作 |
| `/mao-report [projectId]` | 生成项目报告 |
| `/mao-level` | 查看当前 Enforcement Level |
| `/mao-observations` | 查看观察统计 |
| `/mao-discover` | 手动运行模式发现 |
| `/mao-evolve` | 手动触发进化循环 |
| `/mao-learned` | 查看学习到的模式 |
| `/mao-keyword <tier> <phrase>` | 添加自定义关键词 |
| `/mao-export` | 导出学习模式 |
| `/mao-import <file>` | 导入学习模式 |
| `/mao-reset` | 重置到 Level 0 |

---

## 配置项

### openclaw.plugin.json

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabledPromptGuidance` | boolean | true | 注入编排指引 |
| `maxItemsPerTrack` | integer | 8 | 每个 track 最大保留项数 |
| `executionPolicy` | enum | delegation-first | 执行策略模式 |
| `delegationStartGate` | enum | required | 委派门槛模式 |
| `enforcementLevel` | 0-3 | - | 手动覆盖 Enforcement Level |

### 执行策略模式

| 模式 | 行为 |
|------|------|
| `free` | 最小约束 |
| `guided` | 需要书面计划 |
| `tracked` | 需要 task-bus 和步骤汇报 |
| `delegation-first` | 需要 task-bus、计划、且复杂任务必须派遣 |
| `strict-orchestrated` | 最严格，用于长时间多 Agent 可见执行 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OFMS_SHARED_ROOT` | `~/.openclaw/shared-memory` | 共享内存路径 |
| `AGENCY_AGENTS_PATH` | `~/Documents/agency-agents-backup` | Agent 库路径 |

---

## OAG 集成

OMA 与 OAG（OpenClaw Auto Gateway）互补协作:

| 交互点 | 方向 | 说明 |
|--------|------|------|
| OAG 事件 → OMA 观察 | OAG → OMA | critical 故障自动触发 Agent 诊断 |
| OMA 失败 → OAG 根因 | OMA → OAG | rate_limit 失败自动分类根因 |
| OAG 预测 → OMA 调度 | OAG → OMA | 配额将满时减少并发 Agent |

**状态:** 三个方向转换函数已实现（纯函数），等待 OAG Phase 3 事件 API 就绪后连接。

---

## 治理层（从 gstack 借鉴）

| 机制 | 文件 | 说明 |
|------|------|------|
| Unified Preamble | `preamble.ts` | 每次注入角色定位、完整性原则、禁止行为 |
| Completion Status Protocol | `status-protocol.ts` | DONE/BLOCKED/NEEDS_CONTEXT 结构化汇报 |
| WTF-likelihood | `wtf-likelihood.ts` | 修复循环检测，超过阈值自动停止 |
| Review Dashboard | `review-dashboard.ts` | 追踪 5 种审查类型的状态和过期检测 |

---

## 存储结构

```
~/.openclaw/shared-memory/
├── observation-log.jsonl      # 观察记录（JSONL，每次进化清理 >30 天）
├── task-board.json            # 任务看板
├── enforcement-state.json     # Enforcement Level 状态
├── intent-registry.json       # 学习到的意图模式
├── user-keywords.json         # 用户自定义关键词
├── evolution-history.json     # 进化报告历史
└── onboarding-state.json      # 入门引导状态
```

---

## 测试覆盖

**总计: 979 个测试，34 个测试文件**

| 模块 | 测试数 | 覆盖内容 |
|------|--------|---------|
| enforcement-ladder | ~80 | 升降级、冷却期、缓冲区 |
| evolution-cycle | ~60 | 完整进化循环、自动应用 |
| execution-policy | ~100 | 意图分类所有路径 |
| observation-engine | ~70 | 记录、统计、反馈更新 |
| pattern-discovery | ~80 | TF-IDF 计算、模式过滤 |
| task-board | ~90 | 状态机、Sprint 阶段 |
| preamble | ~40 | 五块内容生成 |
| status-protocol | ~50 | 序列化、3-strike |
| wtf-likelihood | ~60 | 评分计算、阈值 |
| review-dashboard | ~80 | Verdict 计算、过期检测 |
| oag-bridge | ~60 | 三方向转换 |

---

## 性能数据

| 操作 | 耗时 | 说明 |
|------|------|------|
| `inferExecutionComplexity()` | < 1ms | 纯字符串匹配 |
| `message_received` Hook | < 2ms | 含追加写磁盘 |
| `before_prompt_build` Hook | < 1ms | 纯内存操作 |
| `before_tool_call` Hook | < 0.5ms | 纯内存检查 |
| `runEvolutionCycle()` | 10-100ms | 读取 7 天 JSONL |
| 979 个单元测试 | ~2.5s | 纯函数，无 I/O |

---

## 版本历史

### v3.0.1 (2026-03-21)

**重构:**
- 删除未使用的 `OrchestratorConfig` 类型
- 删除重复的 `/maotest` 命令（保留 CLI `mao-selftest`）
- 删除未使用的 `tests/simulation/` 目录
- 更新测试适配 `DEFAULT_STARTING_LEVEL=2`

**新功能:**
- L2 软阻塞: 首次调用警告，第二次阻塞
- `checkPolicyBlock()` 执行策略违规检查
- `softBlockWarningCount` 状态追踪
- 新安装默认从 L2 启动（而非 L0）

### v3.0.0 (2026-03-19)

- 完整的自进化系统
- OAG 桥接层
- 治理层（从 gstack 借鉴）
- 979 个单元测试

### v2.0.1

- 模拟测试框架
- Level 震荡修复
- 关键词膨胀控制
- 研究者误分类修复

### v2.0.0

- 自进化意图检测
- Enforcement Ladder
- 每日进化循环
- 模式导出/导入

---

## 安装

```bash
cd ~/.openclaw/extensions
git clone https://github.com/haiyuzhong1980/multi-agent-orchestrator
cd multi-agent-orchestrator
npm install
npm test  # 验证 979 个测试通过
```

然后在 `openclaw.config.json` 中添加:

```json
{
  "extensions": ["~/.openclaw/extensions/multi-agent-orchestrator"]
}
```

---

## 作者

[haiyuzhong1980](https://github.com/haiyuzhong1980)

## License

MIT

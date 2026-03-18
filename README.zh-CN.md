# OpenClaw 多 Agent 编排器 (OMA)

面向 [OpenClaw](https://github.com/openclaw) 的确定性多 Agent 任务编排系统。OMA 协调并行研究 track、执行可配置的策略护栏、集成 144 个专业 Agent 人格，并从子 Agent 原始输出中生成结构化报告。

> **命名说明:** 产品名为 **OpenClaw Multi-Agent Orchestrator (OMA)**。内部插件 ID 和工具名保持 `multi-agent-orchestrator` 以兼容现有配置。斜杠命令使用 `mao-` 前缀（如 `/mao-agents`、`/mao-templates`）。

---

## 架构

OMA 暴露一个 **4 动作工具** (`multi-agent-orchestrator`)，后端持久化任务看板：

| 动作 | 用途 |
|---|---|
| `plan_tracks` | 将请求分解为类型化的研究 track，每个 track 配子 Agent prompt 模板 |
| `enforce_execution_policy` | 检查编排器是否需要创建 task-bus、生成计划、派遣 worker 或推进下一步 |
| `validate_and_merge` | 接收子 Agent 原始输出，过滤噪音，提取 GitHub 链接项，去重，输出结构化最终报告 |
| `orchestrate` | 一站式：规划 track → 在任务看板创建项目 → 持久化 → 返回调度指引 |

---

## 核心功能

### 任务看板 (E1-E6 生产执行引擎)

OMA 维护一个持久化任务看板，跨会话追踪每个项目和子 Agent 执行状态：

| 模块 | 用途 |
|---|---|
| `task-board.ts` | 核心数据模型：项目、任务、状态、原子 JSON 持久化 |
| `prompt-guidance.ts` | 自动将调度指引注入系统 prompt |
| `result-collector.ts` | 处理 `subagent_ended` 事件，从原始输出更新任务状态 |
| `review-gate.ts` | 自动审查已完成任务，标记通过/拒绝，准备重试 |
| `session-resume.ts` | 启动时检测中断的工作，注入恢复 prompt |
| `report-generator.ts` | 生成结构化的项目完成报告 |

**完整生命周期:** 编排 → 调度 → 收集 → 审查 → 重试 → 报告

### 执行策略 — 5 种模式

| 模式 | 行为 |
|---|---|
| `free` | 最小约束，无结构性要求 |
| `guided` | 非平凡任务需要书面计划 |
| `tracked` | 需要 task-bus 和逐步汇报 |
| `delegation-first` | 需要 task-bus、步骤计划，复杂任务需要真实 worker 委派 |
| `strict-orchestrated` | 最强模式，适用于长期运行的多 Agent 用户可见执行 |

### 委派门禁 — 3 种模式

| 模式 | 行为 |
|---|---|
| `off` | 委派可选 |
| `advisory` | 建议委派但不强制 |
| `required` | 必须先完成委派才能继续 |

### Agent 注册表

运行时加载 [agency-agents](https://github.com/haiyuzhong1980/agency-agents-backup) 库。

- **144 个 Agent**，覆盖多个类别
- 按关键词搜索 (`/mao-agents <关键词>`)
- 查看任意 Agent 的完整身份、使命和工具 (`/mao-agent <名称>`)

### OFMS 集成

当 `OFMS_SHARED_ROOT` 存在时，OMA 从共享记忆读取话题上下文，并将 track 结果写回，支持话题驱动的规划和跨会话结果反馈。

### Track 模板 — 10 个内置模板

| ID | 类别 | 用途 |
|---|---|---|
| `github-issues` | 研究 | 查找和分析 GitHub Issues |
| `github-discussions` | 研究 | 查找和分析 GitHub Discussions |
| `security-audit` | 审计 | 识别安全漏洞和风险 |
| `performance-review` | 审计 | 识别性能瓶颈和优化机会 |
| `competitive-analysis` | 分析 | 竞品格局分析 |
| `code-review` | 开发 | 代码质量和正确性审查 |
| `dependency-audit` | 审计 | 依赖风险和过期审计 |
| `documentation-review` | 开发 | 文档审查和改进 |
| `market-research` | 分析 | 市场趋势和信号研究 |
| `ops-health-check` | 运维 | 系统运行健康检查 |

也支持自定义 track — 在 `plan_tracks` 中传入任意 `goal` 即可生成定制的 track 子 Agent prompt。

---

## 自进化系统 (EV1-EV6)

OMA 从每次交互中学习，持续提升多 Agent 编排意图检测能力。

### 进化生命周期

| 阶段 | 时间 | 行为 |
|---|---|---|
| **观察期** (Level 0) | 第 1-3 天 | 被动记录，无强制 |
| **建议期** (Level 1) | 第 4-7 天 | 软性建议，不阻塞 |
| **引导期** (Level 2) | 第 8+ 天 | 身份注入 + 调度计划 |
| **强制期** (Level 3) | 成熟阶段 | 工具硬阻塞直到完成调度 |

### 工作原理

1. **观察引擎** — 记录每条用户消息及其结果（调用了什么工具、是否派遣子 Agent、用户是否满意或纠正了系统）
2. **模式发现** — 使用 TF-IDF 式分析发现预测委派意图的词汇
3. **强制梯度** — 随准确率提高逐步增强强制力度，在重复错误时自动降级
4. **每日进化** — 每日循环分析观察、发现模式、自动应用高置信度关键词、调整强制级别
5. **入门引导** — 首次运行问卷，适配用户偏好（工作类型、激进程度、自定义短语）
6. **导出/导入** — 团队成员间共享学习到的模式

### 进化命令

| 命令 | 说明 |
|---|---|
| `/mao-observations` | 查看观察统计 |
| `/mao-discover` | 手动运行模式发现 |
| `/mao-level` | 查看当前强制级别 |
| `/mao-evolve` | 手动触发进化循环 |
| `/mao-evolution-history` | 查看历史进化报告 |
| `/mao-setup` | 重新运行入门问卷 |
| `/mao-keyword <tier> <短语>` | 添加自定义关键词 |
| `/mao-learned` | 查看学习到的意图模式 |
| `/mao-export` | 导出模式用于分享 |
| `/mao-import <文件>` | 导入共享模式 |
| `/mao-reset` | 重置到 Level 0 |

---

## 模拟测试框架

OMA 包含完整的模拟测试套件，通过加速多日场景验证自进化引擎的端到端行为。

### 快速开始

```bash
# 本地运行：30 天模拟，模板消息
./tests/simulation/run.sh

# 本地运行：90 天压测，LLM 生成语料
./tests/simulation/run.sh --days 90 --messages 80

# 可复现的种子
./tests/simulation/run.sh --days 30 --seed mytest

# Docker 模式（可选）
./tests/simulation/run.sh --docker
```

### 用户画像 — 15 个

#### 基础画像 (5 个)

| 画像 | Tier 分布 | 纠正率 | 说明 |
|---|---|---|---|
| 保守型 | 40/50/10 | 70% | 偏好简单任务，频繁降级纠正 |
| 激进型 | 10/30/60 | 80% | 大量使用多 Agent 委派，纠正欠分类 |
| 开发者 | 15/65/20 | 50% | 技术任务为主 |
| 研究者 | 20/50/30 | 40% | 深度分析，tracked/delegation 边界模糊 |
| 管理者 | 15/35/50 | 60% | 进度管理，频繁委派 |

#### 扩展画像 (10 个)

| 画像 | Tier 分布 | 纠正率 | 测试目标 |
|---|---|---|---|
| 新手 | 50/45/5 | 15% | 模糊意图分类 |
| 运维 | 10/70/20 | 60% | 紧急时突发切换 |
| 数据科学家 | 15/55/30 | 45% | 双语分词 |
| 前端开发 | 20/70/10 | 50% | 过度分类抑制 |
| 双语用户 | 15/55/30 | 50% | 多语言关键词学习 |
| 连珠炮 | 60/35/5 | 30% | light/tracked 边界 |
| 架构师 | 5/30/65 | 70% | 高 delegation 场景 |
| 闲聊型 | 70/25/5 | 20% | 噪声过滤 |
| 完美主义者 | 10/50/40 | 90% | 极端纠正压力 |
| 多线程 | 15/55/30 | 55% | 上下文混淆 |

### 深度验证

不只测分类准确率，还验证：
- delegation 消息是否真的触发 agent spawn
- enforcement level 的行为是否正确执行
- delegation 消息能否匹配到合适的 track template
- 执行策略报告是否正确检测违规

```bash
# 运行深度验证
node --experimental-strip-types tests/simulation/deep-validation.ts [corpus.json] [msgs_per_tier]
```

### LLM 语料生成

使用 LongCat API（或任何 OpenAI 兼容端点）生成真实消息语料库：

```bash
# 生成语料库
node --experimental-strip-types tests/simulation/llm-message-generator.ts corpus.json

# 用语料库跑模拟
node --experimental-strip-types tests/simulation/simulate-days.ts \
  --days 90 --messages-per-day 80 --corpus corpus.json
```

### 压测结果 (v2.0.1, 180 天 × 200 消息 × 5 画像 = 180,000 条)

| 画像 | 最终 Level | 准确率 | 纠正数 | 关键词 |
|---|---|---|---|---|
| 保守型 | L3 | 99.3% | 452 | 110 |
| 激进型 | L3 | 93.5% | 1,370 | 79 |
| 开发者 | L3 | 92.2% | 2,876 | 107 |
| 研究者 | L3 | 96.8% | 1,605 | 114 |
| 管理者 | L3 | 84.4% | 4,082 | 84 |
| **总体** | — | **89.4%** | — | — |

---

## 模块结构

```
index.ts                  — 插件入口；注册工具、命令和 CLI
src/
  agent-registry.ts       — 加载和搜索 agency-agents 库
  audit-log.ts            — 会话级审计日志 (EV1)
  candidate-extractor.ts  — 从原始文本提取 GitHub 链接项
  enforcement-ladder.ts   — 4 级强制梯度，自动升降级 (EV3)
  evolution-cycle.ts      — 每日进化循环：分析→发现→应用 (EV4)
  execution-policy.ts     — 5 模式策略引擎
  intent-registry.ts      — 合并关键词注册表（内置+学习+用户自定义）(EV2)
  noise-filter.ts         — 脏标记和工具日志过滤
  observation-engine.ts   — 被动观察记录器 (EV1)
  ofms-bridge.ts          — OFMS 共享记忆读写
  onboarding.ts           — 首次运行问卷 (EV5)
  pattern-discovery.ts    — TF-IDF 式关键词发现 (EV2)
  pattern-export.ts       — 模式导出/导入 (EV5)
  prompt-guidance.ts      — 系统 prompt 指引注入
  report-builder.ts       — 5 段式结构化报告组装
  report-generator.ts     — 项目完成报告生成 (E6)
  result-collector.ts     — 子 Agent 结果收集 (E3)
  review-gate.ts          — 自动审查、通过/拒绝、重试 (E4)
  schema.ts               — 工具 JSON Schema
  session-resume.ts       — 中断工作恢复 (E5)
  session-state.ts        — 持久化进化状态 (EV3)
  task-board.ts           — 持久化任务看板 (E1)
  tool.ts                 — 工具 execute() 分发器
  track-planner.ts        — track 规划、窗口推断、子 Agent prompt
  track-templates.ts      — 10 个内置 track 模板
  types.ts                — 共享 TypeScript 类型
  url-utils.ts            — URL 分类工具
  user-keywords.ts        — 用户自定义关键词管理 (EV5)

tests/simulation/
  user-profiles.ts          — 5 个基础画像
  user-profiles-extended.ts — 10 个扩展画像
  llm-message-generator.ts  — LLM 语料库生成器
  simulate-days.ts          — 核心模拟器：时间加速 N 天进化
  deep-validation.ts        — 深度验证：分类 + 执行策略 + Agent 触发
  analyze-results.ts        — ASCII sparkline 分析报告
  corpus.json               — 预生成 LLM 语料库
  run.sh                    — 一键启动脚本
  Dockerfile / docker-compose.yml — Docker 部署
```

---

## 里程碑

| 里程碑 | 内容 |
|---|---|
| M0 | 3 动作工具骨架 |
| M1 | 噪声过滤、候选提取、去重 |
| M2 | 5 段报告、5 模式执行策略引擎 |
| M3 | Agent 注册表 (144 Agent)、搜索命令 |
| M4 | OFMS 集成、10 个 track 模板 |
| E1-E6 | 任务看板、调度指引、结果收集、审查门禁、会话恢复、报告生成 |
| EV1-EV6 | 观察引擎、模式发现、强制梯度、每日进化、入门引导、导出/导入 |
| **SIM** | **模拟测试框架、15 画像、3 bug 修复、深度验证、732 测试通过、v2.0.1** |

---

## 更新日志

### v2.0.1 — 模拟测试 & 自进化修复

**新增：模拟测试框架** (`tests/simulation/`)
- 15 个用户画像（5 基础 + 10 扩展），覆盖各种边缘场景
- 时间加速 N 天模拟，直接调用 OMA 核心函数
- LLM 语料库生成器（LongCat API / Ollama Qwen 0.6B / 任何 OpenAI 兼容端点）
- 深度验证：分类准确率 + 执行策略触发 + Agent spawn + 模板匹配
- Docker 支持

**Bug 修复：**
- **Level 震荡消除** — 新增 3 天冷却期 + 2 天降级缓冲。修复前所有画像每天 L1↔L2 震荡；修复后 Day7 达到 L3 后稳定。
- **关键词膨胀控制** — 单 tier 上限 80 + 总上限 200 + 子串去重。关键词数从 751→111。
- **研究者误分类修复** — 复合动词阈值从 3→4。研究者准确率从 84.3%→96.8%。

**测试结果：** 732/732 单元测试通过，0 回归。

---

## 配置

在 `openclaw.plugin.json`（或 OpenClaw 插件配置 UI）中设置：

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabledPromptGuidance` | boolean | `true` | 是否在系统 prompt 注入编排指引 |
| `maxItemsPerTrack` | integer 1-20 | `8` | 去重后每 track 最大保留项数 |
| `executionPolicy` | enum | `delegation-first` | 执行策略模式 |
| `delegationStartGate` | enum | `required` | 委派门禁模式 |

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OFMS_SHARED_ROOT` | `~/.openclaw/shared-memory` | OFMS 共享记忆路径 |
| `AGENCY_AGENTS_PATH` | `~/Documents/agency-agents-backup` | agency-agents 库路径 |

---

## 安装

```bash
cd ~/.openclaw/extensions
git clone https://github.com/haiyuzhong1980/multi-agent-orchestrator
cd multi-agent-orchestrator
npm install
```

在 `openclaw.config.json` 中添加：

```json
{
  "extensions": ["~/.openclaw/extensions/multi-agent-orchestrator"]
}
```

---

## 许可证

MIT

## 作者

[haiyuzhong1980](https://github.com/haiyuzhong1980)

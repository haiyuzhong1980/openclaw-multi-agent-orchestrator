# Multi-Agent Orchestrator (MAO)

Deterministic multi-agent task orchestration for OpenClaw. MAO coordinates parallel research tracks, enforces configurable execution-policy guardrails, and produces structured reports from raw child-agent outputs.

---

## Architecture

MAO exposes a single **3-action tool** (`multi-agent-orchestrator`):

| Action | Purpose |
|---|---|
| `plan_tracks` | Decompose a request into typed research tracks with per-track subagent prompt templates |
| `enforce_execution_policy` | Check whether the orchestrator must create a task-bus, produce a plan, spawn workers, or advance to the next step |
| `validate_and_merge` | Accept raw child-agent outputs, filter noise, extract GitHub-linked items, deduplicate by URL, and emit a structured final report |

---

## Features

### Execution Policy — 5 modes

| Mode | Behaviour |
|---|---|
| `free` | Minimal constraints; no structural requirements |
| `guided` | Requires a written plan for non-trivial tasks |
| `tracked` | Requires a task-bus and per-step reporting |
| `delegation-first` | Requires task-bus, step plan, and real worker delegation for complex tasks |
| `strict-orchestrated` | Strongest mode; intended for long-running, multi-agent, user-visible execution |

### Delegation Gate — 3 modes

| Mode | Behaviour |
|---|---|
| `off` | Delegation is optional |
| `advisory` | Delegation is recommended but not enforced |
| `required` | Delegation must happen before the orchestrator may proceed |

### Agent Registry

Loads the [agency-agents](https://github.com/haiyuzhong1980/agency-agents-backup) library at runtime.

- **144 agents** across multiple categories
- Search by keyword (`/mao-agents <query>`)
- Inspect any agent's full identity, mission, and tools (`/mao-agent <name>`)

### OFMS Integration

When `OFMS_SHARED_ROOT` is present, MAO reads topic context from shared memory and writes track results back, enabling topic-driven planning and cross-session result feedback.

### Track Templates — 10 built-in templates

| ID | Category | Purpose |
|---|---|---|
| `github-issues` | research | Find and analyse GitHub issues |
| `github-discussions` | research | Find and analyse GitHub discussions |
| `security-audit` | audit | Identify vulnerabilities and risks |
| `performance-review` | audit | Identify bottlenecks and optimisation opportunities |
| `competitive-analysis` | analysis | Map the competitive landscape |
| `code-review` | development | Review code quality and correctness |
| `dependency-audit` | audit | Audit dependencies for risk and staleness |
| `documentation-review` | development | Review and improve documentation |
| `market-research` | analysis | Research market trends and signals |
| `ops-health-check` | operations | Check operational health of a system |

Custom tracks are also supported — pass any arbitrary `goal` in `plan_tracks` to generate bespoke per-track subagent prompts.

### Noise Filtering

- **14 dirty markers** (HTML fragments, tool errors, untrusted content wrappers, JSON payloads, NO_REPLY, status error)
- **7 tool-log markers** (browser ready, sendMessage, pulse/completed events, Command, Stdout/Stderr)
- Lines longer than 500 characters are dropped automatically

### Deduplication

Items are deduplicated by GitHub URL. Every merge response includes a `duplicatesRemoved` count and a `去重说明` section in the final report.

### Structured Reports

Every `validate_and_merge` response emits five fixed sections:

1. **执行步骤** — execution steps taken
2. **协同情况** — track-level collaboration summary
3. **验收结果** — acceptance result per track (`ok` / `partial` / `failed`)
4. **最终汇总** — deduplicated final items
5. **去重说明** — deduplication note

---

## Commands

| Command | Description |
|---|---|
| `/mao-agents [keyword]` | List all agents or search by keyword |
| `/mao-agent <name>` | Show full details for a specific agent |
| `/mao-templates [category]` | List track templates, optionally filtered by category |
| `/mao-template <id>` | Show full details for a specific template |
| `/maotest` | Run a deterministic self-test (plan + merge + policy) |

CLI: `openclaw mao-selftest`

---

## Module Structure

```
index.ts                  — plugin entry point; registers tool, commands, and CLI
src/
  agent-registry.ts       — load and search the agency-agents library
  candidate-extractor.ts  — extract GitHub-linked items from raw text
  execution-policy.ts     — 5-mode policy engine
  noise-filter.ts         — dirty-marker and tool-log filtering
  ofms-bridge.ts          — OFMS shared-memory read/write
  prompt-guidance.ts      — system-prompt guidance injected before_prompt_build
  report-builder.ts       — assemble the 5-section structured report
  schema.ts               — JSON Schema for the 3-action tool
  tool.ts                 — tool execute() dispatcher
  track-planner.ts        — plan_tracks logic, window inference, subagent prompts
  track-templates.ts      — 10 built-in track templates
  types.ts                — shared TypeScript types
  url-utils.ts            — URL classification utilities
```

---

## Configuration

Set in `openclaw.plugin.json` (or the OpenClaw plugin config UI):

| Key | Type | Default | Description |
|---|---|---|---|
| `enabledPromptGuidance` | boolean | `true` | Inject orchestrator guidance into system prompt |
| `maxItemsPerTrack` | integer 1–20 | `8` | Maximum items kept per track after deduplication |
| `executionPolicy` | enum | `delegation-first` | Execution policy mode |
| `delegationStartGate` | enum | `required` | Delegation gate mode |

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `OFMS_SHARED_ROOT` | `~/.openclaw/shared-memory` | Path to OFMS shared memory |
| `AGENCY_AGENTS_PATH` | `~/Documents/agency-agents-backup` | Path to the agency-agents library |

---

## Installation

```bash
# From the OpenClaw extensions directory
cd ~/.openclaw/extensions
git clone https://github.com/haiyuzhong1980/multi-agent-orchestrator
cd multi-agent-orchestrator
npm install
```

Then add to your `openclaw.config.json`:

```json
{
  "extensions": ["~/.openclaw/extensions/multi-agent-orchestrator"]
}
```

---

## Evolution (M0 → M4)

| Milestone | What was built |
|---|---|
| M0 | 3-action tool skeleton: plan_tracks / enforce_execution_policy / validate_and_merge |
| M1 | Noise filter (dirty markers + tool-log markers), candidate extractor, deduplication |
| M2 | Structured 5-section report, execution-policy engine (5 modes + 3 delegation gates) |
| M3 | Agent Registry (144 agents from agency-agents library), /mao-agents + /mao-agent commands |
| M4 | OFMS integration (topic-driven planning + result feedback), 10 track templates, /mao-templates + /mao-template commands |

---

## License

MIT

## Author

[haiyuzhong1980](https://github.com/haiyuzhong1980)

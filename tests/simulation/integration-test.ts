/**
 * OMA 真实集成压测 — 通过 OpenClaw CLI 发送消息到飞书 channel，
 * 验证完整链路：消息 → OMA hook → LLM 决策 → agent spawn → 结果收集 → 进化学习
 *
 * 用法:
 *   node --experimental-strip-types tests/simulation/integration-test.ts
 *
 * 环境要求:
 *   - OpenClaw gateway 运行中
 *   - 飞书 channel 已配置
 *   - OMA 插件已加载
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

// ─── Config ───────────────────────────────────────────────────────────
const FEISHU_ACCOUNT = "main";
const FEISHU_TARGET = "oc_4f1ab34b0261ddd6286763dbb7de6876"; // p2p chat
const DELAY_BETWEEN_MS = 15000; // 15s between messages (let LLM process)
const LOG_DIR = "/root/oma-sim/test-results";

interface TestCase {
  id: string;
  name: string;
  message: string;
  expectedTier: "light" | "tracked" | "delegation";
  expectSpawn: boolean;
  description: string;
}

// ─── 测试用例：覆盖 OMA 所有行为层级 ─────────────────────────────────

const TEST_CASES: TestCase[] = [
  // === Phase 1: Light 消息（不应触发任何 agent） ===
  {
    id: "L1",
    name: "简单确认",
    message: "好的",
    expectedTier: "light",
    expectSpawn: false,
    description: "最简单的 light 消息，不应触发任何 agent",
  },
  {
    id: "L2",
    name: "英文确认",
    message: "ok got it",
    expectedTier: "light",
    expectSpawn: false,
    description: "英文 light 消息",
  },

  // === Phase 2: Tracked 消息（单一任务，不需要 multi-agent） ===
  {
    id: "T1",
    name: "简单查询",
    message: "帮我看看当前服务器的磁盘使用情况",
    expectedTier: "tracked",
    expectSpawn: false,
    description: "单一 tracked 任务",
  },
  {
    id: "T2",
    name: "代码修复",
    message: "帮我修复这个 TypeScript 编译错误：Property 'name' does not exist on type 'unknown'",
    expectedTier: "tracked",
    expectSpawn: false,
    description: "单一 bug 修复",
  },
  {
    id: "T3",
    name: "配置任务",
    message: "帮我配置 Nginx 反向代理，把 /api 路径转发到 localhost:3000",
    expectedTier: "tracked",
    expectSpawn: false,
    description: "单一配置任务",
  },

  // === Phase 3: Delegation 消息（需要 multi-agent 协作） ===
  {
    id: "D1",
    name: "安全审查",
    message: "全面审查代码库的安全问题，组建团队分别检查认证模块、SQL注入风险和加密实现",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "明确的多 agent 任务，3 个并行 track",
  },
  {
    id: "D2",
    name: "微服务架构",
    message: "设计并实现完整的微服务架构方案，包含服务拆分、API网关、认证中心、日志系统，每个模块派出 agent 并行开发",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "大型多 agent 架构任务",
  },
  {
    id: "D3",
    name: "里程碑推进",
    message: "你是总控，从 M1 推进到 M3，每个里程碑都要出测试报告和验收文档，派出多个 agent 并行执行",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "里程碑驱动的 delegation 任务",
  },
  {
    id: "D4",
    name: "全面性能优化",
    message: "全面优化系统性能，组建团队分别处理：\n1. 数据库查询优化\n2. 缓存策略设计\n3. 前端首屏加载优化\n4. API 响应时间优化\n每个方向出详细报告",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "编号列表 + 多维度 delegation",
  },
  {
    id: "D5",
    name: "竞品全面分析",
    message: "调度多个 agent 分别调研 5 家竞品的技术方案、定价策略、用户体验，最后汇总对比报告",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "明确要求多 agent 调度",
  },

  // === Phase 4: 边缘场景 ===
  {
    id: "E1",
    name: "模糊长消息",
    message: "我最近在想我们的产品方向，感觉市场变化很快，竞品也在不断推出新功能，我们需要重新评估一下技术路线和产品策略，你觉得呢？",
    expectedTier: "tracked",
    expectSpawn: false,
    description: "长消息但实际是讨论/咨询，不应触发 delegation",
  },
  {
    id: "E2",
    name: "混合中英文 delegation",
    message: "I need you to orchestrate a full security audit. 派出 agent 分别 check authentication, injection vulnerabilities, and encryption. 每个方向出 detailed report.",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "中英混合 delegation 消息",
  },
  {
    id: "E3",
    name: "纠正测试（升级）",
    message: "应该派 agent 来做这个，不要自己做",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "用户纠正信号：要求升级到 delegation",
  },
  {
    id: "E4",
    name: "纠正测试（降级）",
    message: "不用这么复杂，直接做就好了",
    expectedTier: "light",
    expectSpawn: false,
    description: "用户纠正信号：要求降级",
  },

  // === Phase 5: 长时间 multi-agent 任务 ===
  {
    id: "MA1",
    name: "完整项目开发",
    message: "组成开发团队，全面推进这个新项目：\n1. 架构师做系统设计\n2. 前端 agent 实现 UI\n3. 后端 agent 实现 API\n4. 测试 agent 编写测试用例\n5. 运维 agent 准备部署方案\n每完成一个阶段汇报进度",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "5 个 agent 并行的大型项目",
  },
  {
    id: "MA2",
    name: "代码库全面体检",
    message: "释放你的最大力量，对整个代码库做全面体检：安全扫描、性能分析、代码质量审查、依赖审计、文档检查，每个维度都要出详细的诊断报告和改进建议",
    expectedTier: "delegation",
    expectSpawn: true,
    description: "5 维度并行的全面审查",
  },
];

// ─── Execution ────────────────────────────────────────────────────────

function sendMessage(message: string): string {
  try {
    const result = execSync(
      `openclaw message send --channel feishu --account ${FEISHU_ACCOUNT} --target ${FEISHU_TARGET} --message ${JSON.stringify(message)}`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return result.trim();
  } catch (err: any) {
    return `ERROR: ${err.message}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runIntegrationTest(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  const startTime = new Date().toISOString();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  OMA 真实集成压测`);
  console.log(`  ${TEST_CASES.length} 条测试消息 → 飞书 → OpenClaw → OMA → LLM`);
  console.log(`  间隔: ${DELAY_BETWEEN_MS / 1000}s`);
  console.log(`  预计耗时: ${Math.ceil(TEST_CASES.length * DELAY_BETWEEN_MS / 60000)} 分钟`);
  console.log(`${"═".repeat(60)}\n`);

  const results: Array<{
    testCase: TestCase;
    sendResult: string;
    timestamp: string;
    success: boolean;
  }> = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    const timestamp = new Date().toISOString();

    console.log(`[${i + 1}/${TEST_CASES.length}] ${tc.id}: ${tc.name}`);
    console.log(`  消息: ${tc.message.slice(0, 80)}${tc.message.length > 80 ? "..." : ""}`);
    console.log(`  期望: tier=${tc.expectedTier} spawn=${tc.expectSpawn}`);

    const sendResult = sendMessage(tc.message);
    const success = sendResult.includes("Sent via Feishu");

    console.log(`  结果: ${success ? "✅ 已发送" : "❌ " + sendResult.slice(0, 100)}`);
    console.log();

    results.push({ testCase: tc, sendResult, timestamp, success });

    // Wait between messages to let LLM process
    if (i < TEST_CASES.length - 1) {
      process.stdout.write(`  等待 ${DELAY_BETWEEN_MS / 1000}s...`);
      await sleep(DELAY_BETWEEN_MS);
      console.log(" 继续");
    }
  }

  // Save results
  const report = {
    startTime,
    endTime: new Date().toISOString(),
    totalTests: TEST_CASES.length,
    sent: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };

  const reportPath = `${LOG_DIR}/integration-test-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  完成: ${report.sent}/${report.totalTests} 消息已发送`);
  console.log(`  报告: ${reportPath}`);
  console.log(`  查看 OMA 进化状态: openclaw mao-selftest`);
  console.log(`  查看 gateway 日志: tail -f /var/log/oc-gw.log`);
  console.log(`${"═".repeat(60)}\n`);

  console.log("后续验证步骤:");
  console.log("  1. 检查 gateway 日志中 OMA 的 observation/enforcement 记录");
  console.log("  2. 检查 shared-memory 目录的 observation-log.jsonl");
  console.log("  3. 等待下一次进化循环，查看是否学习到新模式");
  console.log("  4. 重复发送相似消息，验证准确率是否提升");
}

runIntegrationTest().catch(console.error);

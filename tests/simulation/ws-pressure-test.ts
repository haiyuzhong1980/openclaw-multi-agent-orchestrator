/**
 * OMA WebSocket 压测 — 通过 gateway chat.send 发送消息，
 * 走完整 plugin hook 链路（SMH → OMA → LLM → agent spawn）
 *
 * 用法:
 *   node --experimental-strip-types tests/simulation/ws-pressure-test.ts [--url ws://host:port] [--token xxx]
 */

import WebSocket from "ws";
import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "ws://127.0.0.1:18789" },
    token: { type: "string", default: "" },
    password: { type: "string", default: "" },
    delay: { type: "string", default: "20000" },
    session: { type: "string", default: "agent:main:oma-test" },
  },
});

const WS_URL = args.url!;
const DELAY = parseInt(args.delay!, 10);
const SESSION_KEY = args.session!;

interface TestMessage {
  id: string;
  text: string;
  expectedTier: "light" | "tracked" | "delegation";
  expectDispatch: boolean;
}

const MESSAGES: TestMessage[] = [
  // Light
  { id: "L1", text: "好的", expectedTier: "light", expectDispatch: false },
  { id: "L2", text: "收到", expectedTier: "light", expectDispatch: false },
  { id: "L3", text: "ok", expectedTier: "light", expectDispatch: false },

  // Tracked
  { id: "T1", text: "帮我查一下服务器磁盘使用情况", expectedTier: "tracked", expectDispatch: false },
  { id: "T2", text: "帮我修复这个 nginx 配置问题", expectedTier: "tracked", expectDispatch: false },
  { id: "T3", text: "检查一下 SSL 证书是否过期", expectedTier: "tracked", expectDispatch: false },

  // Delegation
  { id: "D1", text: "全面审查代码库安全问题，组建团队分别检查认证、注入、加密三个方面", expectedTier: "delegation", expectDispatch: true },
  { id: "D2", text: "你是总控，派出多个 agent 并行执行以下任务：\n1. 安全扫描\n2. 性能优化\n3. 代码审查\n4. 文档更新", expectedTier: "delegation", expectDispatch: true },
  { id: "D3", text: "从 M1 推进到 M3，每个里程碑都要出测试报告", expectedTier: "delegation", expectDispatch: true },
  { id: "D4", text: "释放你的最大力量，全面优化系统性能", expectedTier: "delegation", expectDispatch: true },
  { id: "D5", text: "组成团队开发，调度多个 agent 分别处理前端重构、后端优化、数据库迁移", expectedTier: "delegation", expectDispatch: true },

  // Edge
  { id: "E1", text: "应该派 agent 来做这个，不要自己做", expectedTier: "delegation", expectDispatch: true },
  { id: "E2", text: "不用这么复杂，直接做就好了", expectedTier: "light", expectDispatch: false },
  { id: "E3", text: "I need you to orchestrate a full security audit, 派出 agent 分别 check 认证和加密", expectedTier: "delegation", expectDispatch: true },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let reqId = 0;
function nextId(): string {
  return `req-${++reqId}`;
}

async function run(): Promise<void> {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  OMA WebSocket 压测`);
  console.log(`  Gateway: ${WS_URL}`);
  console.log(`  Session: ${SESSION_KEY}`);
  console.log(`  消息数: ${MESSAGES.length}`);
  console.log(`  间隔: ${DELAY / 1000}s`);
  console.log(`${"═".repeat(60)}\n`);

  const ws = new WebSocket(WS_URL);

  const pending = new Map<string, (data: any) => void>();
  let connected = false;

  ws.on("message", (raw: Buffer) => {
    const data = JSON.parse(raw.toString());

    if (data.type === "event" && data.event === "connect.challenge") {
      // Respond to challenge with connect
      const connectReq = {
        type: "req",
        id: nextId(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "cli", version: "2026.2.23", platform: "linux", mode: "operator" },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          caps: [],
          commands: [],
          permissions: {},
          auth: args.token ? { token: args.token } : args.password ? { password: args.password } : {},
          locale: "zh-CN",
          userAgent: "oma-pressure-test/1.0",
        },
      };
      ws.send(JSON.stringify(connectReq));
      return;
    }

    if (data.type === "res") {
      if (data.payload?.type === "hello-ok") {
        connected = true;
        console.log("  ✅ WebSocket 连接成功\n");
        return;
      }
      const resolver = pending.get(data.id);
      if (resolver) {
        resolver(data);
        pending.delete(data.id);
      }
    }

    // Log agent events
    if (data.type === "event" && data.event === "chat") {
      const payload = data.payload;
      if (payload?.role === "assistant" && payload?.text) {
        const preview = payload.text.slice(0, 100).replace(/\n/g, " ");
        console.log(`  📩 Agent 回复: ${preview}...`);
      }
    }
  });

  ws.on("error", (err: Error) => {
    console.error(`WebSocket error: ${err.message}`);
  });

  // Wait for connection
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (connected) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });

  if (!connected) {
    console.error("❌ 连接超时");
    ws.close();
    return;
  }

  // Send messages
  const results: Array<{ msg: TestMessage; sent: boolean; runId?: string }> = [];

  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    console.log(`[${i + 1}/${MESSAGES.length}] ${msg.id}: ${msg.text.slice(0, 60)}`);
    console.log(`  期望: tier=${msg.expectedTier} dispatch=${msg.expectDispatch}`);

    const id = nextId();
    const sendReq = {
      type: "req",
      id,
      method: "chat.send",
      params: {
        sessionKey: SESSION_KEY,
        text: msg.text,
        idempotencyKey: `oma-test-${msg.id}-${Date.now()}`,
      },
    };

    const responsePromise = new Promise<any>((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, 30000);
    });

    ws.send(JSON.stringify(sendReq));
    const response = await responsePromise;

    if (response.timeout) {
      console.log(`  ⚠️ 超时`);
      results.push({ msg, sent: false });
    } else if (response.ok) {
      console.log(`  ✅ 已发送 runId=${response.payload?.runId}`);
      results.push({ msg, sent: true, runId: response.payload?.runId });
    } else {
      console.log(`  ❌ 失败: ${JSON.stringify(response.payload || response.error || response).slice(0, 200)}`);
      results.push({ msg, sent: false });
    }

    if (i < MESSAGES.length - 1) {
      console.log(`  等待 ${DELAY / 1000}s...\n`);
      await sleep(DELAY);
    }
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  发送: ${results.filter((r) => r.sent).length}/${MESSAGES.length}`);
  console.log(`  失败: ${results.filter((r) => !r.sent).length}`);
  console.log(`${"═".repeat(60)}\n`);

  // Save results
  mkdirSync("/root/oma-sim/test-results", { recursive: true });
  const reportPath = `/root/oma-sim/test-results/ws-test-${Date.now()}.json`;
  writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`  报告: ${reportPath}`);
  console.log("  验证: 检查 ~/.openclaw/shared-memory/observation-log.jsonl\n");

  ws.close();
}

run().catch(console.error);

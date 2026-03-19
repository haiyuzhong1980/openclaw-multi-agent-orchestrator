#!/bin/bash
# OMA L1 自动化测试脚本
# 通过 OpenClaw gateway WebSocket 发送消息，监控 OMA delegation 行为

set -a
source /Users/henry/.openclaw/.env.secrets
set +a

NODE=/Users/henry/.nvm/versions/node/v22.16.0/bin/node
GATEWAY_LOG=/Users/henry/.openclaw/logs/gateway.log
GATEWAY_ERR=/Users/henry/.openclaw/logs/gateway.err.log
OBS_LOG=/Users/henry/.openclaw/shared-memory/observation-log.jsonl
REPORT=/Users/henry/.openclaw/extensions/multi-agent-orchestrator/.omc/oma-l1-test-report.md
TOKEN=$OPENCLAW_GATEWAY_AUTH_TOKEN

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

# 通过 WebSocket 发送消息给 agent 并等待回复
send_message() {
  local session_key="$1"
  local message="$2"
  local wait_secs="${3:-60}"

  echo -e "${YELLOW}[$(date '+%H:%M:%S')] 发送消息: ${message:0:60}...${NC}"

  # 记录发送前的日志行数
  local log_lines_before=$(wc -l < "$GATEWAY_LOG")
  local obs_lines_before=$(wc -l < "$OBS_LOG")
  local send_time=$(date '+%Y-%m-%dT%H:%M:%S')

  # 用 Node.js WebSocket 发消息
  $NODE -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:18789', {
  headers: { 'Authorization': 'Bearer $TOKEN' }
});
let replied = false;
ws.on('open', () => {
  // 回应 challenge
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      ws.send(JSON.stringify({ type: 'challenge.response', nonce: msg.payload.nonce }));
      // 发消息
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'request',
          id: 'test-' + Date.now(),
          method: 'sessions.send',
          params: {
            sessionKey: '$session_key',
            content: $(printf '%s' "$message" | $NODE -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('/dev/stdin','utf8')))")
          }
        }));
        console.log('MESSAGE_SENT');
      }, 1000);
    }
    if (msg.type === 'response' || (msg.type === 'event' && msg.event === 'agent.reply')) {
      if (!replied) {
        replied = true;
        console.log('REPLY_RECEIVED:' + data.toString().slice(0, 500));
      }
    }
  });
});
ws.on('error', (e) => { console.log('WS_ERROR:' + e.message); process.exit(1); });
setTimeout(() => { ws.close(); process.exit(0); }, ${wait_secs}000);
" 2>&1

  local end_time=$(date '+%Y-%m-%dT%H:%M:%S')

  # 检查 OMA 日志
  local new_logs=$(tail -n +$((log_lines_before+1)) "$GATEWAY_LOG")
  local oma_delegation=$(echo "$new_logs" | grep -c "OMA/L1.*Delegation")
  local oma_mandate=$(echo "$new_logs" | grep -c "OMA/L1.*mandate injected")
  local spawn_count=$(echo "$new_logs" | grep -c "subagent_spawned\|sessions_spawn")
  local agent_end=$(echo "$new_logs" | grep -c "agent_end")

  # 检查最新 observation tier
  local latest_tier=$($NODE -e "
const fs = require('fs');
const lines = fs.readFileSync('$OBS_LOG','utf8').trim().split('\n');
const last = JSON.parse(lines[lines.length-1]);
console.log(last.predictedTier || 'unknown');
" 2>/dev/null)

  echo -e "  发送时间: $send_time"
  echo -e "  完成时间: $end_time"
  echo -e "  分类结果: $latest_tier"
  echo -e "  Delegation 检测: $oma_delegation"
  echo -e "  Mandate 注入: $oma_mandate"
  echo -e "  子 Agent 派发: $spawn_count"
  echo -e "  Agent 完成: $agent_end"

  # 返回结果供报告使用
  echo "RESULT|$send_time|$end_time|$message|$latest_tier|$oma_delegation|$oma_mandate|$spawn_count|$agent_end" >> /tmp/oma-test-results.txt
}

# 清理上次结果
> /tmp/oma-test-results.txt

echo "=========================================="
echo "OMA L1 自动化测试 - $(date)"
echo "=========================================="

# Phase 1: 基线分类测试
echo ""
echo "=== Phase 1: 基线分类测试 ==="

send_message "oma-test-light" "好的" 30
sleep 5

send_message "oma-test-tracked" "帮我检查一下 gateway 的状态" 45
sleep 5

send_message "oma-test-delegation-1" "全面审查 OFMS 和 OMA 的代码质量，派出多个 agent 分别检查安全性、性能和测试覆盖率，出报告" 90
sleep 10

# Phase 2: Delegation 深度测试
echo ""
echo "=== Phase 2: Delegation 深度测试 ==="

send_message "oma-test-delegation-2" "组成团队，全面审查 OFMS 扩展的代码质量，从安全性、性能、测试覆盖率三个维度分析，每个维度派一个 agent" 120
sleep 10

send_message "oma-test-delegation-3" "从 M0 推进到 M2，帮我把 OMA 的 enforcement ladder 做到 Level 3 的硬拦截，要分步骤并行推进" 120
sleep 10

send_message "oma-test-delegation-4" "调度所有可用 agent，对 openclaw 的 shared-memory 做一次全面体检，包括数据完整性、噪声比例、过期条目清理" 120
sleep 10

# 生成报告
echo ""
echo "=== 生成报告 ==="

$NODE -e "
const fs = require('fs');
const results = fs.readFileSync('/tmp/oma-test-results.txt','utf8').trim().split('\n')
  .filter(l => l.startsWith('RESULT|'))
  .map(l => {
    const [_, sendTime, endTime, msg, tier, delegation, mandate, spawns, ends] = l.split('|');
    return { sendTime, endTime, msg: msg.slice(0,60), tier, delegation: +delegation, mandate: +mandate, spawns: +spawns, ends: +ends };
  });

let report = '# OMA L1 测试报告\n\n';
report += '## 日期: ' + new Date().toISOString().slice(0,10) + '\n\n';
report += '## 测试环境\n';
report += '- Gateway: localhost:18789\n';
report += '- 默认模型: codexmanager/gpt-5.3-codex\n';
report += '- OMA 版本: v2.0.0 + L1 patch\n';
report += '- Enforcement Level: 1\n\n';

report += '## 测试结果\n\n';
report += '| # | 发送时间 | 完成时间 | 消息摘要 | 分类 | Delegation检测 | Mandate注入 | 子Agent派发 |\n';
report += '|---|----------|----------|----------|------|----------------|-------------|-------------|\n';

results.forEach((r, i) => {
  report += '| ' + (i+1) + ' | ' + r.sendTime.slice(11) + ' | ' + r.endTime.slice(11) + ' | ' + r.msg + ' | ' + r.tier + ' | ' + (r.delegation > 0 ? '✅' : '❌') + ' | ' + (r.mandate > 0 ? '✅' : '❌') + ' | ' + (r.spawns > 0 ? '✅('+r.spawns+')' : '❌') + ' |\n';
});

const delegationTests = results.filter(r => r.tier === 'delegation' || r.msg.includes('全面') || r.msg.includes('团队'));
const mandateHits = delegationTests.filter(r => r.mandate > 0);
const spawnHits = delegationTests.filter(r => r.spawns > 0);

report += '\n## 统计\n\n';
report += '- 总测试: ' + results.length + '\n';
report += '- Delegation 分类命中: ' + delegationTests.length + '/' + results.length + '\n';
report += '- Mandate 注入成功: ' + mandateHits.length + '/' + delegationTests.length + '\n';
report += '- 子 Agent 实际派发: ' + spawnHits.length + '/' + delegationTests.length + '\n\n';

report += '## 结论与建议\n\n';
if (spawnHits.length === 0) {
  report += '### 问题: Agent 未派发子 Agent\n\n';
  if (mandateHits.length > 0) {
    report += 'Mandate 注入成功但 agent 未执行派遣。建议升级到 L2（软拦截）或加强 prompt 指令。\n';
  } else {
    report += 'Mandate 未注入。需要检查 delegation 分类逻辑和 before_prompt_build hook。\n';
  }
} else {
  report += '### L1 机制生效\n\n';
  report += '派遣率: ' + (spawnHits.length/delegationTests.length*100).toFixed(0) + '%\n';
}

report += '\n## 下一步\n\n';
report += '- [ ] 根据测试结果调整 buildDelegationMandate 指令强度\n';
report += '- [ ] 考虑 L2 软拦截 (before_tool_call 提醒)\n';
report += '- [ ] 考虑 L3 硬拦截 (block Write/Edit/Bash)\n';

fs.writeFileSync('$REPORT', report);
console.log('报告已写入: $REPORT');
" 2>&1

echo ""
echo "=========================================="
echo "测试完成 - $(date)"
echo "=========================================="

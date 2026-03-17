import assert from "node:assert/strict";
import { createMultiAgentOrchestratorTool } from "./src/tool.ts";

async function main() {
  const tool = createMultiAgentOrchestratorTool({ maxItemsPerTrack: 5 });

  const plan = await tool.execute("call-0", {
    action: "plan_tracks",
    request:
      "真实执行一个多 agent 调研：一个子 agent 查 openclaw 最近 7 天评论最多的 issues，一个子 agent 查最近 7 天评论最多的 discussions，最后主 agent 汇总。",
  });

  const planText = String(plan.content?.[0]?.text ?? "");
  assert.match(planText, /协同计划/);
  assert.match(planText, /Issues/);
  assert.match(planText, /Discussions/);
  assert.equal(Number(plan.details?.windowDays), 7);
  assert.equal(Array.isArray(plan.details?.tracks), true);
  assert.match(String(plan.details?.tracks?.[0]?.subagentPrompt ?? ""), /你只负责/);

  const partial = await tool.execute("call-1", {
    action: "validate_and_merge",
    tracks: [
      {
        trackId: "issues-track",
        label: "Issues",
        resultText:
          "- First issue https://github.com/openclaw/openclaw/issues/11\n<html>404</html>",
      },
      {
        trackId: "discussions-track",
        label: "Discussions",
        resultText:
          "Page not found\n- Good discussion https://github.com/openclaw/openclaw/discussions/22",
      },
    ],
  });

  const partialText = String(partial.content?.[0]?.text ?? "");
  assert.match(partialText, /Issues: partial/);
  assert.match(partialText, /Discussions: partial/);
  assert.match(partialText, /https:\/\/github\.com\/openclaw\/openclaw\/issues\/11/);
  assert.match(partialText, /https:\/\/github\.com\/openclaw\/openclaw\/discussions\/22/);
  assert.equal(Number(partial.details?.statusCounts?.partial), 2);

  const failed = await tool.execute("call-2", {
    action: "validate_and_merge",
    tracks: [
      {
        trackId: "discussions-track",
        label: "Discussions",
        resultText: "Page not found\nEXTERNAL_UNTRUSTED_CONTENT\n<html>404</html>",
      },
    ],
  });

  const failedText = String(failed.content?.[0]?.text ?? "");
  assert.match(failedText, /Discussions: failed/);
  assert.match(failedText, /无通过验收的有效结果/);
  assert.equal(Number(failed.details?.statusCounts?.failed), 1);

  const deduped = await tool.execute("call-3", {
    action: "validate_and_merge",
    tracks: [
      {
        trackId: "issues-track",
        label: "Issues",
        resultText: "- A https://github.com/openclaw/openclaw/issues/33",
      },
      {
        trackId: "skills-track",
        label: "Skills",
        resultText:
          "- A duplicate https://github.com/openclaw/openclaw/issues/33\n- B https://github.com/openclaw/openclaw/discussions/44",
      },
    ],
  });

  const dedupedText = String(deduped.content?.[0]?.text ?? "");
  assert.match(dedupedText, /去掉重复项 1 条/);
  assert.match(dedupedText, /https:\/\/github\.com\/openclaw\/openclaw\/discussions\/44/);
  assert.equal(Number(deduped.details?.duplicatesRemoved), 1);

  const sanitized = await tool.execute("call-3b", {
    action: "validate_and_merge",
    tracks: [
      {
        trackId: "skills-track",
        label: "Skills",
        resultText: [
          "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
          "```json",
          '{"name":"dirty-json","github_url":"https://github.com/noise/project"}',
          "```",
          "- Clean item https://github.com/openclaw/openclaw",
          "<html>bad</html>",
          "NO_REPLY",
          "<<<END_UNTRUSTED_CHILD_RESULT>>>",
        ].join("\n"),
      },
    ],
  });

  const sanitizedText = String(sanitized.content?.[0]?.text ?? "");
  assert.match(sanitizedText, /https:\/\/github\.com\/openclaw\/openclaw/);
  assert.doesNotMatch(sanitizedText, /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>/);
  assert.doesNotMatch(sanitizedText, /```json/);
  assert.doesNotMatch(sanitizedText, /NO_REPLY/);

  const policy = await tool.execute("call-4", {
    action: "enforce_execution_policy",
    request: "真实执行一个多 agent 调研，要求分步骤汇报并派出子 agent。",
    hasTaskBus: true,
    hasPlan: true,
    hasCheckpoint: true,
    hasWorkerStart: false,
    hasTrackedExecution: false,
    currentStep: 1,
    totalSteps: 3,
  });

  const policyText = String(policy.content?.[0]?.text ?? "");
  assert.match(policyText, /执行策略判定/);
  assert.match(policyText, /policy:/);
  assert.match(policyText, /当前策略要求先派遣/);
  assert.match(String(policy.details?.recommendedAction ?? ""), /派出第一个 worker|启动 tracked execution/);

  console.log("multi-agent-orchestrator smoke test passed");
}

void main();

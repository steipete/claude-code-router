import assert from "node:assert/strict";
import test from "node:test";
import { prepareClaudeCodeOauthBody } from "@ccr/core/agents/local-providers/claude-code-cch.ts";

test("Claude OAuth CCH matches the known Claude Code 2.1.220 vector", () => {
  const body = {
    model: "model-a",
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;" }, { type: "text", text: "system-x" }],
    tools: [],
    metadata: { user_id: "meta-x" },
    max_tokens: 1,
    thinking: { type: "adaptive", display: "omitted" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "high" },
    stream: true
  };

  const signed = prepareClaudeCodeOauthBody(body, "2.1.220");
  assert.match(signed.system[0].text, /cch=7ee87;/);
});


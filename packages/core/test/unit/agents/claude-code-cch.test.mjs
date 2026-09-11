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

for (const { explicitBreakpoints, automatic } of [
  { explicitBreakpoints: 0, automatic: false },
  { explicitBreakpoints: 3, automatic: false },
  { explicitBreakpoints: 4, automatic: false },
  { explicitBreakpoints: 3, automatic: true }
]) {
  test(`Claude OAuth preserves ${explicitBreakpoints} caller cache breakpoints with automatic caching ${automatic}`, () => {
    const cacheControl = { type: "ephemeral" };
    const body = {
      model: "model-a",
      system: [{ type: "text", text: "Caller system prompt." }],
      tools: [{
        name: "read_file",
        input_schema: { type: "object", properties: { cache_control: { type: "string" } } }
      }],
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/image.png" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "File contents." }] }
      ],
      ...(automatic ? { cache_control: cacheControl } : {})
    };
    const cacheableBlocks = [body.system[0], body.tools[0], body.messages[0].content[0], body.messages[2].content[0]];
    for (const block of cacheableBlocks.slice(0, explicitBreakpoints)) block.cache_control = cacheControl;
    const original = structuredClone(body);

    const signed = prepareClaudeCodeOauthBody(body);
    assert.deepEqual(signed.system[1], {
      ...(explicitBreakpoints + Number(automatic) < 4 ? { cache_control: cacheControl } : {}),
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      type: "text"
    });
    assert.deepEqual(signed.system.slice(2), original.system);
    assert.deepEqual(signed.tools, original.tools);
    assert.deepEqual(signed.messages, original.messages);
    assert.deepEqual(signed.cache_control, original.cache_control);
    assert.deepEqual(body, original);
    assert.deepEqual(prepareClaudeCodeOauthBody(signed), signed);
  });
}

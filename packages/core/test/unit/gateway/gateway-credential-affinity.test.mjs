import assert from "node:assert/strict";
import test from "node:test";
import { prepareGatewayUpstreamAttemptForTest } from "@ccr/core/gateway/service.ts";

function config() {
  return {
    Providers: [{
      api_base_url: "https://api.anthropic.com",
      credentialSessionAffinity: true,
      credentials: ["alpha", "bravo", "charlie"].map(id => ({
        apiKey: `synthetic-${id}`,
        id,
        priority: 1
      })),
      id: "claude-pool",
      models: ["claude-opus-5"],
      name: "Claude Pool",
      type: "anthropic_messages"
    }],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {}
  };
}

function primaryCredential(sessionId) {
  const attempt = prepareGatewayUpstreamAttemptForTest({
    body: { max_tokens: 8, messages: [{ content: "hi", role: "user" }], model: "Claude Pool/claude-opus-5" },
    config: config(),
    headers: { "x-claude-code-session-id": sessionId },
    method: "POST",
    path: "/v1/messages"
  });
  return attempt.credentialIds[0];
}

test("Claude credential affinity is stable for one session", () => {
  assert.equal(primaryCredential("session-stable"), primaryCredential("session-stable"));
});

test("Claude credential affinity distributes independent sessions", () => {
  const selected = new Set(Array.from({ length: 48 }, (_, index) => primaryCredential(`session-${index}`)));
  assert.ok(selected.size > 1, `expected multiple credentials, got ${[...selected].join(",")}`);
});

test("OpenAI Responses clamps one-token Desktop probes to the provider minimum", () => {
  const attempt = prepareGatewayUpstreamAttemptForTest({
    body: { max_tokens: 1, messages: [{ content: ".", role: "user" }], model: "Codex Direct/gpt-5.6-sol" },
    config: {
      Providers: [{
        apiKey: "synthetic-openai-key",
        api_base_url: "https://api.openai.com/v1",
        id: "codex-direct",
        models: ["gpt-5.6-sol"],
        name: "Codex Direct",
        type: "openai_responses"
      }],
      Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
      gateway: {}
    },
    headers: {},
    method: "POST",
    path: "/v1/messages"
  });

  assert.equal(attempt.body.max_tokens, 16);
});

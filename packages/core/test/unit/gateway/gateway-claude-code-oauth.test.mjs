import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeClaudeCodeOauthProviderPlugins,
  prepareGatewayUpstreamAttemptForTest
} from "@ccr/core/gateway/service.ts";
import { localAgentOauthProviderHooks } from "@ccr/core/gateway/core-runtime/local-agent-auth-provider-hook.ts";
import { applyCompiledRouteRewrite, compileConfiguredRouteRewrite } from "@ccr/core/routing/rewrite.ts";

test("issue 1528 normalizes Claude Code OAuth auth to preserve the client anthropic-beta header", () => {
  const [plugin] = normalizeClaudeCodeOauthProviderPlugins([
    {
      auth: {
        headers: {
          authorization: "Bearer oauth-token",
          "anthropic-beta": "oauth-2025-04-20"
        },
        removeHeaders: ["x-api-key"],
        strict: true
      },
      key: "ccr-local-agent-claude-code-api-claude-code-oauth",
      providerName: "Claude Code API"
    }
  ]);

  assert.equal(plugin.auth.headers.authorization, "Bearer oauth-token");
  assert.deepEqual(plugin.auth.headers["anthropic-beta"], {
    default: "oauth-2025-04-20",
    from: "request.headers.anthropic-beta"
  });
  assert.equal(plugin.auth.strict, true);
});

test("issue 1528 merges Claude Code OAuth beta with client beta tokens only for the routed provider", () => {
  const claudeCodeProvider = {
    api_base_url: "https://api.anthropic.com",
    id: "provider-claude-code-api-test",
    models: ["claude-sonnet-5"],
    name: "Claude Code API",
    type: "anthropic_messages"
  };
  const otherProvider = {
    api_base_url: "https://anthropic.example/v1",
    id: "provider-other-anthropic-test",
    models: ["claude-other"],
    name: "Other Anthropic",
    type: "anthropic_messages"
  };
  const config = {
    Providers: [claudeCodeProvider, otherProvider],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {},
    providerPlugins: [
      {
        auth: {
          headers: {
            authorization: "Bearer oauth-token",
            "anthropic-beta": "oauth-2025-04-20"
          },
          strict: true
        },
        key: "ccr-local-agent-claude-code-api-claude-code-oauth",
        providerName: claudeCodeProvider.name
      }
    ]
  };

  const claudeCodeAttempt = prepareGatewayUpstreamAttemptForTest({
    body: { messages: [{ content: "hi", role: "user" }], model: "Claude Code API/claude-sonnet-5" },
    config,
    headers: { "anthropic-beta": "context-management-2025-06-27,effort-2025-11-24" },
    method: "POST",
    path: "/v1/messages"
  });
  const otherAttempt = prepareGatewayUpstreamAttemptForTest({
    body: { messages: [{ content: "hi", role: "user" }], model: "Other Anthropic/claude-other" },
    config,
    headers: { "anthropic-beta": "context-management-2025-06-27" },
    method: "POST",
    path: "/v1/messages"
  });

  assert.equal(
    claudeCodeAttempt.headers["anthropic-beta"],
    "context-management-2025-06-27,effort-2025-11-24,oauth-2025-04-20"
  );
  assert.equal(otherAttempt.headers["anthropic-beta"], "context-management-2025-06-27");
});


test("Fable fallback rewrites preserve client betas across Claude OAuth authentication", () => {
  const provider = {
    api_base_url: "https://api.anthropic.com",
    id: "provider-claude-code-api-test",
    models: ["claude-fable-5"],
    name: "Claude Code API",
    type: "anthropic_messages"
  };
  const config = {
    Providers: [provider],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 } },
    gateway: {},
    providerPlugins: normalizeClaudeCodeOauthProviderPlugins([{
      auth: {
        headers: {
          authorization: "Bearer oauth-token",
          "anthropic-beta": "oauth-2025-04-20"
        },
        removeHeaders: ["x-api-key"],
        strict: true
      },
      key: "ccr-local-agent-claude-code-api-claude-code-oauth",
      providerName: provider.name
    }])
  };
  const request = {
    body: {
      messages: [{ content: "hi", role: "user" }],
      model: "Claude Code API/claude-fable-5"
    },
    headers: {
      "anthropic-beta": "context-management-2025-06-27,effort-2025-11-24",
      "anthropic-version": "2023-06-01",
      "x-api-key": "client-key"
    }
  };
  for (const rewrite of [
    {
      key: "request.header.anthropic-beta",
      operation: "array-append",
      value: "server-side-fallback-2026-06-01"
    },
    {
      key: "request.body.fallbacks",
      operation: "set",
      value: '[{"model":"claude-opus-5"}]'
    }
  ]) {
    applyCompiledRouteRewrite(compileConfiguredRouteRewrite(rewrite).rewrite, request);
  }

  const attempt = prepareGatewayUpstreamAttemptForTest({
    ...request,
    config,
    method: "POST",
    path: "/v1/messages"
  });

  assert.equal(
    attempt.headers["anthropic-beta"],
    "context-management-2025-06-27,effort-2025-11-24,server-side-fallback-2026-06-01,oauth-2025-04-20"
  );
  assert.equal(attempt.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(attempt.body.fallbacks, [{ model: "claude-opus-5" }]);
});

test("Claude OAuth provider hooks bind an explicit runtime credential to its auth file", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-hook-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceFile = path.join(directory, "account.json");
  writeFileSync(sourceFile, JSON.stringify({
    account_uuid: "11111111-2222-4333-8444-555555555555",
    access_token: "synthetic-account-access",
    claude_device_ids: ["a".repeat(64)],
    expired: "2099-01-01T00:00:00.000Z",
    refresh_token: "synthetic-account-refresh"
  }), { mode: 0o600 });
  chmodSync(sourceFile, 0o600);
  const [hook] = localAgentOauthProviderHooks({
    providerPlugins: [{
      auth: {
        headers: {
          "anthropic-beta": "oauth-2025-04-20",
          "x-ccr-claude-oauth-source": sourceFile
        },
        removeHeaders: ["x-api-key", "x-ccr-claude-oauth-source"]
      },
      key: "ccr-local-agent-claude-pool-claude-code-oauth",
      providerName: "provider-claude-pool::anthropic_messages::cred:account-a"
    }]
  });

  const result = await hook.authenticate({
    request: { headers: {
      "anthropic-beta": "effort-2025-11-24",
      "x-claude-code-session-id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    } },
    upstreamRequest: {
      body: { messages: [{ content: "hi", role: "user" }], model: "claude-opus-5" },
      headers: { "x-api-key": "credential-selector" },
      url: "https://api.anthropic.com/v1/messages"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.headers.authorization, "Bearer synthetic-account-access");
  assert.equal(result.value.headers["x-api-key"], undefined);
  assert.equal(result.value.headers["x-ccr-claude-oauth-source"], undefined);
  assert.equal(result.value.headers["anthropic-beta"], "effort-2025-11-24,oauth-2025-04-20");
  assert.equal(result.value.headers["X-Claude-Code-Session-Id"], "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.deepEqual(JSON.parse(result.value.body.metadata.user_id), {
    account_uuid: "11111111-2222-4333-8444-555555555555",
    device_id: "a".repeat(64),
    session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  });

  const cachedBody = {
    model: "model-a",
    system: [{ type: "text", text: "System prompt.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [1, 2, 3].map(index => ({
      type: "text", text: `Document ${index}.`, cache_control: { type: "ephemeral" }
    })) }]
  };
  const cachedResult = await hook.authenticate({
    upstreamRequest: { body: cachedBody, url: "https://api.anthropic.com/v1/messages" }
  });
  assert.equal(cachedResult.ok, true);
  assert.equal(cachedResult.value.body.system[1].cache_control, undefined);
  assert.deepEqual(cachedResult.value.body.system.slice(2), cachedBody.system);
  assert.deepEqual(cachedResult.value.body.messages, cachedBody.messages);
});

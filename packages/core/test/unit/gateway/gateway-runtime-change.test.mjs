import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { mediaToolsConfigFromRawForTest, virtualModelProfileFromRawForTest } from "@ccr/core/config/config.ts";
import { shouldRestartGatewayForRuntimeConfigChange } from "@ccr/core/gateway/runtime-change.ts";

function createProviderRuntimeConfig() {
  const config = createDefaultAppConfig();
  config.Providers = [{
    account: {
      connectors: [{ auth: "provider-api-key", endpoint: "https://provider.example/account", type: "standard" }],
      enabled: true,
      refreshIntervalMs: 60_000
    },
    baseUrl: "https://provider.example/v1",
    credentials: [{
      account: {
        connectors: [{ auth: "provider-api-key", endpoint: "https://provider.example/credential/account", type: "standard" }],
        enabled: true,
        refreshIntervalMs: 60_000
      },
      apiKey: "credential-key",
      enabled: true,
      id: "primary",
      limits: { rpm: 60 },
      priority: 1,
      weight: 1
    }],
    enabled: true,
    models: ["model-a"],
    name: "Provider",
    type: "openai_chat_completions"
  }];
  return config;
}

test("ToolHub config changes restart the gateway runtime", () => {
  const previous = createDefaultAppConfig();
  const next = createDefaultAppConfig();
  next.toolHub = {
    ...next.toolHub,
    enabled: true,
    mcpServers: [
      {
        headers: { Authorization: "Bearer token" },
        name: "mcd-mcp",
        protocolVersion: "2024-11-05",
        requestTimeoutMs: 30000,
        startupTimeoutMs: 600000,
        transport: "streamable-http",
        url: "https://mcp.mcd.cn"
      }
    ]
  };

  assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), true);
});

test("media tool policy changes restart the gateway runtime", () => {
  const previous = createDefaultAppConfig();
  const next = createDefaultAppConfig();
  next.mediaTools.enabled = true;

  assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), true);
});

test("legacy Grok media input migrates only internal policy and drops xAI-specific execution fields", () => {
  const migrated = mediaToolsConfigFromRawForTest({
    allowedInputRoots: ["/tmp/media"],
    apiKey: "must-not-survive",
    artifactTtlHours: 48,
    backend: "xai-api",
    baseUrl: "https://api.x.ai/v1",
    enabled: true,
    imageModel: "legacy-image-model",
    maxImageConcurrency: 3,
    videoModel: "legacy-video-model"
  });

  assert.deepEqual(migrated, {
    allowedInputRoots: ["/tmp/media"],
    artifactTtlHours: 48,
    enabled: true,
    maxImageConcurrency: 3
  });
});

test("legacy virtual model tool loop limits are removed from application config", () => {
  const migrated = virtualModelProfileFromRawForTest({
    execution: {
      clientToolsPolicy: "allow",
      maxToolCalls: 8,
      maxTurns: 6,
      mode: "tool_loop",
      streamMode: "optimistic"
    },
    id: "fusion-media"
  });

  assert.deepEqual(migrated, {
    execution: {
      clientToolsPolicy: "allow",
      mode: "tool_loop",
      streamMode: "optimistic"
    },
    id: "fusion-media"
  });
});

test("upstream proxy config changes restart the gateway runtime", () => {
  const previous = createDefaultAppConfig();
  const next = createDefaultAppConfig();
  next.proxy.upstream = {
    custom: {
      password: "secret",
      port: 8888,
      server: "proxy.example.com",
      username: "alice"
    },
    mode: "custom"
  };

  assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), true);
});

test("raw trace observability config changes restart the gateway runtime", () => {
  const mutations = [
    (config) => { config.observability.requestLogs = !config.observability.requestLogs; },
    (config) => { config.observability.agentAnalysis = !config.observability.agentAnalysis; },
    (config) => { config.observability.requestLogBodyCapture = "none"; },
    (config) => { config.observability.requestLogMaxBodyBytes = 4 * 1024 * 1024; }
  ];

  for (const mutate of mutations) {
    const previous = createDefaultAppConfig();
    const next = createDefaultAppConfig();
    mutate(next);
    assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), true);
  }
});

test("main-process-only observability changes do not restart the gateway runtime", () => {
  const previous = createDefaultAppConfig();
  const next = createDefaultAppConfig();
  next.observability.requestLogSuccessSampleRate = 0.25;

  assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), false);
});

test("provider account management changes do not restart the gateway runtime", () => {
  const mutations = [
    ["connector", (provider) => { provider.account.connectors[0].endpoint = "https://provider.example/new-account"; }],
    ["enabled", (provider) => { provider.account.enabled = false; }],
    ["refresh interval", (provider) => { provider.account.refreshIntervalMs = 120_000; }]
  ];

  for (const [name, mutate] of mutations) {
    const previous = createProviderRuntimeConfig();
    const next = structuredClone(previous);
    mutate(next.Providers[0]);
    const previousProviders = structuredClone(previous.Providers);
    const nextProviders = structuredClone(next.Providers);

    assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), false, name);
    assert.deepEqual(previous.Providers, previousProviders, `${name} mutated the previous config`);
    assert.deepEqual(next.Providers, nextProviders, `${name} mutated the next config`);
  }
});

test("credential account connector changes do not restart the gateway runtime", () => {
  const previous = createProviderRuntimeConfig();
  const next = structuredClone(previous);
  next.Providers[0].credentials[0].account.connectors[0].endpoint = "https://provider.example/new-credential-account";

  assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), false);
});

test("provider routing changes restart the gateway runtime", () => {
  const mutations = [
    ["model", (provider) => { provider.models = ["model-b"]; }],
    ["endpoint", (provider) => { provider.baseUrl = "https://provider.example/v2"; }],
    ["enabled", (provider) => { provider.enabled = false; }],
    ["credential key", (provider) => { provider.credentials[0].apiKey = "new-key"; }],
    ["credential id", (provider) => { provider.credentials[0].id = "secondary"; }],
    ["credential priority", (provider) => { provider.credentials[0].priority = 2; }],
    ["credential weight", (provider) => { provider.credentials[0].weight = 2; }],
    ["credential limits", (provider) => { provider.credentials[0].limits = { rpm: 120 }; }]
  ];

  for (const [name, mutate] of mutations) {
    const previous = createProviderRuntimeConfig();
    const next = structuredClone(previous);
    mutate(next.Providers[0]);

    assert.equal(shouldRestartGatewayForRuntimeConfigChange(previous, next), true, name);
  }
});

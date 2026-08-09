import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claudeOauthUsageMetadataForTest,
  claudeOauthUsageMetersForTest,
  classifyProviderAccountRoutingSnapshot,
  invalidateProviderAccountSnapshotCache,
  localAgentProviderAccountCredentialForTest,
  localCodexAccountCredentialForTest,
  readProviderAccountRoutingState,
  resolveClaudeOauthUsageConnectorForTest,
  testProviderAccountConnector
} from "@ccr/core/providers/account-service.ts";
import {
  grokClientVersion,
  grokDefaultBillingEndpoint,
  grokDefaultBaseUrl,
  grokDefaultSubscriptionEndpoint,
  grokProviderAccountConfig
} from "@ccr/core/agents/local-providers/grok.ts";

const localAgentProviderApiKey = "ccr-local-agent-login";
const codexDefaultBaseUrl = "https://chatgpt.com/backend-api/codex";
const zcodeDefaultBaseUrl = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

function writeClaudeOauthSource(directory, name, accessToken = "synthetic-claude-access") {
  const sourceFile = path.join(directory, name);
  writeFileSync(sourceFile, JSON.stringify({
    access_token: accessToken,
    expired: "2099-01-01T00:00:00.000Z",
    refresh_token: "synthetic-claude-refresh"
  }), { mode: 0o600 });
  chmodSync(sourceFile, 0o600);
  return sourceFile;
}

function claudeUsagePayload(overrides = {}) {
  return {
    extra_usage: {
      currency: "EUR",
      is_enabled: true,
      monthly_limit: 300000,
      spend_limit_reached: false,
      used_credits: 119945,
      utilization: 39.98
    },
    five_hour: { resets_at: "2026-08-10T02:10:00Z", utilization: 0 },
    limits: [
      {
        kind: "weekly_scoped",
        percent: 34,
        resets_at: "2026-08-15T08:00:00Z",
        scope: { model: { display_name: "Fable", id: null } }
      }
    ],
    seven_day: { resets_at: "2026-08-15T08:00:00Z", utilization: 20 },
    seven_day_opus: null,
    seven_day_sonnet: null,
    ...overrides
  };
}

function claudeProfilePayload() {
  return {
    account: { email: "max@example.test" },
    organization: {
      has_extra_usage_enabled: true,
      rate_limit_tier: "default_claude_max_20x",
      subscription_status: "active"
    }
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for provider account refresh.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function routingSnapshot(meters, overrides = {}) {
  return {
    meters,
    provider: "Test Pool",
    source: "http-json",
    status: "ok",
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

const subscriptionFirstRouting = {
  billingMode: "subscription",
  mode: "subscription-first",
  requiredMeters: [
    { id: "session" },
    { id: "weekly" },
    { id: "scoped_weekly", models: ["claude-fable-5"] }
  ]
};

test("subscription routing applies model-scoped meters to exact normalized model IDs", () => {
  const snapshot = routingSnapshot([
    { id: "session", kind: "quota", label: "Session", remaining: 10, unit: "requests" },
    { id: "weekly", kind: "quota", label: "Weekly", remaining: 10, unit: "requests" }
  ]);

  assert.equal(classifyProviderAccountRoutingSnapshot(snapshot, subscriptionFirstRouting, "claude-sonnet-5"), "available");
  assert.equal(classifyProviderAccountRoutingSnapshot(snapshot, subscriptionFirstRouting, " CLAUDE-FABLE-5 "), "unavailable");
});

test("subscription routing treats an absent authoritative snapshot as unknown", () => {
  assert.equal(classifyProviderAccountRoutingSnapshot(undefined, subscriptionFirstRouting, "claude-fable-5"), "unknown");
});

test("subscription routing requires every applicable meter and honors minimum remaining", () => {
  const routing = {
    ...subscriptionFirstRouting,
    requiredMeters: [
      { id: "session", minimumRemaining: 2 },
      { id: "weekly" }
    ]
  };
  assert.equal(classifyProviderAccountRoutingSnapshot(routingSnapshot([
    { id: "session", kind: "quota", label: "Session", remaining: 3, unit: "requests" }
  ]), routing, "claude-fable-5"), "unavailable");
  assert.equal(classifyProviderAccountRoutingSnapshot(routingSnapshot([
    { id: "session", kind: "quota", label: "Session", remaining: 2, unit: "requests" }
  ]), routing, "claude-fable-5"), "exhausted");
  assert.equal(classifyProviderAccountRoutingSnapshot(routingSnapshot([
    { id: "session", kind: "quota", label: "Session", limit: 10, unit: "requests", used: 7 },
    { id: "weekly", kind: "quota", label: "Weekly", remaining: 1, unit: "requests" }
  ]), routing, "claude-fable-5"), "available");
});

test("subscription routing treats fresh connector, missing, and nonfinite meter data as unavailable", () => {
  const routing = {
    ...subscriptionFirstRouting,
    requiredMeters: [{ id: "session" }]
  };
  const meter = { id: "session", kind: "quota", label: "Session", remaining: Number.NaN, unit: "requests" };
  assert.equal(classifyProviderAccountRoutingSnapshot(routingSnapshot([meter]), routing), "unavailable");
  assert.equal(classifyProviderAccountRoutingSnapshot(routingSnapshot([], { status: "critical" }), routing), "unavailable");
  assert.equal(classifyProviderAccountRoutingSnapshot(routingSnapshot([
    { ...meter, remaining: 10 }
  ], {
    errors: [{ message: "connector failed", source: "http-json" }],
    status: "warning"
  }), routing), "unavailable");
});

test("Claude OAuth usage maps general, Fable-scoped, foreign-scoped, and extra-usage meters", () => {
  const payload = claudeUsagePayload({
    limits: [
      ...claudeUsagePayload().limits,
      {
        kind: "weekly_scoped",
        percent: 55,
        resets_at: "2026-08-15T09:00:00Z",
        scope: { model: { display_name: "Verse 2", id: null } }
      }
    ]
  });
  const meters = claudeOauthUsageMetersForTest(payload);

  assert.deepEqual(meters.map((meter) => meter.id), [
    "session",
    "weekly",
    "scoped_weekly",
    "scoped_weekly_verse_2",
    "spend"
  ]);
  assert.deepEqual(meters.find((meter) => meter.id === "session"), {
    id: "session",
    kind: "quota",
    label: "Session",
    limit: 100,
    remaining: 100,
    resetAt: "2026-08-10T02:10:00Z",
    source: "claude-oauth-usage",
    unit: "percent",
    used: 0,
    window: "5h"
  });
  assert.equal(meters.find((meter) => meter.id === "weekly")?.remaining, 80);
  assert.equal(meters.find((meter) => meter.id === "scoped_weekly")?.label, "Fable weekly");
  assert.equal(meters.find((meter) => meter.id === "scoped_weekly_verse_2")?.remaining, 45);
  assert.deepEqual(meters.find((meter) => meter.id === "spend"), {
    currency: "EUR",
    id: "spend",
    kind: "credits",
    label: "Extra usage",
    limit: 3000,
    remaining: 1800.55,
    source: "claude-oauth-usage",
    unit: "EUR",
    used: 1199.45,
    window: "monthly"
  });
  assert.deepEqual(claudeOauthUsageMetadataForTest(payload, claudeProfilePayload()), {
    accountEmail: "max@example.test",
    extraUsageEnabled: true,
    spendLimitReached: false,
    subscriptionStatus: "active",
    subscriptionTier: "default_claude_max_20x"
  });
});

test("Claude OAuth usage tolerates missing scoped limits and omits incomplete extra usage", () => {
  const payload = claudeUsagePayload({
    extra_usage: {
      is_enabled: true,
      monthly_limit: null,
      spend_limit_reached: true,
      used_credits: null,
      utilization: null
    },
    limits: undefined
  });
  const meters = claudeOauthUsageMetersForTest(payload);
  assert.deepEqual(meters.map((meter) => meter.id), ["session", "weekly"]);
  assert.equal(meters.some((meter) => meter.id === "spend"), false);
  assert.equal(claudeOauthUsageMetadataForTest(payload).spendLimitReached, true);
});

test("Fable exhaustion is independent from general Claude weekly headroom", () => {
  const meters = claudeOauthUsageMetersForTest(claudeUsagePayload({
    limits: [{
      kind: "weekly_scoped",
      percent: 100,
      resets_at: "2026-08-15T08:00:00Z",
      scope: { model: { display_name: "fAbLe" } }
    }]
  }));
  const snapshot = routingSnapshot(meters);

  assert.equal(classifyProviderAccountRoutingSnapshot(snapshot, subscriptionFirstRouting, "claude-fable-5"), "exhausted");
  assert.equal(classifyProviderAccountRoutingSnapshot(snapshot, subscriptionFirstRouting, "claude-opus-5"), "available");
  assert.equal(classifyProviderAccountRoutingSnapshot(snapshot, subscriptionFirstRouting, "claude-sonnet-5"), "available");
});

test("Claude OAuth usage resolves explicit and credential-plugin source files and fails clearly without either", async (t) => {
  invalidateProviderAccountSnapshotCache();
  t.after(() => invalidateProviderAccountSnapshotCache());
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-usage-source-"));
  const explicitSource = writeClaudeOauthSource(directory, "explicit.json", "synthetic-explicit-access");
  const pluginSource = writeClaudeOauthSource(directory, "plugin.json", "synthetic-plugin-access");
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ authorization: init?.headers?.Authorization, url: String(input) });
    return new Response(JSON.stringify(String(input).endsWith("/profile") ? claudeProfilePayload() : claudeUsagePayload()), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const credential = { apiKey: "opaque-account-a", id: "account-a", name: "Account A" };
  const provider = {
    api_base_url: "https://api.anthropic.com",
    credentials: [credential],
    id: "provider-claude-pool",
    models: ["claude-fable-5"],
    name: "Claude Pool",
    type: "anthropic_messages"
  };
  const plugin = {
    claudeOauth: { sourceFile: pluginSource },
    key: "ccr-local-agent-claude-pool-claude-code-oauth",
    providerName: "provider-claude-pool::anthropic_messages::cred:account-a"
  };

  const explicit = await resolveClaudeOauthUsageConnectorForTest(
    { providerPlugins: [plugin] },
    provider,
    { sourceFile: explicitSource, type: "claude-oauth-usage" },
    credential
  );
  assert.equal(explicit.accountEmail, "max@example.test");
  assert.equal(requests[0]?.authorization, "Bearer synthetic-explicit-access");

  const derived = await resolveClaudeOauthUsageConnectorForTest(
    { providerPlugins: [plugin] },
    provider,
    { type: "claude-oauth-usage" },
    credential
  );
  assert.equal(derived.subscriptionTier, "default_claude_max_20x");
  assert.equal(requests.some((request) => request.authorization === "Bearer synthetic-plugin-access"), true);

  const missing = await resolveClaudeOauthUsageConnectorForTest(
    { providerPlugins: [] },
    provider,
    { type: "claude-oauth-usage" },
    credential
  );
  assert.equal(missing.status, "error");
  assert.match(missing.errors[0]?.message ?? "", /source file was not configured/i);
  assert.equal(JSON.stringify(missing).includes("synthetic-"), false);
});

test("Claude OAuth usage deduplicates concurrent profile fetches per source file", async (t) => {
  invalidateProviderAccountSnapshotCache();
  t.after(() => invalidateProviderAccountSnapshotCache());
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-profile-cache-"));
  const sourceFile = writeClaudeOauthSource(directory, "account.json");
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  let profileRequests = 0;
  let usageRequests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/profile")) {
      profileRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify(claudeProfilePayload()), { headers: { "content-type": "application/json" }, status: 200 });
    }
    usageRequests += 1;
    return new Response(JSON.stringify(claudeUsagePayload()), { headers: { "content-type": "application/json" }, status: 200 });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const provider = {
    api_base_url: "https://api.anthropic.com",
    id: "provider-claude-pool",
    models: ["claude-fable-5"],
    name: "Claude Pool",
    type: "anthropic_messages"
  };
  const connector = { sourceFile, type: "claude-oauth-usage" };

  await Promise.all([
    resolveClaudeOauthUsageConnectorForTest({ providerPlugins: [] }, provider, connector),
    resolveClaudeOauthUsageConnectorForTest({ providerPlugins: [] }, provider, connector)
  ]);
  await resolveClaudeOauthUsageConnectorForTest({ providerPlugins: [] }, provider, connector);

  assert.equal(usageRequests, 3);
  assert.equal(profileRequests, 1);
});

test("Claude OAuth usage caches profile hourly, honors capped Retry-After, and serves a good snapshot for 15 minutes", async (t) => {
  invalidateProviderAccountSnapshotCache();
  t.after(() => invalidateProviderAccountSnapshotCache());
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-10T00:00:00Z") });
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-usage-stale-"));
  const sourceFile = writeClaudeOauthSource(directory, "account.json");
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  let usageRequests = 0;
  let profileRequests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/profile")) {
      profileRequests += 1;
      return new Response(JSON.stringify(claudeProfilePayload()), { headers: { "content-type": "application/json" }, status: 200 });
    }
    usageRequests += 1;
    if (usageRequests === 1) {
      return new Response(JSON.stringify(claudeUsagePayload()), { headers: { "content-type": "application/json" }, status: 200 });
    }
    return new Response("rate limited", { headers: { "retry-after": "3600" }, status: 429 });
  };
  t.after(() => { globalThis.fetch = previousFetch; });

  const account = {
    connectors: [{ sourceFile, type: "claude-oauth-usage" }],
    enabled: true,
    refreshIntervalMs: 30_000,
    routing: subscriptionFirstRouting
  };
  const credential = { account, apiKey: "opaque-account", id: "account" };
  const provider = {
    api_base_url: "https://api.anthropic.com",
    credentials: [credential],
    id: "provider-claude-pool",
    models: ["claude-fable-5"],
    name: "Claude Pool",
    type: "anthropic_messages"
  };
  const config = { Providers: [provider], Router: { rules: [] }, gateway: {}, providerPlugins: [] };

  assert.equal(readProviderAccountRoutingState(config, provider, credential, "claude-fable-5"), "unknown");
  await waitFor(() => usageRequests === 1 && profileRequests === 1);
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "claude-fable-5"), "available");
  assert.equal(profileRequests, 1);
  await new Promise((resolve) => setImmediate(resolve));

  t.mock.timers.setTime(Date.now() + 30_001);
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "claude-fable-5"), "available");
  await waitFor(() => usageRequests === 2);
  assert.equal(profileRequests, 1);
  await new Promise((resolve) => setImmediate(resolve));

  t.mock.timers.setTime(Date.parse("2026-08-10T00:14:59Z"));
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "claude-fable-5"), "available");
  assert.equal(usageRequests, 2);

  t.mock.timers.setTime(Date.parse("2026-08-10T00:15:01Z"));
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "claude-fable-5"), "unknown");
  await waitFor(() => readProviderAccountRoutingState(config, provider, credential, "claude-fable-5") === "unavailable");
  assert.equal(usageRequests, 3);
});

test("Grok billing connector maps credit usage payload", async (t) => {
  const previousFetch = globalThis.fetch;
  let authorization = "";
  let clientIdentifier = "";
  let clientVersion = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), grokDefaultBillingEndpoint);
    authorization = init?.headers?.authorization ?? "";
    clientIdentifier = init?.headers?.["x-grok-client-identifier"] ?? "";
    clientVersion = init?.headers?.["x-grok-client-version"] ?? "";
    return new Response(JSON.stringify({
      config: {
        billingPeriodEnd: "2026-08-01T00:00:00Z",
        creditUsagePercent: { val: 25 },
        includedUsed: { val: 10 },
        monthlyLimit: { val: 40 },
        onDemandCap: { val: 100 },
        onDemandUsed: { val: 5 },
        prepaidBalance: { val: 12 },
        totalUsed: { val: 15 }
      }
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const connector = grokProviderAccountConfig().connectors?.[0];
  assert.equal(connector?.type, "http-json");
  const result = await testProviderAccountConnector({
    apiKey: "grok-access-token",
    baseUrl: grokDefaultBaseUrl,
    connector,
    providerName: "Grok CLI API"
  });

  assert.equal(authorization, "Bearer grok-access-token");
  assert.equal(clientIdentifier, "xai-grok-cli");
  assert.equal(clientVersion, grokClientVersion());
  assert.equal(result.meters.find((meter) => meter.id === "grok_credit_usage_percent")?.remaining, 75);
  assert.equal(result.meters.find((meter) => meter.id === "grok_included_credits")?.remaining, 30);
  assert.equal(result.meters.find((meter) => meter.id === "grok_total_credits")?.used, 15);
  assert.equal(result.meters.find((meter) => meter.id === "grok_pay_as_you_go_cap")?.remaining, 95);
  assert.equal(result.meters.find((meter) => meter.id === "grok_prepaid_balance")?.remaining, 12);
});

test("Grok subscription connector maps access status payload", async (t) => {
  const previousFetch = globalThis.fetch;
  let authorization = "";
  let clientIdentifier = "";
  let clientVersion = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), grokDefaultSubscriptionEndpoint);
    authorization = init?.headers?.authorization ?? "";
    clientIdentifier = init?.headers?.["x-grok-client-identifier"] ?? "";
    clientVersion = init?.headers?.["x-grok-client-version"] ?? "";
    return new Response(JSON.stringify({
      hasGrokCodeAccess: true,
      subscriptionTier: "SuperGrok Heavy"
    }), { headers: { "content-type": "application/json" }, status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const connector = grokProviderAccountConfig().connectors?.[1];
  assert.equal(connector?.type, "http-json");
  const result = await testProviderAccountConnector({
    apiKey: "grok-access-token",
    baseUrl: grokDefaultBaseUrl,
    connector,
    providerName: "Grok CLI API"
  });

  assert.equal(authorization, "Bearer grok-access-token");
  assert.equal(clientIdentifier, "xai-grok-cli");
  assert.equal(clientVersion, grokClientVersion());
  assert.equal(result.status, "ok");
  assert.equal(result.message, "SuperGrok Heavy");
  assert.equal(result.meters.find((meter) => meter.id === "grok_subscription_access")?.remaining, 100);
});

test("Codex local account credential refreshes when only a refresh token is available", async (t) => {
  const previousHome = process.env.CCR_INTERNAL_HOME_DIR;
  const home = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-account-refresh-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  process.env.CCR_INTERNAL_HOME_DIR = home;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousHome;
    }
  });

  let requestBody = "";
  let requestUrl = "";
  const accessToken = jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-refreshed"
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "api.connectors.read api.connectors.invoke"
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: "refresh-next",
        scope: "api.connectors.read api.connectors.invoke"
      }),
      { headers: { "content-type": "application/json" }, status: 200 }
    );
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const credential = await localCodexAccountCredentialForTest({
    codexOauth: {
      refreshToken: "refresh-only",
      tokenEndpoint: "http://127.0.0.1/oauth/token"
    },
    key: "ccr-local-agent-codex-api-codex-oauth",
    providerName: "Codex API"
  });

  assert.equal(credential.apiKey, accessToken);
  assert.equal(credential.headers?.["ChatGPT-Account-Id"], "acct-refreshed");
  assert.equal(requestUrl, "http://127.0.0.1/oauth/token");
  assert.deepEqual(JSON.parse(requestBody), {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: "refresh-only",
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke"
  });
});

test("Codex local account credential matches internal provider plugin names", async (t) => {
  useTemporaryCodexHome(t, "ccr-codex-account-internal-plugin-");
  const accessToken = jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-internal"
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "api.connectors.read api.connectors.invoke"
  });

  const credential = await localAgentProviderAccountCredentialForTest({
    providerPlugins: [
      {
        codexOauth: {
          accessToken
        },
        key: "ccr-local-agent-codex-api-codex-oauth-internal",
        providerName: "codex-api::openai_responses"
      }
    ]
  }, {
    api_base_url: codexDefaultBaseUrl,
    api_key: localAgentProviderApiKey,
    id: "codex-api",
    models: ["gpt-5-codex"],
    name: "Renamed Codex API",
    type: "openai_responses"
  });

  assert.equal(credential?.apiKey, accessToken);
  assert.equal(credential?.headers?.["ChatGPT-Account-Id"], "acct-internal");
});

test("Codex local account credential falls back to the live auth file when plugin is missing", async (t) => {
  const home = useTemporaryCodexHome(t, "ccr-codex-account-live-auth-");
  const codexHome = path.join(home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const accessToken = jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-live"
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
    scope: "api.connectors.read api.connectors.invoke"
  });
  writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken
    }
  }));

  const credential = await localAgentProviderAccountCredentialForTest({
    providerPlugins: []
  }, {
    api_base_url: codexDefaultBaseUrl,
    api_key: localAgentProviderApiKey,
    id: "codex-api",
    models: ["gpt-5-codex"],
    name: "Codex API",
    type: "openai_responses"
  });

  assert.equal(credential?.apiKey, accessToken);
  assert.equal(credential?.headers?.["ChatGPT-Account-Id"], "acct-live");
});

test("Claude Code local account credential prefers live macOS Keychain token", { skip: process.platform === "win32" }, async (t) => {
  const home = useTemporaryHome(t, "ccr-claude-code-account-live-keychain-");
  usePlatform(t, "darwin");
  useFakeSecurityOutput(t, {
    access_token: "keychain-account-token",
    refresh_token: "keychain-refresh-token"
  });
  process.env.HOME = home;

  const credential = await localAgentProviderAccountCredentialForTest({
    providerPlugins: [
      {
        auth: {
          headers: {
            authorization: "Bearer imported-stale-token",
            "anthropic-beta": "oauth-2025-04-20"
          },
          strict: true
        },
        key: "ccr-local-agent-claude-code-api-claude-code-oauth-internal",
        providerName: "claude-code-api::anthropic_messages"
      }
    ]
  }, {
    api_base_url: "https://api.anthropic.com",
    api_key: localAgentProviderApiKey,
    id: "claude-code-api",
    models: ["claude-sonnet-5"],
    name: "Renamed Claude Code API",
    type: "anthropic_messages"
  });

  assert.equal(credential?.apiKey, "keychain-account-token");
  assert.equal(credential?.headers?.authorization, undefined);
  assert.equal(credential?.headers?.["anthropic-beta"], "oauth-2025-04-20");
});

test("Kimi local account credential carries its API key and CLI identity", async (t) => {
  const home = useTemporaryCodexHome(t, "ccr-kimi-account-plugin-");
  const previousVersion = process.env.KIMI_CODE_VERSION;
  process.env.KIMI_CODE_VERSION = "0.27.0-test";
  t.after(() => {
    if (previousVersion === undefined) delete process.env.KIMI_CODE_VERSION;
    else process.env.KIMI_CODE_VERSION = previousVersion;
  });

  const credential = await localAgentProviderAccountCredentialForTest({
    providerPlugins: [
      {
        auth: {
          headers: { authorization: "Bearer kimi-plugin-key" },
          strict: true
        },
        key: "ccr-local-agent-kimi-api-kimi-cli-api-key-internal",
        providerName: "kimi-api::openai_chat_completions"
      }
    ]
  }, {
    api_base_url: "https://api.kimi.com/coding/v1",
    api_key: localAgentProviderApiKey,
    id: "kimi-api",
    models: ["k3"],
    name: "Renamed Kimi API",
    type: "openai_chat_completions"
  });

  assert.equal(credential?.apiKey, "kimi-plugin-key");
  assert.equal(credential?.headers?.["User-Agent"], "kimi-code-cli/0.27.0-test");
  assert.equal(credential?.headers?.["X-Msh-Platform"], "kimi_code_cli");
  assert.ok(credential?.headers?.["X-Msh-Device-Id"]);
  assert.equal(existsSync(path.join(home, ".kimi-code", "device_id")), true);
});

test("ZCode local account credential matches internal provider plugin names", async () => {
  const credential = await localAgentProviderAccountCredentialForTest({
    providerPlugins: [
      {
        auth: {
          headers: {
            "x-api-key": "zcode-plugin-key"
          },
          removeHeaders: ["authorization"],
          strict: true
        },
        key: "ccr-local-agent-zcode-api-zcode-api-key-internal",
        providerName: "zcode-api::anthropic_messages"
      }
    ]
  }, {
    api_base_url: zcodeDefaultBaseUrl,
    api_key: localAgentProviderApiKey,
    id: "zcode-api",
    models: ["GLM-5.2"],
    name: "Renamed ZCode API",
    type: "anthropic_messages"
  });

  assert.equal(credential?.apiKey, "zcode-plugin-key");
});

test("ZCode local account credential falls back to the live config when plugin is missing", async (t) => {
  const home = useTemporaryCodexHome(t, "ccr-zcode-account-live-config-");
  const zcodeConfigDir = path.join(home, ".zcode", "cli");
  mkdirSync(zcodeConfigDir, { recursive: true });
  writeFileSync(path.join(zcodeConfigDir, "config.json"), JSON.stringify({
    provider: {
      zcode: {
        enabled: true,
        kind: "anthropic",
        models: ["GLM-5.2"],
        name: "ZCode",
        options: {
          apiKey: "zcode-live-key",
          baseURL: zcodeDefaultBaseUrl
        }
      }
    }
  }));

  const credential = await localAgentProviderAccountCredentialForTest({
    providerPlugins: []
  }, {
    api_base_url: zcodeDefaultBaseUrl,
    api_key: localAgentProviderApiKey,
    id: "zcode-api",
    models: ["GLM-5.2"],
    name: "ZCode API",
    type: "anthropic_messages"
  });

  assert.equal(credential?.apiKey, "zcode-live-key");
});

function useTemporaryCodexHome(t, prefix) {
  const home = useTemporaryHome(t, prefix);
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  return home;
}

function useTemporaryHome(t, prefix) {
  const previousHome = process.env.CCR_INTERNAL_HOME_DIR;
  const previousOsHome = process.env.HOME;
  const previousZcodeHome = process.env.ZCODE_HOME;
  const previousZcodeStorageDir = process.env.ZCODE_STORAGE_DIR;
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CCR_INTERNAL_HOME_DIR = home;
  delete process.env.ZCODE_HOME;
  delete process.env.ZCODE_STORAGE_DIR;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.CCR_INTERNAL_HOME_DIR;
    } else {
      process.env.CCR_INTERNAL_HOME_DIR = previousHome;
    }
    if (previousOsHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousOsHome;
    }
    if (previousZcodeHome === undefined) {
      delete process.env.ZCODE_HOME;
    } else {
      process.env.ZCODE_HOME = previousZcodeHome;
    }
    if (previousZcodeStorageDir === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previousZcodeStorageDir;
    }
    rmSync(home, { force: true, recursive: true });
  });
  return home;
}

function usePlatform(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform
  });
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
  });
}

function useFakeSecurityOutput(t, output) {
  const binDir = mkdtempSync(path.join(os.tmpdir(), "ccr-security-bin-"));
  const securityPath = path.join(binDir, "security");
  const previousPath = process.env.PATH;
  writeFileSync(securityPath, `#!/bin/sh\ncat <<'CCR_KEYCHAIN_JSON'\n${JSON.stringify(output)}\nCCR_KEYCHAIN_JSON\n`);
  chmodSync(securityPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    rmSync(binDir, { force: true, recursive: true });
  });
}

function jwt(payload) {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url(payload),
    "signature"
  ].join(".");
}

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

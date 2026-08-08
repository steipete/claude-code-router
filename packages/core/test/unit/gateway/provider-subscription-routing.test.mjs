import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchUpstreamWithFallback,
  prepareGatewayUpstreamAttemptForTest,
  selectSubscriptionFirstCredentialLane
} from "@ccr/core/gateway/upstream/executor.ts";
import { invalidateProviderAccountSnapshotCache, readProviderAccountRoutingState } from "@ccr/core/providers/account-service.ts";
import { RequestRouteTraceRecorder } from "@ccr/core/observability/route-trace.ts";
import { recordProviderCredentialOutcome } from "@ccr/core/providers/credential-pool.ts";

function laneCandidate(credential, billingMode, state) {
  return { billingMode, credential, state };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for account refresh.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("subscription-first lane treats paid credentials with quota as free", () => {
  assert.deepEqual(selectSubscriptionFirstCredentialLane([
    laneCandidate("subscription", "subscription", "exhausted"),
    laneCandidate("paid-with-quota", "paid-fallback", "available")
  ]), {
    credentials: ["paid-with-quota"],
    lane: "subscription"
  });
});

test("subscription-first lane withholds exhausted paid credentials while subscription quota is available or unknown", () => {
  for (const subscriptionState of ["available", "unknown"]) {
    assert.deepEqual(selectSubscriptionFirstCredentialLane([
      laneCandidate("subscription", "subscription", subscriptionState),
      laneCandidate("paid", "paid-fallback", "exhausted")
    ]), {
      credentials: ["subscription"],
      lane: "subscription"
    });
  }
});

test("subscription-first lane selects exhausted paid credentials only after subscriptions are exhausted", () => {
  assert.deepEqual(selectSubscriptionFirstCredentialLane([
    laneCandidate("subscription-a", "subscription", "exhausted"),
    laneCandidate("subscription-b", "subscription", "exhausted"),
    laneCandidate("paid", "paid-fallback", "exhausted")
  ]), {
    credentials: ["paid"],
    lane: "paid-fallback"
  });
});

test("subscription-first lane fails closed for unknown paid credentials", () => {
  assert.deepEqual(selectSubscriptionFirstCredentialLane([
    laneCandidate("subscription", "subscription", "exhausted"),
    laneCandidate("paid", "paid-fallback", "unknown")
  ]), {
    credentials: [],
    lane: "quota-blocked"
  });
});

test("providers without subscription-first policy retain legacy priority, weight, and affinity selection", () => {
  const config = {
    Providers: [{
      api_base_url: "https://api.anthropic.com",
      credentialSessionAffinity: true,
      credentials: [
        { apiKey: "synthetic-a", id: "a", priority: 2, weight: 100 },
        { apiKey: "synthetic-b", id: "b", priority: 1, weight: 2 },
        { apiKey: "synthetic-c", id: "c", priority: 1, weight: 1 }
      ],
      id: "legacy-pool",
      models: ["claude-test"],
      name: "Legacy Pool",
      type: "anthropic_messages"
    }],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 }, rules: [] },
    gateway: {}
  };
  const prepare = () => prepareGatewayUpstreamAttemptForTest({
    body: { max_tokens: 8, messages: [], model: "Legacy Pool/claude-test" },
    config,
    headers: { "x-claude-code-session-id": "stable-session" },
    method: "POST",
    path: "/v1/messages"
  });

  const first = prepare();
  const second = prepare();
  assert.deepEqual(first.credentialIds, second.credentialIds);
  assert.deepEqual(new Set(first.credentialIds.slice(0, 2)), new Set(["b", "c"]));
  assert.equal(first.credentialIds[2], "a");
  assert.equal(first.headers["x-ccr-provider-credential-quota-lane"], undefined);
});

test("providers without subscription-first policy retain legacy local-limit spillover", () => {
  const config = {
    Providers: [{
      api_base_url: "https://api.anthropic.com",
      credentials: [
        { apiKey: "synthetic-primary", id: "primary", limits: { maxRequests: 10, windowMs: 60_000 }, priority: 1 },
        { apiKey: "synthetic-secondary", id: "secondary", limits: { maxRequests: 10, windowMs: 60_000 }, priority: 2 }
      ],
      id: "legacy-spillover-pool",
      models: ["claude-test"],
      name: "Legacy Spillover Pool",
      type: "anthropic_messages"
    }],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 }, rules: [] },
    gateway: {}
  };
  const prepare = () => prepareGatewayUpstreamAttemptForTest({
    body: { max_tokens: 8, messages: [], model: "Legacy Spillover Pool/claude-test" },
    config,
    headers: {},
    method: "POST",
    path: "/v1/messages"
  });
  const initial = prepare();
  assert.deepEqual(initial.credentialIds, ["primary", "secondary"]);
  const outcomeAttempt = {
    body: Buffer.from('{"messages":[]}'),
    credentialChain: [initial.credentialChain[0]],
    credentialProtocol: initial.credentialProtocol,
    logicalProvider: initial.logicalProvider
  };
  for (let index = 0; index < 8; index += 1) {
    recordProviderCredentialOutcome(config, "POST", outcomeAttempt, 200, new Headers());
  }

  assert.deepEqual(prepare().credentialIds, ["secondary", "primary"]);
});

test("free-lane cooldown and local-limit saturation never spill to paid fallback", async (t) => {
  invalidateProviderAccountSnapshotCache();
  t.after(() => invalidateProviderAccountSnapshotCache());
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => new Response(JSON.stringify({
    remaining: String(input).endsWith("/subscription") ? 10 : 0
  }), {
    headers: { "content-type": "application/json" },
    status: 200
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const account = (billingMode, endpoint) => ({
    connectors: [{
      endpoint,
      mapping: {
        meters: [{ id: "weekly", kind: "quota", label: "Weekly", remaining: "$.remaining", unit: "requests" }]
      },
      type: "http-json"
    }],
    enabled: true,
    routing: {
      billingMode,
      mode: "subscription-first",
      requiredMeters: [{ id: "weekly" }]
    }
  });
  const config = {
    Providers: [{
      api_base_url: "https://api.anthropic.com",
      credentials: [
        {
          account: account("subscription", "https://quota-lane.example/subscription"),
          apiKey: "synthetic-subscription-key",
          id: "subscription",
          limits: { maxRequests: 1, windowMs: 60_000 }
        },
        {
          account: account("paid-fallback", "https://quota-lane.example/paid"),
          apiKey: "synthetic-paid-key",
          id: "paid"
        }
      ],
      id: "saturation-pool",
      models: ["claude-test"],
      name: "Saturation Pool",
      type: "anthropic_messages"
    }],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 }, rules: [] },
    gateway: {}
  };
  const provider = config.Providers[0];
  const [subscription, paid] = provider.credentials;
  readProviderAccountRoutingState(config, provider, subscription, "claude-test");
  readProviderAccountRoutingState(config, provider, paid, "claude-test");
  await waitFor(() =>
    readProviderAccountRoutingState(config, provider, subscription, "claude-test") === "available" &&
    readProviderAccountRoutingState(config, provider, paid, "claude-test") === "exhausted"
  );
  const prepare = () => prepareGatewayUpstreamAttemptForTest({
    body: { max_tokens: 8, messages: [], model: "Saturation Pool/claude-test" },
    config,
    headers: {},
    method: "POST",
    path: "/v1/messages"
  });
  const initial = prepare();
  assert.deepEqual(initial.credentialIds, ["subscription"]);
  assert.equal(initial.headers["x-ccr-provider-credential-quota-lane"], "subscription");

  const outcomeAttempt = {
    body: Buffer.from('{"messages":[]}'),
    credentialChain: initial.credentialChain,
    credentialProtocol: initial.credentialProtocol,
    logicalProvider: initial.logicalProvider
  };
  recordProviderCredentialOutcome(config, "POST", outcomeAttempt, 503, new Headers());
  const cooling = prepare();
  assert.deepEqual(cooling.credentialIds, ["subscription"]);
  assert.equal(cooling.headers["x-ccr-provider-credential-saturated"], "true");

  recordProviderCredentialOutcome(config, "POST", outcomeAttempt, 200, new Headers());
  const locallyBlocked = prepare();
  assert.deepEqual(locallyBlocked.credentialIds, ["subscription"]);
  assert.equal(locallyBlocked.headers["x-ccr-provider-credential-saturated"], "true");
});

test("quota-blocked selection returns an empty chain and never reaches the model upstream", async (t) => {
  invalidateProviderAccountSnapshotCache();
  t.after(() => invalidateProviderAccountSnapshotCache());
  const previousFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (input) => {
    fetchedUrls.push(String(input));
    return new Response(JSON.stringify({ remaining: 0 }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const account = {
    connectors: [{
      endpoint: "https://quota.example/paid",
      mapping: {
        meters: [{ id: "weekly", kind: "quota", label: "Weekly", remaining: "$.remaining", unit: "requests" }]
      },
      type: "http-json"
    }],
    enabled: true,
    routing: {
      billingMode: "paid-fallback",
      mode: "subscription-first",
      requiredMeters: [{ id: "weekly" }]
    }
  };
  const config = {
    Providers: [{
      api_base_url: "https://api.anthropic.com",
      credentials: [{ account, apiKey: "synthetic-paid-key", id: "private-paid-account" }],
      id: "safe-pool",
      models: ["claude-test"],
      name: "Safe Pool",
      type: "anthropic_messages"
    }],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 }, rules: [] },
    gateway: {},
    virtualModelProfiles: []
  };
  const trace = new RequestRouteTraceRecorder(Date.now());
  const result = await fetchUpstreamWithFallback({
    body: Buffer.from(JSON.stringify({ max_tokens: 8, messages: [], model: "Safe Pool/claude-test" })),
    config,
    coreAuthToken: "core-token",
    fallback: config.Router.fallback,
    headers: {},
    method: "POST",
    path: "/v1/messages",
    routedModel: "Safe Pool/claude-test",
    trace,
    upstreamUrl: "https://model-upstream.example/v1/messages"
  });

  assert.equal(result.response.status, 503);
  assert.deepEqual(result.attempt.credentialChain, []);
  assert.deepEqual(result.attempt.credentialIds, []);
  assert.equal(result.attempt.headers["x-ccr-provider-credential-quota-lane"], "quota-blocked");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetchedUrls, ["https://quota.example/paid"]);
  assert.equal(JSON.stringify(result.attempt.headers).includes("private-paid-account"), false);
  assert.equal(JSON.stringify(result.attempt.headers).includes("synthetic-paid-key"), false);
  const routingDecision = trace.finish().hops.find((hop) => hop.name === "upstream.attempt.prepare")?.decision;
  assert.deepEqual(routingDecision, {
    reason: "quota-blocked",
    source: "provider-account-routing"
  });
});

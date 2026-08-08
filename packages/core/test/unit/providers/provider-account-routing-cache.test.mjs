import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateProviderAccountSnapshotCache,
  readProviderAccountRoutingState
} from "@ccr/core/providers/account-service.ts";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for account refresh.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("routing cache treats stale and missing snapshots as unknown and dedupes background refresh", async (t) => {
  invalidateProviderAccountSnapshotCache();
  t.after(() => invalidateProviderAccountSnapshotCache());
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let now = 1_800_000_000_000;
  let fetchCount = 0;
  Date.now = () => now;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ remaining: 5 }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
  };
  t.after(() => {
    Date.now = previousNow;
    globalThis.fetch = previousFetch;
  });

  const account = {
    connectors: [{
      endpoint: "https://quota-cache.example/usage",
      mapping: {
        meters: [{ id: "weekly", kind: "quota", label: "Weekly", remaining: "$.remaining", unit: "requests" }]
      },
      type: "http-json"
    }],
    enabled: true,
    refreshIntervalMs: 30_000,
    routing: {
      billingMode: "subscription",
      mode: "subscription-first",
      requiredMeters: [{ id: "weekly" }]
    }
  };
  const config = {
    Providers: [{
      api_base_url: "https://api.example",
      credentials: [{ account, apiKey: "synthetic-cache-key", id: "cache-credential" }],
      id: "routing-cache",
      models: ["model-a"],
      name: "Routing Cache",
      type: "anthropic_messages"
    }],
    Router: { fallback: { mode: "off", models: [], retryCount: 0 }, rules: [] },
    gateway: {}
  };
  const provider = config.Providers[0];
  const credential = provider.credentials[0];

  assert.equal(readProviderAccountRoutingState(config, provider, credential, "model-a"), "unknown");
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "model-a"), "unknown");
  await waitFor(() => fetchCount === 1);
  await waitFor(() => readProviderAccountRoutingState(config, provider, credential, "model-a") === "available");
  assert.equal(fetchCount, 1);

  now += 30_001;
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "model-a"), "unknown");
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "model-a"), "unknown");
  await waitFor(() => fetchCount === 2);
  assert.equal(fetchCount, 2);

  invalidateProviderAccountSnapshotCache("Routing Cache");
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "model-a"), "unknown");
  assert.equal(readProviderAccountRoutingState(config, provider, credential, "model-a"), "unknown");
  await waitFor(() => fetchCount === 3);
  assert.equal(fetchCount, 3);
});

import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppConfig, ProviderAccountSnapshot } from "@ccr/core/contracts/app";
import { fallbackConfig } from "@ccr/ui/pages/home/shared/fallbacks.ts";
import { AppI18nContext, appCopy } from "@ccr/ui/pages/home/shared/i18n.tsx";
import {
  claudeSubscriptionRows,
  plainSubscriptionTier,
  SubscriptionsView,
  subscriptionRoutingState
} from "@ccr/ui/pages/home/components/subscriptions.tsx";

function subscriptionConfig(): AppConfig {
  return {
    ...fallbackConfig,
    Providers: [{
      api_base_url: "https://api.anthropic.com",
      credentials: [
        {
          account: {
            connectors: [{ type: "claude-oauth-usage" }],
            enabled: true,
            routing: {
              billingMode: "auto",
              mode: "subscription-first",
              requiredMeters: [
                { id: "session" },
                { id: "weekly" },
                { id: "scoped_weekly", models: ["claude-fable-5"] }
              ]
            }
          },
          apiKey: "opaque-a",
          id: "account-a",
          name: "Primary Max"
        },
        {
          apiKey: "opaque-b",
          enabled: false,
          id: "account-b",
          name: "Paused Max"
        }
      ],
      enabled: true,
      id: "provider-claude-pool",
      models: ["claude-fable-5", "claude-sonnet-5"],
      name: "Claude Pool",
      type: "anthropic_messages"
    }]
  };
}

function subscriptionSnapshot(overrides: Partial<ProviderAccountSnapshot> = {}): ProviderAccountSnapshot {
  return {
    accountEmail: "max@example.test",
    credentialId: "account-a",
    credentialLabel: "Primary Max",
    extraUsageEnabled: true,
    meters: [
      { id: "session", kind: "quota", label: "Session", limit: 100, remaining: 80, resetAt: "2026-08-10T02:10:00Z", unit: "percent", used: 20, window: "5h" },
      { id: "weekly", kind: "quota", label: "Weekly", limit: 100, remaining: 60, resetAt: "2026-08-15T08:00:00Z", unit: "percent", used: 40, window: "weekly" },
      { id: "scoped_weekly", kind: "quota", label: "Fable weekly", limit: 100, remaining: 25, resetAt: "2026-08-15T08:00:00Z", unit: "percent", used: 75, window: "weekly" },
      { currency: "EUR", id: "spend", kind: "credits", label: "Extra usage", limit: 3000, remaining: 1800.55, unit: "EUR", used: 1199.45, window: "monthly" }
    ],
    provider: "Claude Pool",
    source: "claude-oauth-usage",
    spendLimitReached: true,
    status: "ok",
    subscriptionStatus: "active",
    subscriptionTier: "default_claude_max_20x",
    updatedAt: "2026-08-10T00:00:00Z",
    ...overrides
  };
}

test("subscriptions page renders independent quota windows, spend state, lanes, and capacity summary", () => {
  const html = renderToStaticMarkup(
    <SubscriptionsView
      config={subscriptionConfig()}
      providerAccountRefreshing={false}
      providerAccounts={[subscriptionSnapshot()]}
      refreshProviderAccounts={() => undefined}
    />
  );

  assert.match(html, /Primary Max/);
  assert.match(html, /max@example.test/);
  assert.match(html, /Max 20x/);
  assert.match(html, /Paused Max/);
  assert.match(html, /Disabled/);
  assert.match(html, /Session/);
  assert.match(html, /Weekly/);
  assert.match(html, /Fable weekly/);
  assert.match(html, /Separate allowance/);
  assert.match(html, /1199.45 \/ 3000.00 EUR/);
  assert.match(html, /Spend limit reached/);
  assert.match(html, /Auto → Paid fallback/);
  assert.match(html, /Paid subscription/);
  assert.match(html, /1 confirmed with Fable headroom; 1 confirmed with general weekly headroom/);
});

test("subscriptions page degrades missing snapshots to unknown without hiding credentials", () => {
  const rows = claudeSubscriptionRows(subscriptionConfig(), []);
  assert.equal(rows.length, 2);
  assert.equal(subscriptionRoutingState(rows[0]), "unknown");

  const html = renderToStaticMarkup(
    <SubscriptionsView config={subscriptionConfig()} providerAccountRefreshing={false} providerAccounts={[]} />
  );
  assert.match(html, /Primary Max/);
  assert.match(html, /unknown/i);
  assert.match(html, /Usage unavailable/);
  assert.match(html, /capacity is not inferred for those accounts/);
  assert.doesNotMatch(html, /Throttle Fable traffic or add subscription capacity/);
});

test("subscription tier labels recognize Max and Pro while preserving unknown tiers", () => {
  assert.equal(plainSubscriptionTier("default_claude_max_5x"), "Max 5x");
  assert.equal(plainSubscriptionTier("default_claude_max_20x"), "Max 20x");
  assert.equal(plainSubscriptionTier("pro"), "Pro");
  assert.equal(plainSubscriptionTier("enterprise_custom"), "enterprise_custom");
});

test("subscription rows include provider-level accounts without an explicit credential pool", () => {
  const config = subscriptionConfig();
  config.Providers[0] = {
    ...config.Providers[0],
    account: {
      connectors: [{ sourceFile: "/synthetic/account.json", type: "claude-oauth-usage" }],
      enabled: true,
      routing: {
        billingMode: "auto",
        mode: "subscription-first",
        requiredMeters: [{ id: "weekly" }]
      }
    },
    credentials: undefined,
    id: "personal-max",
    name: "Personal Max"
  };
  const rows = claudeSubscriptionRows(config, [{ ...subscriptionSnapshot(), credentialId: undefined, provider: "Personal Max" }]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].credential.name, "Personal Max");
  assert.equal(rows[0].snapshot?.accountEmail, "max@example.test");
});

test("Fable readiness requires session, general weekly, and scoped weekly headroom on one credential", () => {
  const exhaustedWeekly = subscriptionSnapshot({
    meters: subscriptionSnapshot().meters.map((meter) => meter.id === "weekly"
      ? { ...meter, remaining: 0, used: 100 }
      : meter)
  });
  const html = renderToStaticMarkup(
    <SubscriptionsView
      config={subscriptionConfig()}
      providerAccountRefreshing={false}
      providerAccounts={[exhaustedWeekly]}
    />
  );

  assert.match(html, /0 confirmed with Fable headroom/);
  assert.match(html, /Throttle Fable traffic or add subscription capacity/);
});

test("Fable readiness checks the scoped meter even when custom routing omits it", () => {
  const config = subscriptionConfig();
  config.Providers[0].credentials[0].account.routing.requiredMeters = [{ id: "weekly" }];
  const exhaustedFable = subscriptionSnapshot({
    meters: subscriptionSnapshot().meters.map((meter) => meter.id === "scoped_weekly"
      ? { ...meter, remaining: 0, used: 100 }
      : meter)
  });
  const rows = claudeSubscriptionRows(config, [exhaustedFable]);

  assert.equal(subscriptionRoutingState(rows[0]), "exhausted");
});

test("subscriptions page does not invent a paid lane without routing configuration", () => {
  const config = subscriptionConfig();
  config.Providers[0].credentials[0].account.routing = undefined;
  const html = renderToStaticMarkup(
    <SubscriptionsView config={config} providerAccountRefreshing={false} providerAccounts={[subscriptionSnapshot()]} />
  );

  assert.match(html, /Not configured/);
  assert.doesNotMatch(html, /Auto → Paid fallback/);
});

test("subscriptions page follows the Chinese application copy", () => {
  const html = renderToStaticMarkup(
    <AppI18nContext.Provider value={appCopy.zh}>
      <SubscriptionsView config={subscriptionConfig()} providerAccountRefreshing={false} providerAccounts={[subscriptionSnapshot()]} />
    </AppI18nContext.Provider>
  );

  assert.match(html, /订阅健康/);
  assert.match(html, /Fable 每周/);
  assert.match(html, /容量结论/);
  assert.doesNotMatch(html, /Subscription health|Capacity answer/);
});

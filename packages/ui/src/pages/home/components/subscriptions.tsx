import { AlertTriangle, BatteryCharging, CircleGauge, Clock3, RefreshCw } from "lucide-react";
import type {
  AppConfig,
  GatewayProviderConfig,
  ProviderAccountConfig,
  ProviderAccountMeter,
  ProviderAccountSnapshot,
  ProviderCredentialConfig
} from "@ccr/core/contracts/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isGatewayProviderEnabled, useAppText } from "../shared/index";

type RoutingState = "available" | "exhausted" | "unavailable" | "unknown";

type SubscriptionRow = {
  account?: ProviderAccountConfig;
  credential: ProviderCredentialConfig;
  credentialId: string;
  enabled: boolean;
  provider: GatewayProviderConfig;
  snapshot?: ProviderAccountSnapshot;
};

export function SubscriptionsView({
  config,
  providerAccounts,
  providerAccountRefreshing,
  refreshProviderAccounts
}: {
  config: AppConfig;
  providerAccounts: ProviderAccountSnapshot[];
  providerAccountRefreshing: boolean;
  refreshProviderAccounts?: () => void | Promise<void>;
}) {
  const t = useAppText();
  const rows = claudeSubscriptionRows(config, providerAccounts);
  const enabledRows = rows.filter((row) => row.enabled);
  const fableStates = enabledRows.map((row) => ({ row, state: subscriptionRoutingState(row) }));
  const fableKnown = fableStates.filter(({ state }) => state === "available" || state === "exhausted");
  const weeklyKnown = enabledRows.filter((row) => meterRemaining(row.snapshot, "weekly") !== undefined);
  const fableReady = fableKnown.filter(({ state }) => state === "available").length;
  const weeklyReady = weeklyKnown.filter((row) => (meterRemaining(row.snapshot, "weekly") ?? 0) > 0).length;
  const fableUnknown = enabledRows.length - fableKnown.length;
  const weeklyUnknown = enabledRows.length - weeklyKnown.length;

  return (
    <section className="mx-auto flex min-h-full w-full max-w-[1480px] flex-col gap-4" aria-labelledby="subscription-health-title">
      <header className="relative overflow-hidden rounded-xl border border-border bg-card px-5 py-5 shadow-sm">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-2/5 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_68%)]" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
              <BatteryCharging className="h-3.5 w-3.5" />
              {t("Claude Pool telemetry")}
            </div>
            <h1 className="text-xl font-semibold tracking-tight" id="subscription-health-title">{t("Subscription health")}</h1>
            <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
              {t("Included subscription windows are checked locally with each account's OAuth session. Fable weekly is a separate, smaller allowance.")}
            </p>
          </div>
          <Button disabled={providerAccountRefreshing} onClick={() => void refreshProviderAccounts?.()} size="sm" type="button" variant="outline">
            <RefreshCw className={cn("h-3.5 w-3.5", providerAccountRefreshing && "animate-spin")} />
            {t("Refresh")}
          </Button>
        </div>
        <div className="relative mt-5 grid gap-2 sm:grid-cols-3">
          <SummaryMetric label={t("Configured")} value={rows.length} detail={`${enabledRows.length} ${t("enabled")}`} tone="neutral" />
          <SummaryMetric label={t("General weekly ready")} value={weeklyReady} detail={weeklyUnknown > 0 ? `${weeklyUnknown} ${t("unknown")}` : `${t("of")} ${enabledRows.length} ${t("enabled")}`} tone="blue" />
          <SummaryMetric label={t("Fable ready")} value={fableReady} detail={fableUnknown > 0 ? `${fableUnknown} ${t("unknown")}` : t("separate weekly window")} tone="fable" />
        </div>
      </header>

      {rows.length > 0 ? (
        <div className="grid gap-3">
          {rows.map((row) => <SubscriptionHealthRow key={`${row.provider.name}:${row.credentialId}`} row={row} rows={rows} />)}
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/60 px-6 text-center">
          <CircleGauge className="mb-3 h-7 w-7 text-muted-foreground" />
          <div className="text-sm font-semibold">{t("No Claude Pool subscriptions found")}</div>
          <p className="mt-1 max-w-lg text-[12px] leading-5 text-muted-foreground">
            {t("Add credentials with a Claude OAuth usage connector to see their independent quota windows here.")}
          </p>
        </div>
      )}

      <footer className="rounded-xl border border-border/80 bg-muted/35 px-4 py-3 text-[12px] text-muted-foreground">
        <span className="font-semibold text-foreground">{t("Capacity answer:")}</span>{" "}
        {fableReady} {t("confirmed with Fable headroom;")} {weeklyReady} {t("confirmed with general weekly headroom.")}
        {fableUnknown > 0 || weeklyUnknown > 0
          ? ` ${t("Telemetry is unavailable for")} ${Math.max(fableUnknown, weeklyUnknown)} ${t("of")} ${enabledRows.length} ${t("enabled subscriptions; capacity is not inferred for those accounts.")}`
          : fableReady === 0 && enabledRows.length > 0
            ? ` ${t("Throttle Fable traffic or add subscription capacity.")}`
            : ""}
      </footer>
    </section>
  );
}

function SummaryMetric({ detail, label, tone, value }: { detail: string; label: string; tone: "blue" | "fable" | "neutral"; value: number }) {
  return (
    <div className={cn(
      "rounded-lg border px-3.5 py-3",
      tone === "blue" && "border-sky-500/20 bg-sky-500/[0.06]",
      tone === "fable" && "border-amber-500/30 bg-amber-500/[0.08]",
      tone === "neutral" && "border-border bg-background/70"
    )}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums">{value}</span><span className="text-[11px] text-muted-foreground">{detail}</span></div>
    </div>
  );
}

function SubscriptionHealthRow({ row, rows }: { row: SubscriptionRow; rows: SubscriptionRow[] }) {
  const t = useAppText();
  const snapshot = row.snapshot;
  const state = subscriptionRoutingState(row);
  const configuredBillingMode = row.account?.routing?.billingMode;
  const effectiveBillingMode = configuredBillingMode === "auto"
    ? snapshot?.extraUsageEnabled === false ? "subscription" : "paid-fallback"
    : configuredBillingMode;
  const lane = effectiveBillingMode ? subscriptionLaneForRow(row, rows) : t("Not configured");
  const email = snapshot?.accountEmail;
  const label = row.credential.name?.trim() || row.credential.label?.trim() || row.credential.id?.trim() || row.credentialId;
  const spend = snapshot?.meters.find((meter) => meter.id === "spend");

  return (
    <article className={cn(
      "grid gap-4 rounded-xl border bg-card p-4 shadow-sm lg:grid-cols-[minmax(190px,0.8fr)_minmax(460px,2fr)_minmax(210px,0.9fr)]",
      !row.enabled && "opacity-60",
      row.enabled && state === "exhausted" && "border-red-500/35",
      row.enabled && state === "available" && "border-emerald-500/20"
    )}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", row.enabled ? stateDotClass(state) : "bg-slate-400")} />
          <h2 className="truncate text-sm font-semibold" title={label}>{label}</h2>
        </div>
        <div className="mt-1 truncate text-[11px] text-muted-foreground" title={email}>{email || t("Email unavailable")}</div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusPill label={t(row.enabled ? "Enabled" : "Disabled")} tone={row.enabled ? "enabled" : "muted"} />
          <StatusPill label={t(state)} tone={state} />
          <StatusPill label={t(plainSubscriptionTier(snapshot?.subscriptionTier))} tone="tier" />
        </div>
        {snapshot?.errors?.[0]?.message ? (
          <div className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-red-500">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{snapshot.errors[0].message}</span>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <QuotaMeter meter={snapshot?.meters.find((meter) => meter.id === "session")} title={t("Session")} tone="session" />
        <QuotaMeter meter={snapshot?.meters.find((meter) => meter.id === "weekly")} title={t("Weekly")} tone="weekly" />
        <QuotaMeter meter={snapshot?.meters.find((meter) => meter.id === "scoped_weekly")} title={t("Fable weekly")} tone="fable" />
      </div>

      <div className="grid content-start gap-3 border-t border-border/70 pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("Extra usage")}</div>
          <div className="mt-1 text-[12px] font-medium">{formatSpend(spend, snapshot?.extraUsageEnabled, t)}</div>
          {snapshot?.spendLimitReached ? (
            <div className="mt-1 inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-500">
              <AlertTriangle className="h-3 w-3" /> {t("Spend limit reached")}
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <InfoPair label={t("Billing")} value={!effectiveBillingMode ? t("Not configured") : configuredBillingMode === "auto" ? `${t("Auto")} → ${t(billingModeLabel(effectiveBillingMode))}` : t(billingModeLabel(effectiveBillingMode))} />
          <InfoPair label={t("Current lane")} value={t(lane)} />
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Clock3 className="h-3 w-3" />
          {t("Updated")} {formatResetTime(snapshot?.updatedAt)}
        </div>
      </div>
    </article>
  );
}

function QuotaMeter({ meter, title, tone }: { meter?: ProviderAccountMeter; title: string; tone: "fable" | "session" | "weekly" }) {
  const t = useAppText();
  const used = meterUsedPercent(meter);
  const remaining = meterRemainingPercent(meter);
  return (
    <div className={cn(
      "rounded-lg border bg-background/60 p-3",
      tone === "fable" ? "border-amber-500/35 shadow-[inset_0_0_0_1px_hsl(38_92%_50%/0.05)]" : "border-border/80"
    )}>
      <div className="flex items-center justify-between gap-2">
        <div className={cn("text-[11px] font-semibold", tone === "fable" && "text-amber-600 dark:text-amber-400")}>{title}</div>
        <div className="text-[11px] font-semibold tabular-nums">{used === undefined ? "—" : `${formatPercentValue(used)}%`}</div>
      </div>
      {tone === "fable" ? <div className="mt-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-600/80 dark:text-amber-400/80">{t("Separate allowance")}</div> : null}
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="meter" aria-label={`${title} usage`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={used}>
        {used !== undefined ? <div className={cn("h-full rounded-full transition-[width]", meterBarClass(tone, remaining))} style={{ width: `${Math.max(2, Math.min(100, used))}%` }} /> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[9px] text-muted-foreground">
        <span>{remaining === undefined ? t("Usage unavailable") : `${formatPercentValue(remaining)}% ${t("left")}`}</span>
        <span className="truncate" title={meter?.resetAt}>{t("Resets")} {formatResetTime(meter?.resetAt)}</span>
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: RoutingState | "enabled" | "muted" | "tier" }) {
  return (
    <span className={cn(
      "inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide",
      tone === "available" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tone === "exhausted" && "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400",
      tone === "unavailable" && "border-orange-500/25 bg-orange-500/10 text-orange-600 dark:text-orange-400",
      tone === "unknown" && "border-slate-500/25 bg-slate-500/10 text-slate-500",
      tone === "enabled" && "border-primary/20 bg-primary/10 text-primary",
      tone === "muted" && "border-border bg-muted text-muted-foreground",
      tone === "tier" && "border-border bg-background text-foreground"
    )}>{label}</span>
  );
}

function InfoPair({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-0.5 font-medium">{value}</div></div>;
}

export function claudeSubscriptionRows(config: AppConfig, snapshots: ProviderAccountSnapshot[]): SubscriptionRow[] {
  return config.Providers.filter(isClaudeSubscriptionProvider).flatMap((provider) => {
    const credentials = provider.credentials ?? [];
    if (credentials.length === 0 && provider.account) {
      return [{
        account: provider.account,
        credential: { enabled: provider.enabled, id: provider.id, name: provider.name },
        credentialId: provider.id?.trim() || provider.name,
        enabled: isGatewayProviderEnabled(provider),
        provider,
        snapshot: snapshots.find((snapshot) => snapshot.provider === provider.name && !snapshot.credentialId)
      }];
    }
    return credentials.map((credential, index) => {
      const credentialId = providerCredentialId(credential, index);
      return {
        account: credential.account ?? provider.account,
        credential,
        credentialId,
        enabled: isGatewayProviderEnabled(provider) && credential.enabled !== false,
        provider,
        snapshot: snapshots.find((snapshot) => snapshot.provider === provider.name && snapshot.credentialId === credentialId)
      };
    });
  });
}

function isClaudeSubscriptionProvider(provider: GatewayProviderConfig): boolean {
  const name = `${provider.id ?? ""} ${provider.name}`.toLowerCase();
  return name.includes("claude pool") || name.includes("claude-pool") || provider.account?.connectors?.some((connector) =>
    connector.type === "claude-oauth-usage"
  ) || (provider.credentials ?? []).some((credential) =>
    (credential.account ?? provider.account)?.connectors?.some((connector) => connector.type === "claude-oauth-usage")
  );
}

export function subscriptionRoutingState(row: SubscriptionRow, requireFable = true): RoutingState {
  const snapshot = row.snapshot;
  if (!snapshot) return "unknown";
  if (snapshot.errors?.length || snapshot.status === "error" || snapshot.status === "unsupported") return "unavailable";
  const configuredRequirements = row.account?.routing?.requiredMeters.filter((requirement) =>
    !requirement.models?.length || requirement.models.some((model) => model.trim().toLowerCase() === "claude-fable-5")
  ) ?? [{ id: "session" }, { id: "weekly" }, { id: "scoped_weekly" }];
  const requirements = !requireFable || configuredRequirements.some((requirement) => requirement.id === "scoped_weekly")
    ? configuredRequirements
    : [...configuredRequirements, { id: "scoped_weekly" }];
  let missing = false;
  for (const requirement of requirements) {
    const meter = snapshot.meters.find((candidate) => candidate.id === requirement.id);
    const remaining = meter?.remaining ?? (meter?.limit !== undefined && meter.used !== undefined ? meter.limit - meter.used : undefined);
    if (!Number.isFinite(remaining)) {
      missing = true;
    } else if ((remaining as number) <= (requirement.minimumRemaining ?? 0)) {
      return "exhausted";
    }
  }
  return missing ? "unavailable" : "available";
}

export function plainSubscriptionTier(value: string | undefined): string {
  if (!value) return "Tier unknown";
  const normalized = value.trim().toLowerCase();
  const max = normalized.match(/(?:^|_)max_(\d+)x(?:$|_)/);
  if (max) return `Max ${max[1]}x`;
  if (normalized === "pro" || normalized.includes("claude_pro")) return "Pro";
  return value;
}

function subscriptionLaneForRow(row: SubscriptionRow, rows: SubscriptionRow[]): string {
  if (!row.enabled) return "Disabled";
  const candidates = rows.filter((candidate) => candidate.enabled && candidate.provider === row.provider && candidate.account?.routing?.mode === "subscription-first").map((candidate) => {
    const configured = candidate.account?.routing?.billingMode ?? "auto";
    return {
      effectiveMode: configured === "auto" ? candidate.snapshot?.extraUsageEnabled === false ? "subscription" : "paid-fallback" : configured,
      row: candidate,
      state: subscriptionRoutingState(candidate, false)
    };
  });
  const subscriptions = candidates.filter((candidate) => candidate.effectiveMode === "subscription" &&
    (candidate.state === "available" || (candidate.row.account?.routing?.billingMode === "subscription" && candidate.state === "unknown")));
  if (subscriptions.length > 0) return subscriptions.some((candidate) => candidate.row === row) ? "Subscription" : "Not selected";
  const paid = candidates.filter((candidate) => candidate.effectiveMode === "paid-fallback");
  if (paid.some((candidate) => candidate.state === "unknown")) return "Quota blocked";
  const paidSubscriptions = paid.filter((candidate) => candidate.state === "available");
  if (paidSubscriptions.length > 0) return paidSubscriptions.some((candidate) => candidate.row === row) ? "Paid subscription" : "Not selected";
  const paidFallbacks = paid.filter((candidate) => candidate.state === "exhausted" && candidate.row.snapshot?.spendLimitReached !== true);
  return paidFallbacks.some((candidate) => candidate.row === row) ? "Paid fallback" : "Quota blocked";
}

function billingModeLabel(value: "subscription" | "paid-fallback"): string {
  return value === "subscription" ? "Subscription" : "Paid fallback";
}

function providerCredentialId(credential: ProviderCredentialConfig, index: number): string {
  if (credential.id?.trim()) return credential.id.trim();
  const label = credential.name?.trim() || credential.label?.trim();
  const slug = label?.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "key";
  return label ? `${slug}-${index + 1}` : `key-${index + 1}`;
}

function meterRemaining(snapshot: ProviderAccountSnapshot | undefined, id: string): number | undefined {
  const meter = snapshot?.meters.find((candidate) => candidate.id === id);
  const remaining = meter?.remaining ?? (meter?.limit !== undefined && meter.used !== undefined ? meter.limit - meter.used : undefined);
  return Number.isFinite(remaining) ? remaining as number : undefined;
}

function meterUsedPercent(meter: ProviderAccountMeter | undefined): number | undefined {
  if (!meter) return undefined;
  const used = meter.used ?? (meter.limit !== undefined && meter.remaining !== undefined ? meter.limit - meter.remaining : undefined);
  if (!Number.isFinite(used)) return undefined;
  return Math.max(0, Math.min(100, used as number));
}

function meterRemainingPercent(meter: ProviderAccountMeter | undefined): number | undefined {
  if (!meter) return undefined;
  const remaining = meter.remaining ?? (meter.limit !== undefined && meter.used !== undefined ? meter.limit - meter.used : undefined);
  if (!Number.isFinite(remaining)) return undefined;
  return Math.max(0, Math.min(100, remaining as number));
}

function meterBarClass(tone: "fable" | "session" | "weekly", remaining: number | undefined): string {
  if (remaining !== undefined && remaining <= 5) return "bg-red-500";
  if (remaining !== undefined && remaining <= 20) return "bg-orange-500";
  if (tone === "fable") return "bg-amber-500";
  if (tone === "weekly") return "bg-sky-500";
  return "bg-emerald-500";
}

function stateDotClass(state: RoutingState): string {
  if (state === "available") return "bg-emerald-500 shadow-[0_0_0_3px_hsl(142_71%_45%/0.12)]";
  if (state === "exhausted") return "bg-red-500 shadow-[0_0_0_3px_hsl(0_84%_60%/0.12)]";
  if (state === "unavailable") return "bg-orange-500";
  return "bg-slate-400";
}

function formatSpend(meter: ProviderAccountMeter | undefined, extraUsageEnabled: boolean | undefined, t: (value: string) => string): string {
  if (!meter) return extraUsageEnabled === false ? t("Disabled") : t("Usage unavailable");
  const currency = meter.currency || meter.unit;
  const used = meter.used?.toFixed(2) ?? "—";
  const limit = meter.limit?.toFixed(2) ?? "—";
  return `${used} / ${limit} ${currency}`;
}

function formatPercentValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatResetTime(value: string | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  }).format(date);
}

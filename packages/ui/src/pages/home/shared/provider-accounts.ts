import type {
  ProviderAccountMeter,
  ProviderAccountSnapshot
} from "@ccr/core/contracts/app";
import {
  formatCompactNumber
} from "./usage";

export const PROVIDER_ACCOUNT_METER_HEALTH_THRESHOLDS = {
  exhaustedRemainingPercent: 5,
  warningRemainingPercent: 20
} as const;

export type ProviderAccountMeterHealth = "exhausted" | "healthy" | "unknown" | "warning";

export function compareProviderAccountSnapshots(a: ProviderAccountSnapshot, b: ProviderAccountSnapshot): number {
  return (
    providerAccountStatusRank(b.status) - providerAccountStatusRank(a.status) ||
    a.provider.localeCompare(b.provider) ||
    providerAccountSnapshotCredentialLabel(a).localeCompare(providerAccountSnapshotCredentialLabel(b))
  );
}

export function providerAccountSnapshotKey(account: ProviderAccountSnapshot): string {
  return account.credentialId ? `${account.provider}::${account.credentialId}` : account.provider;
}

export function providerAccountSnapshotLabel(account: ProviderAccountSnapshot): string {
  const credential = providerAccountSnapshotCredentialLabel(account);
  return credential ? `${account.provider} / ${credential}` : account.provider;
}

export function providerAccountSnapshotCredentialLabel(account: ProviderAccountSnapshot): string {
  return account.credentialLabel?.trim() || account.credentialId?.trim() || "";
}

export function providerAccountStatusRank(status: ProviderAccountSnapshot["status"]): number {
  if (status === "error") return 4;
  if (status === "critical") return 3;
  if (status === "warning") return 2;
  if (status === "ok") return 1;
  return 0;
}

export function primaryProviderAccountMeter(account: ProviderAccountSnapshot): ProviderAccountMeter | undefined {
  return [...account.meters].sort((a, b) => {
    const aRatio = providerAccountMeterRemainingRatio(a) ?? 1;
    const bRatio = providerAccountMeterRemainingRatio(b) ?? 1;
    return aRatio - bRatio;
  })[0];
}

export function providerAccountMetersForDisplay(account: ProviderAccountSnapshot, maxCount: number): ProviderAccountMeter[] {
  const meters = account.meters.slice(0, maxCount);
  const manualResetMeter = account.meters.find(isProviderAccountManualResetMeter);
  if (!manualResetMeter || meters.includes(manualResetMeter) || meters.length < maxCount) {
    return meters;
  }
  return [...meters.slice(0, Math.max(0, maxCount - 1)), manualResetMeter];
}

export function providerAccountMeterRemainingRatio(meter: ProviderAccountMeter): number | undefined {
  if (!meter.limit || meter.limit <= 0) {
    return undefined;
  }
  const remaining = meter.remaining ?? (meter.used === undefined ? undefined : meter.limit - meter.used);
  if (!Number.isFinite(remaining)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, (remaining as number) / meter.limit));
}

export function providerAccountMeterProgress(meter: ProviderAccountMeter): number | undefined {
  const ratio = providerAccountMeterRemainingRatio(meter);
  return ratio === undefined ? undefined : Math.round(ratio * 100);
}

export function providerAccountMeterHealth(meter: ProviderAccountMeter): ProviderAccountMeterHealth {
  const ratio = providerAccountMeterRemainingRatio(meter);
  return providerAccountRemainingHealth(ratio === undefined ? undefined : ratio * 100);
}

export function providerAccountHealthLabel(health: ProviderAccountMeterHealth, t: (value: string) => string): string {
  if (health === "healthy") return t("Healthy");
  if (health === "warning") return t("Low");
  if (health === "exhausted") return t("Exhausted");
  return t("Unknown");
}

export function providerAccountRemainingHealth(remainingPercent: number | undefined): ProviderAccountMeterHealth {
  if (remainingPercent === undefined || !Number.isFinite(remainingPercent)) {
    return "unknown";
  }
  if (remainingPercent <= PROVIDER_ACCOUNT_METER_HEALTH_THRESHOLDS.exhaustedRemainingPercent) {
    return "exhausted";
  }
  if (remainingPercent <= PROVIDER_ACCOUNT_METER_HEALTH_THRESHOLDS.warningRemainingPercent) {
    return "warning";
  }
  return "healthy";
}

export function providerAccountMeterHealthClass(meter: ProviderAccountMeter): string {
  return providerAccountHealthClass(providerAccountMeterHealth(meter));
}

export function providerAccountHealthClass(health: ProviderAccountMeterHealth): string {
  if (health === "exhausted") {
    return "bg-red-500";
  }
  if (health === "warning") {
    return "bg-amber-500";
  }
  if (health === "healthy") {
    return "bg-emerald-500";
  }
  return "bg-muted-foreground/40";
}

export function providerAccountMeterHealthStroke(meter: ProviderAccountMeter): string {
  return providerAccountHealthStroke(providerAccountMeterHealth(meter));
}

export function providerAccountHealthStroke(health: ProviderAccountMeterHealth): string {
  if (health === "exhausted") {
    return "var(--color-red-500)";
  }
  if (health === "warning") {
    return "var(--color-amber-500)";
  }
  if (health === "healthy") {
    return "var(--color-emerald-500)";
  }
  return "var(--muted-foreground)";
}

export function providerAccountMeterValidityProgress(meter: ProviderAccountMeter, now = Date.now()): number | undefined {
  const detail = providerAccountCurrentMeterDetail(meter, now);
  if (!detail) {
    return undefined;
  }
  const progress = providerAccountMeterDetailValidityProgress(detail, now);
  return progress && progress > 0 ? progress : undefined;
}

export function providerAccountCurrentMeterDetail(meter: ProviderAccountMeter, now = Date.now()): NonNullable<ProviderAccountMeter["details"]>[number] | undefined {
  return (meter.details ?? [])
    .filter((detail) => {
      const effectiveAt = providerAccountDetailTimestamp(detail.effectiveAt);
      const expiresAt = providerAccountDetailTimestamp(detail.expiresAt);
      return effectiveAt !== undefined && expiresAt !== undefined && effectiveAt <= now && now < expiresAt;
    })
    .sort((a, b) => (providerAccountDetailTimestamp(a.expiresAt) ?? Number.MAX_SAFE_INTEGER) - (providerAccountDetailTimestamp(b.expiresAt) ?? Number.MAX_SAFE_INTEGER))[0];
}

export function providerAccountMeterDetailValidityProgress(detail: NonNullable<ProviderAccountMeter["details"]>[number], now = Date.now()): number | undefined {
  const effectiveAt = providerAccountDetailTimestamp(detail.effectiveAt);
  const expiresAt = providerAccountDetailTimestamp(detail.expiresAt);
  if (effectiveAt === undefined || expiresAt === undefined || expiresAt <= effectiveAt) {
    return undefined;
  }
  if (now <= effectiveAt) {
    return 100;
  }
  if (now >= expiresAt) {
    return 0;
  }
  const ratio = (expiresAt - now) / (expiresAt - effectiveAt);
  return Math.max(3, Math.round(Math.max(0, Math.min(1, ratio)) * 100));
}

export function formatProviderAccountDetailDate(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function providerAccountDetailTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function providerAccountBadgeVariant(status: ProviderAccountSnapshot["status"]): "danger" | "outline" | "success" | "warning" {
  if (status === "critical" || status === "error") {
    return "danger";
  }
  if (status === "warning") {
    return "warning";
  }
  if (status === "ok") {
    return "success";
  }
  return "outline";
}

export function formatProviderAccountMeterValue(
  meter: ProviderAccountMeter,
  translate: (value: string) => string = (value) => value
): string {
  const value = meter.remaining ?? meter.used ?? meter.limit;
  if (value === undefined) {
    return "-";
  }
  const unit = meter.unit.trim();
  const normalizedUnit = unit.toUpperCase();
  if (normalizedUnit === "USD") {
    return `$${formatProviderAccountNumber(value)}`;
  }
  if (normalizedUnit === "CNY") {
    return `¥${formatProviderAccountNumber(value)}`;
  }
  if (normalizedUnit === "EUR") {
    return `€${formatProviderAccountNumber(value)}`;
  }
  if (unit === "%") {
    return `${formatProviderAccountNumber(value)}%`;
  }
  if (unit === "hours") {
    return `${formatProviderAccountNumber(value)}h`;
  }
  if (unit === "minutes") {
    return `${formatProviderAccountNumber(value)}m`;
  }
  const displayUnit = translate(unit);
  if (meter.kind === "balance") {
    return `${formatProviderAccountNumber(value)} ${displayUnit}`;
  }
  return `${formatCompactNumber(value)} ${displayUnit}`;
}

export function formatProviderAccountNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

export function formatProviderAccountReset(value: string, translate: (value: string) => string = (item) => item): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const minutes = Math.round((timestamp - Date.now()) / 60000);
  if (minutes <= 0) {
    return translate("expired");
  }
  const prefix = translate("expires in");
  if (minutes < 60) {
    return `${prefix} ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${prefix} ${hours}h`;
  }
  return `${prefix} ${Math.round(hours / 24)}d`;
}

export function formatProviderAccountMeterTitle(meter: ProviderAccountMeter, translate: (value: string) => string): string {
  const label = translate(meter.label);
  return meter.resetAt ? `${label} (${formatProviderAccountReset(meter.resetAt, translate)})` : label;
}

export function isProviderAccountManualResetMeter(meter: ProviderAccountMeter): boolean {
  const text = `${meter.id} ${meter.label} ${meter.window ?? ""}`.toLowerCase();
  return text.includes("manual_reset") || text.includes("manual reset") || text.includes("manual-reset");
}

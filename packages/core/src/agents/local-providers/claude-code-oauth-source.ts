import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { isRecord, readOauthTokenSetFields, readString, type OAuthTokenSet } from "@ccr/core/agents/local-providers/shared";

const claudeOauthClientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const claudeOauthScope = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const claudeOauthTokenUrl = "https://platform.claude.com/v1/oauth/token";
const refreshHeadroomMs = 120_000;
const inFlightRefreshes = new Map<string, Promise<OAuthTokenSet | undefined>>();

type FetchLike = typeof fetch;

type StoredClaudeOauth = OAuthTokenSet & {
  expiresAt?: string;
  record: Record<string, unknown>;
};

export function readClaudeCodeOauthSource(sourceFile: string): OAuthTokenSet | undefined {
  return readStoredClaudeOauth(sourceFile);
}

export async function resolveClaudeCodeOauthSource(
  sourceFile: string,
  options: { fetch?: FetchLike; now?: () => number } = {}
): Promise<OAuthTokenSet | undefined> {
  const resolved = path.resolve(sourceFile);
  let current = readStoredClaudeOauth(resolved);
  if (!current) return undefined;
  if (!current.deviceId && current.accountId) {
    const deviceId = randomBytes(32).toString("hex");
    writeJsonAtomically(resolved, { ...current.record, claude_device_ids: [deviceId] });
    current = { ...current, deviceId, record: { ...current.record, claude_device_ids: [deviceId] } };
  }
  const now = options.now?.() ?? Date.now();
  const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt > now + refreshHeadroomMs || !current.refreshToken) {
    return current;
  }
  const existing = inFlightRefreshes.get(resolved);
  if (existing) return existing;
  const refresh = refreshClaudeCodeOauthSource(resolved, current, options.fetch ?? fetch, now)
    .finally(() => inFlightRefreshes.delete(resolved));
  inFlightRefreshes.set(resolved, refresh);
  return refresh;
}

function readStoredClaudeOauth(sourceFile: string): StoredClaudeOauth | undefined {
  const resolved = path.resolve(sourceFile);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`Claude OAuth source is not a file: ${resolved}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Claude OAuth source must be mode 0600: ${resolved}`);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  if (!isRecord(parsed)) return undefined;
  const oauth = readOauthTokenSetFields(parsed);
  if (!oauth) return undefined;
  return {
    accountId: readString(parsed.account_uuid) || readString(parsed.accountId),
    ...oauth,
    deviceId: readDeviceId(parsed.claude_device_ids),
    expiresAt: readString(parsed.expired) || readString(parsed.expiresAt),
    record: parsed,
    sourceFile: resolved
  };
}

function readDeviceId(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is string => typeof item === "string" && /^[a-f0-9]{64}$/.test(item));
}

async function refreshClaudeCodeOauthSource(
  sourceFile: string,
  current: StoredClaudeOauth,
  fetchImpl: FetchLike,
  now: number
): Promise<OAuthTokenSet | undefined> {
  const response = await fetchImpl(claudeOauthTokenUrl, {
    body: JSON.stringify({
      client_id: claudeOauthClientId,
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      scope: claudeOauthScope
    }),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": "axios/1.15.2"
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt > now) return current;
    throw new Error(`Claude OAuth refresh failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload)) throw new Error("Claude OAuth refresh returned an invalid response");
  const accessToken = readString(payload.access_token) || readString(payload.accessToken);
  const refreshToken = readString(payload.refresh_token) || readString(payload.refreshToken) || current.refreshToken;
  const expiresIn = Number(payload.expires_in ?? payload.expiresIn);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Claude OAuth refresh response is missing token fields");
  }

  // Another process may have refreshed this account while the request was in flight.
  const latest = readStoredClaudeOauth(sourceFile);
  if (latest?.refreshToken && latest.refreshToken !== current.refreshToken) return latest;
  const nextRecord = {
    ...current.record,
    access_token: accessToken,
    expired: new Date(now + expiresIn * 1000).toISOString(),
    last_refresh: new Date(now).toISOString(),
    refresh_token: refreshToken,
    type: "claude"
  };
  writeJsonAtomically(sourceFile, nextRecord);
  return {
    accountId: current.accountId,
    accessToken,
    deviceId: current.deviceId,
    refreshToken,
    sourceFile
  };
}

function writeJsonAtomically(destination: string, value: unknown): void {
  const temp = `${destination}.ccr-refresh-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, destination);
}

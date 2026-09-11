import { createHash } from "node:crypto";
import { isRecord } from "@ccr/core/agents/local-providers/shared";

const cchSeed = 0x4d659218e32a3268n;
const fingerprintSalt = "59cf53e54c78";
const billingPrefix = "x-anthropic-billing-header:";
const claudeCodeIdentity = "You are Claude Code, Anthropic's official CLI for Claude.";

export function prepareClaudeCodeOauthBody(value: unknown, version = "2.1.223"): unknown {
  if (!isRecord(value)) return value;
  const body = structuredClone(value);
  const system = normalizeSystem(body.system);
  const billing = billingText(body, version);
  if (isBillingBlock(system[0])) {
    system[0] = { ...system[0], text: withCchPlaceholder(String(system[0].text)) };
  } else {
    system.unshift(
      { text: billing, type: "text" },
      {
        ...(cacheBreakpointCount(body, system) < 4 ? { cache_control: { type: "ephemeral" } } : {}),
        text: claudeCodeIdentity,
        type: "text"
      }
    );
  }
  body.system = system;
  const unsigned = JSON.stringify(body);
  const normalized = JSON.stringify(normalizeCchValue(body));
  const cch = (xxhash64(Buffer.from(normalized), cchSeed) & 0xfffffn).toString(16).padStart(5, "0");
  return JSON.parse(unsigned.replace("cch=00000;", `cch=${cch};`)) as unknown;
}

function cacheBreakpointCount(body: Record<string, unknown>, system: Array<Record<string, unknown>>): number {
  const groups: unknown[] = [system, body.tools];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (isRecord(message)) groups.push(message.content);
  }
  // Automatic caching shares Anthropic's four slots with explicit block breakpoints.
  let count = isRecord(body.cache_control) ? 1 : 0;
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    count += group.filter(block => isRecord(block) && isRecord(block.cache_control)).length;
  }
  return count;
}

function normalizeSystem(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") return [{ text: value, type: "text" }];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(item => ({ ...item }));
}

function isBillingBlock(value: Record<string, unknown> | undefined): boolean {
  return value?.type === "text" && typeof value.text === "string" && value.text.startsWith(billingPrefix);
}

function withCchPlaceholder(value: string): string {
  if (/\bcch=[a-f0-9]{5};/.test(value)) return value.replace(/\bcch=[a-f0-9]{5};/, "cch=00000;");
  return value.replace(/(cc_entrypoint=[^;]+;)/, "$1 cch=00000;");
}

function billingText(body: Record<string, unknown>, version: string): string {
  const chars = Array.from(lastUserText(body));
  const selected = [4, 7, 20].map(index => chars[index] ?? "0").join("");
  const build = createHash("sha256").update(fingerprintSalt + selected + version).digest("hex").slice(0, 3);
  return `${billingPrefix} cc_version=${version}.${build}; cc_entrypoint=cli; cch=00000;`;
}

function lastUserText(body: Record<string, unknown>): string {
  let result = "";
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") result = message.content || result;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text) result = part.text;
      }
    }
  }
  return result;
}

function normalizeCchValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCchValue);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "max_tokens" || key === "fallbacks" || key === "fallback_credit_token") continue;
    output[key] = key === "model" && typeof item === "string" ? "" : normalizeCchValue(item);
  }
  return output;
}

const mask64 = 0xffffffffffffffffn;
const prime1 = 11400714785074694791n;
const prime2 = 14029467366897019727n;
const prime3 = 1609587929392839161n;
const prime4 = 9650029242287828579n;
const prime5 = 2870177450012600261n;

function xxhash64(data: Buffer, seed: bigint): bigint {
  let offset = 0;
  let hash: bigint;
  if (data.length >= 32) {
    let v1 = add64(seed, prime1, prime2);
    let v2 = add64(seed, prime2);
    let v3 = seed & mask64;
    let v4 = add64(seed, -prime1);
    const limit = data.length - 32;
    while (offset <= limit) {
      v1 = round(v1, data.readBigUInt64LE(offset)); offset += 8;
      v2 = round(v2, data.readBigUInt64LE(offset)); offset += 8;
      v3 = round(v3, data.readBigUInt64LE(offset)); offset += 8;
      v4 = round(v4, data.readBigUInt64LE(offset)); offset += 8;
    }
    hash = add64(rotl(v1, 1n), rotl(v2, 7n), rotl(v3, 12n), rotl(v4, 18n));
    for (const value of [v1, v2, v3, v4]) hash = add64(multiply64((hash ^ round(0n, value)), prime1), prime4);
  } else {
    hash = add64(seed, prime5);
  }
  hash = add64(hash, BigInt(data.length));
  while (offset + 8 <= data.length) {
    const value = round(0n, data.readBigUInt64LE(offset));
    hash ^= value;
    hash = add64(multiply64(rotl(hash, 27n), prime1), prime4);
    offset += 8;
  }
  if (offset + 4 <= data.length) {
    hash ^= multiply64(BigInt(data.readUInt32LE(offset)), prime1);
    hash = add64(multiply64(rotl(hash, 23n), prime2), prime3);
    offset += 4;
  }
  while (offset < data.length) {
    hash ^= multiply64(BigInt(data[offset]), prime5);
    hash = multiply64(rotl(hash, 11n), prime1);
    offset++;
  }
  hash ^= hash >> 33n;
  hash = multiply64(hash, prime2);
  hash ^= hash >> 29n;
  hash = multiply64(hash, prime3);
  hash ^= hash >> 32n;
  return hash & mask64;
}

function round(accumulator: bigint, value: bigint): bigint {
  return multiply64(rotl(add64(accumulator, multiply64(value, prime2)), 31n), prime1);
}

function rotl(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & mask64;
}

function multiply64(left: bigint, right: bigint): bigint {
  return (left * right) & mask64;
}

function add64(...values: bigint[]): bigint {
  return values.reduce((sum, value) => (sum + value) & mask64, 0n);
}

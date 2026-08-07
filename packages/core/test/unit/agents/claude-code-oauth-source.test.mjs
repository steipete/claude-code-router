import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCodeOauthSource } from "@ccr/core/agents/local-providers/claude-code-oauth-source.ts";

function writeOauthFile(directory, value) {
  const file = path.join(directory, "claude-account.json");
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

test("file-backed Claude OAuth keeps a fresh account token", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-oauth-"));
  const sourceFile = writeOauthFile(directory, {
    access_token: "synthetic-access-fresh",
    expired: "2099-01-01T00:00:00.000Z",
    refresh_token: "synthetic-refresh-fresh"
  });

  const oauth = await resolveClaudeCodeOauthSource(sourceFile, {
    fetch: async () => { throw new Error("fresh token must not refresh"); }
  });

  assert.equal(oauth?.accessToken, "synthetic-access-fresh");
  assert.equal(oauth?.sourceFile, sourceFile);
});

test("file-backed Claude OAuth refreshes and atomically persists a rotated token", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-oauth-"));
  const sourceFile = writeOauthFile(directory, {
    access_token: "synthetic-access-old",
    expired: "2020-01-01T00:00:00.000Z",
    refresh_token: "synthetic-refresh-old",
    type: "claude"
  });
  let request;

  const oauth = await resolveClaudeCodeOauthSource(sourceFile, {
    fetch: async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({
        access_token: "synthetic-access-new",
        expires_in: 3600,
        refresh_token: "synthetic-refresh-new"
      }), { status: 200 });
    },
    now: () => Date.parse("2026-08-06T23:00:00.000Z")
  });

  assert.equal(request.grant_type, "refresh_token");
  assert.equal(request.refresh_token, "synthetic-refresh-old");
  assert.equal(oauth?.accessToken, "synthetic-access-new");
  const stored = JSON.parse(readFileSync(sourceFile, "utf8"));
  assert.equal(stored.access_token, "synthetic-access-new");
  assert.equal(stored.refresh_token, "synthetic-refresh-new");
  assert.equal(stored.last_refresh, "2026-08-06T23:00:00.000Z");
});


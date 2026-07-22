import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthMode } from "./auth-mode";
import { resolveTailscaleIdentity, tailscaleConfigProblems } from "./tailscale-auth-core";

const headers = (value: string | null) => ({ get: () => value });

test("AUTH_MODE는 tailscale을 인식하고 명시적인 오타를 fail-closed한다", () => {
  assert.equal(parseAuthMode(undefined), "local");
  assert.equal(parseAuthMode("TAILSCALE"), "tailscale");
  assert.throws(() => parseAuthMode("tailsclael"), /Unsupported AUTH_MODE/);
  assert.throws(() => parseAuthMode(""), /Unsupported AUTH_MODE/);
});

test("Tailscale login은 allowlist와 정확히 일치할 때만 인정한다", () => {
  const allowed = "owner@example.com";
  assert.deepEqual(resolveTailscaleIdentity(headers(allowed), allowed), { status: "allowed", login: allowed });
  assert.deepEqual(resolveTailscaleIdentity(headers(null), allowed), { status: "missing-header" });
  assert.deepEqual(resolveTailscaleIdentity(headers("OWNER@example.com"), allowed), { status: "forbidden-login" });
  assert.deepEqual(resolveTailscaleIdentity(headers(` ${allowed}`), allowed), { status: "forbidden-login" });
  assert.deepEqual(resolveTailscaleIdentity(headers(`${allowed}, ${allowed}`), allowed), { status: "forbidden-login" });
});

test("Tailscale allowlist와 HTTPS APP_URL 설정은 엄격히 검증한다", () => {
  assert.deepEqual(tailscaleConfigProblems({
    TAILSCALE_ALLOWED_LOGIN: "owner@example.com",
    APP_URL: "https://oss-wsl.example.ts.net",
  }), []);
  assert.deepEqual(tailscaleConfigProblems({
    TAILSCALE_ALLOWED_LOGIN: " owner@example.com ",
    APP_URL: "http://localhost:3007",
  }), ["TAILSCALE_ALLOWED_LOGIN", "APP_URL(https)"]);
});

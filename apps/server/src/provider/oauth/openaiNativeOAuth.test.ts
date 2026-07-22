import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OPENAI_OAUTH_CLIENT_ID,
  OpenAiNativeOAuthError,
  buildOpenAiAuthorizeUrl,
  createPkcePair,
  parseChatGptAccountId,
  runOpenAiNativeOAuthFlow,
  serializeCodexAuthJson,
} from "./openaiNativeOAuth";

function makeIdToken(claims: Record<string, unknown>): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256" })}.${segment(claims)}.signature`;
}

describe("openaiNativeOAuth", () => {
  it("derives an S256 PKCE challenge from the verifier", () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
    expect(pair.challenge).toBe(createHash("sha256").update(pair.verifier).digest("base64url"));
  });

  it("builds the codex-equivalent authorization URL", () => {
    const url = new URL(
      buildOpenAiAuthorizeUrl({
        issuer: "https://auth.openai.com",
        clientId: OPENAI_OAUTH_CLIENT_ID,
        redirectUri: "http://localhost:1455/auth/callback",
        codeChallenge: "challenge-value",
        state: "state-value",
      }),
    );
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(OPENAI_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  it("extracts the ChatGPT account id from the id_token auth claim", () => {
    const idToken = makeIdToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
    });
    expect(parseChatGptAccountId(idToken)).toBe("account-123");
    expect(parseChatGptAccountId(makeIdToken({}))).toBeNull();
    expect(parseChatGptAccountId("not-a-jwt")).toBeNull();
  });

  it("serializes auth.json exactly like codex-rs AuthDotJson", () => {
    const serialized = serializeCodexAuthJson(
      {
        idToken: "id-token-raw",
        accessToken: "access-token-raw",
        refreshToken: "refresh-token-raw",
        accountId: "account-123",
      },
      { now: new Date("2026-07-22T10:00:00.000Z") },
    );
    expect(JSON.parse(serialized)).toEqual({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id-token-raw",
        access_token: "access-token-raw",
        refresh_token: "refresh-token-raw",
        account_id: "account-123",
      },
      last_refresh: "2026-07-22T10:00:00.000Z",
    });
    const withoutAccount = JSON.parse(
      serializeCodexAuthJson({
        idToken: "a",
        accessToken: "b",
        refreshToken: "c",
        accountId: null,
      }),
    ) as { tokens: Record<string, unknown> };
    expect("account_id" in withoutAccount.tokens).toBe(false);
  });

  it("completes the loopback flow and persists auth.json", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const idToken = makeIdToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-xyz" },
    });
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("test-code");
      expect(body.get("client_id")).toBe(OPENAI_OAUTH_CLIENT_ID);
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/u);
      return new Response(
        JSON.stringify({
          id_token: idToken,
          access_token: "access-token-raw",
          refresh_token: "refresh-token-raw",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    let authorizationUrl: string | null = null;
    const flow = runOpenAiNativeOAuthFlow({
      codexHome,
      ports: [0],
      fetchImpl,
      onAuthorizationUrl: (url) =>
        Effect.sync(() => {
          authorizationUrl = url;
        }),
    }).pipe(Effect.scoped);

    const flowPromise = Effect.runPromise(flow as Effect.Effect<void>);
    await vi.waitFor(() => {
      if (!authorizationUrl) throw new Error("authorization url not published yet");
    });
    const published = new URL(authorizationUrl!);
    const redirectUri = new URL(published.searchParams.get("redirect_uri")!);
    const state = published.searchParams.get("state")!;
    const callback = await fetch(`${redirectUri.toString()}?code=test-code&state=${state}`);
    expect(callback.status).toBe(200);
    await flowPromise;

    const authJson = JSON.parse(
      fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(authJson.OPENAI_API_KEY).toBeNull();
    expect(authJson.tokens).toMatchObject({
      id_token: idToken,
      access_token: "access-token-raw",
      refresh_token: "refresh-token-raw",
      account_id: "account-xyz",
    });
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("binds the next candidate port when the first is occupied", async () => {
    const http = await import("node:http");
    const blocker = http.createServer(() => undefined);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const blockedPort = (blocker.address() as { port: number }).port;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const idToken = makeIdToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-fallback" },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id_token: idToken,
            access_token: "access-token-raw",
            refresh_token: "refresh-token-raw",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    let authorizationUrl: string | null = null;
    const flow = runOpenAiNativeOAuthFlow({
      codexHome,
      ports: [blockedPort, 0],
      fetchImpl,
      onAuthorizationUrl: (url) =>
        Effect.sync(() => {
          authorizationUrl = url;
        }),
    }).pipe(Effect.scoped);

    const flowPromise = Effect.runPromise(flow as Effect.Effect<void>);
    try {
      await vi.waitFor(() => {
        if (!authorizationUrl) throw new Error("authorization url not published yet");
      });
      const published = new URL(authorizationUrl!);
      const redirectUri = new URL(published.searchParams.get("redirect_uri")!);
      // The occupied first port is skipped for the second (ephemeral) candidate.
      expect(redirectUri.port).not.toBe(String(blockedPort));
      expect(Number(redirectUri.port)).toBeGreaterThan(0);
      const state = published.searchParams.get("state")!;
      const callback = await fetch(`${redirectUri.toString()}?code=test-code&state=${state}`);
      expect(callback.status).toBe(200);
      await flowPromise;

      const authJson = JSON.parse(
        fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(authJson.tokens).toMatchObject({ account_id: "account-fallback" });
    } finally {
      blocker.close();
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("fails with authorization_denied when the callback carries an error", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    let authorizationUrl: string | null = null;
    const flow = runOpenAiNativeOAuthFlow({
      codexHome,
      ports: [0],
      onAuthorizationUrl: (url) =>
        Effect.sync(() => {
          authorizationUrl = url;
        }),
    }).pipe(Effect.scoped);
    const flowPromise = Effect.runPromise(Effect.flip(flow as Effect.Effect<void, unknown>));
    await vi.waitFor(() => {
      if (!authorizationUrl) throw new Error("authorization url not published yet");
    });
    const published = new URL(authorizationUrl!);
    const redirectUri = new URL(published.searchParams.get("redirect_uri")!);
    const callback = await fetch(`${redirectUri.toString()}?error=access_denied`);
    expect(callback.status).toBe(200);
    const failure = await flowPromise;
    expect(failure).toBeInstanceOf(OpenAiNativeOAuthError);
    expect((failure as OpenAiNativeOAuthError).reason).toBe("authorization_denied");
    expect(fs.existsSync(path.join(codexHome, "auth.json"))).toBe(false);
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("rejects a callback with a mismatched state", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    let authorizationUrl: string | null = null;
    const flow = runOpenAiNativeOAuthFlow({
      codexHome,
      ports: [0],
      onAuthorizationUrl: (url) =>
        Effect.sync(() => {
          authorizationUrl = url;
        }),
    }).pipe(Effect.scoped);
    const flowPromise = Effect.runPromise(Effect.flip(flow as Effect.Effect<void, unknown>));
    await vi.waitFor(() => {
      if (!authorizationUrl) throw new Error("authorization url not published yet");
    });
    const published = new URL(authorizationUrl!);
    const redirectUri = new URL(published.searchParams.get("redirect_uri")!);
    const callback = await fetch(`${redirectUri.toString()}?code=test-code&state=wrong-state`);
    expect(callback.status).toBe(400);
    const failure = await flowPromise;
    expect(failure).toBeInstanceOf(OpenAiNativeOAuthError);
    expect((failure as OpenAiNativeOAuthError).reason).toBe("state_mismatch");
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("fails with port_in_use when every callback port is occupied", async () => {
    const http = await import("node:http");
    const blocker = http.createServer(() => undefined);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const blockedPort = (blocker.address() as { port: number }).port;
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          runOpenAiNativeOAuthFlow({
            codexHome,
            ports: [blockedPort],
            onAuthorizationUrl: () => Effect.void,
          }).pipe(Effect.scoped) as Effect.Effect<void, unknown>,
        ),
      );
      expect(failure).toBeInstanceOf(OpenAiNativeOAuthError);
      expect((failure as OpenAiNativeOAuthError).reason).toBe("port_in_use");
    } finally {
      blocker.close();
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

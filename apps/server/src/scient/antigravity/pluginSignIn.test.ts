import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { describe, expect, it } from "vite-plus/test";

import {
  extractPluginSignInChallenge,
  extractToolCallChallenge,
  LINK_REMOVED,
  makeAntigravityPluginSignIns,
  makeStreamRedactor,
} from "./pluginSignIn.ts";

const STATE = "synthetic-state-0123456789";
const CHALLENGE_CODE = "synthetic-challenge-abcdef";
const signInUrl = (
  overrides: Record<string, string> = {},
  base = "https://accounts.google.com/o/oauth2/v2/auth",
) => {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: "synthetic-client.example",
    code_challenge: CHALLENGE_CODE,
    code_challenge_method: "S256",
    prompt: "consent",
    redirect_uri: "http://127.0.0.1:57512/callback",
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    state: STATE,
    ...overrides,
  });
  return `${base}?${params.toString()}`;
};
const URL_OK = signInUrl();
const card = (slug = "gmail") => `<plugin-card catalog-id="${slug}"></plugin-card>`;
const challengeText = (url = URL_OK, cardText = card()) =>
  [
    "Command exited with code 1.",
    "",
    "Command output:",
    "gmail: gmail/google needs authentication (not signed in). Show the user this card on its own line:\r",
    `${cardText}\r`,
    `Ask them to sign in to gmail, then try again. Only if the card can't be shown, give them this sign-in link instead: ${url}\r`,
  ].join("\n");

describe("extractPluginSignInChallenge", () => {
  it("reads the card and the loopback sign-in page", () => {
    const challenge = extractPluginSignInChallenge(challengeText());
    expect(challenge?.plugin).toBe("gmail");
    expect(challenge?.authorizationUrl).toBe(URL_OK);
    expect(challenge?.secrets).toEqual([URL_OK, STATE, CHALLENGE_CODE]);
  });

  it.each([
    ["no card", challengeText().replace(card(), "")],
    ["two cards", challengeText(URL_OK, `${card()}${card("gdrive")}`)],
    [
      "a nested card",
      challengeText(URL_OK, `<plugin-card catalog-id="gmail">${card()}</plugin-card>`),
    ],
    ["a malformed card", challengeText(URL_OK, `<plugin-card catalog-id=gmail></plugin-card>`)],
    ["an oversized slug", challengeText(URL_OK, card("g".repeat(65)))],
    ["two URLs", `${challengeText()} see https://example.com/help`],
    ["a non-https page", challengeText(URL_OK.replace("https://", "http://"))],
    ["an unknown endpoint", challengeText(signInUrl({}, "https://evil.example/o/oauth2/v2/auth"))],
    [
      "a remote redirect",
      challengeText(signInUrl({ redirect_uri: "http://10.0.0.5:57512/callback" })),
    ],
    [
      "an https redirect",
      challengeText(signInUrl({ redirect_uri: "https://127.0.0.1:57512/callback" })),
    ],
    [
      "a redirect without a port",
      challengeText(signInUrl({ redirect_uri: "http://localhost/callback" })),
    ],
    [
      "a privileged redirect port",
      challengeText(signInUrl({ redirect_uri: "http://localhost:80/callback" })),
    ],
    [
      "another redirect path",
      challengeText(signInUrl({ redirect_uri: "http://127.0.0.1:57512/other" })),
    ],
    ["no state", challengeText(URL_OK.replace(`&state=${STATE}`, ""))],
    ["two states", challengeText(`${URL_OK}&state=second`)],
    [
      "two redirects",
      challengeText(`${URL_OK}&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcallback`),
    ],
    ["userinfo", challengeText(URL_OK.replace("https://", "https://user@"))],
    ["a fragment", challengeText(`${URL_OK}#frag`)],
    ["an oversized page", challengeText(signInUrl({ scope: "x".repeat(5_000) }))],
  ])("refuses %s", (_label, text) => {
    expect(extractPluginSignInChallenge(text)).toBeUndefined();
  });

  it("accepts [::1] and localhost loopback redirects", () => {
    for (const redirect_uri of ["http://[::1]:4000/callback", "http://localhost:4000/callback"]) {
      expect(
        extractPluginSignInChallenge(challengeText(signInUrl({ redirect_uri }))),
      ).toBeDefined();
    }
  });
});

describe("extractToolCallChallenge", () => {
  const output = challengeText();
  it("reads a tool result whose fields repeat the same text", () => {
    expect(
      extractToolCallChallenge({
        title: "gmail readonly search",
        rawInput: { CommandLine: "gmail readonly search" },
        rawOutput: { output, exit_code: 1 },
        content: [{ type: "content", content: { type: "text", text: output } }],
      })?.plugin,
    ).toBe("gmail");
  });

  it("refuses a challenge the call's own input wrote", () => {
    expect(
      extractToolCallChallenge({
        title: "echo",
        rawInput: { CommandLine: `echo '${output}'` },
        rawOutput: { output },
      }),
    ).toBeUndefined();
  });

  it("refuses fields that disagree on the page", () => {
    expect(
      extractToolCallChallenge({
        rawOutput: { output },
        content: [
          {
            type: "content",
            content: { type: "text", text: challengeText(signInUrl({ state: "other-state" })) },
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("makeStreamRedactor", () => {
  it("scrubs a pattern split across chunks and keeps the other text", () => {
    const redactor = makeStreamRedactor(() => [{ text: URL_OK, replacement: LINK_REMOVED }]);
    const text = `Open ${URL_OK} now.`;
    const chunks = [text.slice(0, 9), text.slice(9, 60), text.slice(60, 200), text.slice(200)];
    const emitted = chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.flush();
    expect(emitted).toBe(`Open ${LINK_REMOVED} now.`);
  });

  it("drops a standalone card and keeps an inline one", () => {
    const patterns = () => [{ text: card(), replacement: "", standalone: true }];
    const standalone = makeStreamRedactor(patterns);
    const out =
      standalone.push("Sign in below:\n\n<plugin-card catalog-id") +
      standalone.push(`="gmail"></plugin-card>`) +
      standalone.flush();
    expect(out).toBe("Sign in below:\n\n");
    const inline = makeStreamRedactor(patterns);
    expect(inline.push(`see ${card()} here`) + inline.flush()).toBe(`see ${card()} here`);
  });
});

const owner = {
  threadId: ThreadId.make("thread-1"),
  providerThreadId: ProviderThreadId.make("provider-thread-1"),
};
const toolUpdate = (
  toolCallId: string,
  fields: Partial<Extract<EffectAcpSchema.SessionUpdate, { sessionUpdate: "tool_call_update" }>>,
  sessionId = "session-1",
): EffectAcpSchema.SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "tool_call_update", toolCallId, ...fields },
});
const textChunk = (text: string, sessionId = "session-1"): EffectAcpSchema.SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const challengeUpdate = () =>
  toolUpdate("call-1", {
    status: "completed",
    kind: "execute",
    rawInput: { CommandLine: "gmail readonly search" },
    rawOutput: { output: challengeText(), exit_code: 1 },
    content: [{ type: "content", content: { type: "text", text: challengeText() } }],
  });
const textOf = (notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>) =>
  notifications
    .map((entry) =>
      entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.type === "text"
        ? entry.update.content.text
        : "",
    )
    .join("");

describe("makeAntigravityPluginSignIns", () => {
  const setup = (options?: { ttlMs?: number }) => {
    const signIns = makeAntigravityPluginSignIns(options);
    const generation = signIns.openGeneration();
    let ids = 0;
    const observe = (notification: EffectAcpSchema.SessionNotification, now = 0) =>
      signIns.observe({ generation, notification, now, newId: () => `attempt-${++ids}` });
    return { signIns, generation, observe };
  };

  it("scrubs the page from the projected tool call and offers it to its thread", () => {
    const { signIns, observe } = setup();
    const projected = observe(challengeUpdate());
    expect(JSON.stringify(projected)).not.toContain(STATE);
    expect(JSON.stringify(projected)).toContain(LINK_REMOVED);
    const notice = signIns.takeToolNotice("call-1", owner);
    expect(notice?.pluginSignIn).toEqual({
      attemptId: "attempt-1",
      plugin: "gmail",
      displayName: "Gmail",
    });
    expect(signIns.takeToolNotice("call-1", owner)).toBeUndefined();
    expect(
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-1", now: 1 }),
    ).toEqual({ url: URL_OK });
  });

  it("never opens the page for another thread or session", () => {
    const { signIns, observe } = setup();
    observe(challengeUpdate());
    signIns.takeToolNotice("call-1", owner);
    const other = { ...owner, threadId: ThreadId.make("thread-2") };
    expect(
      signIns.redeem({
        attemptId: "attempt-1",
        owner: other,
        nativeSessionId: "session-1",
        now: 1,
      }),
    ).toEqual({ failure: "not-found" });
    expect(
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-2", now: 1 }),
    ).toEqual({ failure: "not-found" });
  });

  it("expires attempts and retires them with their agent process", () => {
    const { signIns, generation, observe } = setup({ ttlMs: 1_000 });
    observe(challengeUpdate());
    signIns.takeToolNotice("call-1", owner);
    const redeem = (now: number) =>
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-1", now });
    expect(redeem(1_000)).toEqual({ failure: "expired" });
    expect(redeem(999)).toEqual({ url: URL_OK });
    signIns.closeGeneration(generation);
    expect(redeem(1)).toEqual({ failure: "expired" });
  });

  it("ignores model text that writes a card or a page", () => {
    const { signIns, observe } = setup();
    const projected = observe(textChunk(challengeText()));
    expect(textOf(projected)).toBe(challengeText());
    expect(signIns.takeToolNotice("call-1", owner)).toBeUndefined();
  });

  it("scrubs a repeated page across chunks and hides the repeated card", () => {
    const { signIns, generation, observe } = setup();
    observe(challengeUpdate());
    const reply = `Sign in here: ${URL_OK}\n\n${card()}`;
    const projected = [
      ...observe(textChunk(reply.slice(0, 30))),
      ...observe(textChunk(reply.slice(30, 300))),
      ...observe(textChunk(reply.slice(300))),
      ...signIns.flush(generation),
    ];
    expect(textOf(projected)).toBe(`Sign in here: ${LINK_REMOVED}\n\n`);
  });

  it("releases held text before the next update", () => {
    const { observe } = setup();
    observe(challengeUpdate());
    const held = observe(textChunk("ends with h"));
    expect(textOf(held)).toBe("ends with ");
    const next = observe({
      sessionId: "session-1",
      update: { sessionUpdate: "usage_update", used: 1, size: 2 },
    });
    expect(textOf(next)).toBe("h");
    expect(next.at(-1)?.update.sessionUpdate).toBe("usage_update");
  });

  it("reports the plugin's next successful call as signed in", () => {
    const { signIns, observe } = setup();
    observe(challengeUpdate());
    signIns.takeToolNotice("call-1", owner);
    observe(
      toolUpdate("call-2", {
        status: "completed",
        kind: "execute",
        rawInput: { CommandLine: "gmail readonly search --max 3" },
        rawOutput: { output: "3 messages", exit_code: 0 },
      }),
    );
    expect(signIns.takeToolNotice("call-2", owner)?.pluginSignIn).toEqual({
      attemptId: "attempt-1",
      plugin: "gmail",
      displayName: "Gmail",
      signedIn: true,
    });
    expect(
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-1", now: 1 }),
    ).toEqual({ failure: "expired" });
  });

  it("replaces an older attempt for the same plugin", () => {
    const { signIns, observe } = setup();
    observe(challengeUpdate());
    signIns.takeToolNotice("call-1", owner);
    const second = challengeText(signInUrl({ state: "second-state" }));
    observe(toolUpdate("call-3", { status: "completed", rawOutput: { output: second } }));
    signIns.takeToolNotice("call-3", owner);
    expect(
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-1", now: 1 }),
    ).toEqual({ failure: "expired" });
    expect(
      signIns.redeem({ attemptId: "attempt-2", owner, nativeSessionId: "session-1", now: 1 }),
    ).toEqual({ url: signInUrl({ state: "second-state" }) });
  });
});

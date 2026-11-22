import { ProviderThreadId, ThreadId } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import { describe, expect, it } from "vite-plus/test";

import {
  extractPluginSignInChallenge,
  extractToolCallChallenge,
  LINK_REMOVED,
  makeAntigravityPluginSignIns,
  makeStreamRedactor,
  plainCommandProgram,
  type PluginSignInCandidate,
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
  it("reads the card, the loopback sign-in page and its OAuth client", () => {
    const challenge = extractPluginSignInChallenge(challengeText());
    expect(challenge).toMatchObject({
      plugin: "gmail",
      authorizationUrl: URL_OK,
      endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      clientId: "synthetic-client.example",
      secrets: [URL_OK, STATE, CHALLENGE_CODE],
    });
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
    ["no client", challengeText(URL_OK.replace("client_id=synthetic-client.example&", ""))],
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
});

describe("extractToolCallChallenge", () => {
  const output = challengeText();
  it("reads a tool result whose fields repeat the same text", () => {
    expect(
      extractToolCallChallenge({
        inputs: ["gmail readonly search", { CommandLine: "gmail readonly search" }],
        outputs: [
          { output, exit_code: 1 },
          [{ type: "content", content: { type: "text", text: output } }],
        ],
      })?.plugin,
    ).toBe("gmail");
  });

  it("refuses a challenge the call's own input wrote", () => {
    expect(
      extractToolCallChallenge({
        inputs: ["echo", { CommandLine: `echo '${output}'` }],
        outputs: [{ output }],
      }),
    ).toBeUndefined();
  });

  it("refuses fields that disagree on the page", () => {
    expect(
      extractToolCallChallenge({
        inputs: [],
        outputs: [{ output }, challengeText(signInUrl({ state: "other-state" }))],
      }),
    ).toBeUndefined();
  });
});

describe("plainCommandProgram", () => {
  it("names the program of a plain command and nothing that shell syntax could feed", () => {
    expect(plainCommandProgram(`gmail readonly search "" --max 3`)).toBe("gmail");
    for (const command of [
      "cat notes.txt; gmail search",
      "gmail search | cat",
      "gmail search && echo done",
      "gmail $(cat x)",
      "gmail search > out.txt",
    ]) {
      expect(plainCommandProgram(command)).toBeUndefined();
    }
  });
});

describe("makeStreamRedactor", () => {
  const none = () => ({ secrets: [], cards: [] });

  it("scrubs a sign-in URL split across chunks without knowing it first", () => {
    const redactor = makeStreamRedactor(none);
    const text = `Open ${URL_OK} now.`;
    const chunks = [text.slice(0, 9), text.slice(9, 60), text.slice(60, 200), text.slice(200)];
    const emitted = chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.flush();
    expect(emitted).toBe(`Open ${LINK_REMOVED} now.`);
  });

  it("keeps an ordinary link", () => {
    const redactor = makeStreamRedactor(none);
    const emitted = redactor.push("see https://example.com/docs ") + redactor.flush();
    expect(emitted).toBe("see https://example.com/docs ");
  });

  it("drops a standalone card and keeps an inline one", () => {
    const patterns = () => ({ secrets: [], cards: [card()] });
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
type ToolUpdate = Extract<EffectAcpSchema.SessionUpdate, { sessionUpdate: "tool_call_update" }>;
const toolUpdate = (
  toolCallId: string,
  fields: Partial<ToolUpdate>,
  sessionId = "session-1",
): EffectAcpSchema.SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "tool_call_update", toolCallId, ...fields },
});
const toolChunk = (toolCallId: string, text: string): EffectAcpSchema.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: "tool_call_content_chunk",
    toolCallId,
    content: { type: "content", content: { type: "text", text } },
  },
});
const textChunk = (text: string, sessionId = "session-1"): EffectAcpSchema.SessionNotification => ({
  sessionId,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const usage: EffectAcpSchema.SessionNotification = {
  sessionId: "session-1",
  update: { sessionUpdate: "usage_update", used: 1, size: 2 },
};
const gmailRun = { CommandLine: "gmail readonly search" };
const challengeUpdate = (fields: Partial<ToolUpdate> = {}) =>
  toolUpdate("call-1", {
    status: "completed",
    kind: "execute",
    rawInput: gmailRun,
    rawOutput: { output: challengeText(), exit_code: 1 },
    content: [{ type: "content", content: { type: "text", text: challengeText() } }],
    ...fields,
  });
const textOf = (notifications: ReadonlyArray<EffectAcpSchema.SessionNotification>) =>
  notifications
    .map((entry) =>
      entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.type === "text"
        ? entry.update.content.text
        : entry.update.sessionUpdate === "tool_call_content_chunk" &&
            entry.update.content.type === "content" &&
            entry.update.content.content.type === "text"
          ? entry.update.content.content.text
          : "",
    )
    .join("");

describe("makeAntigravityPluginSignIns", () => {
  const setup = (options?: { ttlMs?: number }) => {
    const signIns = makeAntigravityPluginSignIns(options);
    const generation = signIns.openGeneration();
    let ids = 0;
    const observe = (notification: EffectAcpSchema.SessionNotification) =>
      signIns.observe({ generation, notification });
    const admit = (candidate: PluginSignInCandidate | undefined, now = 0) => {
      expect(candidate).toBeDefined();
      signIns.admit(candidate!, {
        attemptId: `attempt-${++ids}`,
        displayName: "Gmail",
        programs: ["gmail"],
        now,
      });
    };
    return { signIns, generation, observe, admit };
  };

  it("scrubs the page from the projected tool call and offers it once admitted", () => {
    const { signIns, observe, admit } = setup();
    const { notifications, candidate } = observe(challengeUpdate());
    expect(JSON.stringify(notifications)).not.toContain(STATE);
    expect(JSON.stringify(notifications)).toContain(LINK_REMOVED);
    expect(candidate).toMatchObject({ program: "gmail", toolCallId: "call-1" });
    admit(candidate);
    expect(signIns.takeToolNotice("session-1", "call-1", owner)?.pluginSignIn).toEqual({
      attemptId: "attempt-1",
      plugin: "gmail",
      displayName: "Gmail",
    });
    expect(signIns.takeToolNotice("session-1", "call-1", owner)).toBeUndefined();
    expect(
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-1", now: 1 }),
    ).toEqual({ url: URL_OK });
  });

  // regression: a stream-only challenge used to reach the projector before it was recognized.
  it("never projects the first streamed chunk of a page, and admits a stream-only challenge", () => {
    const { observe } = setup();
    observe(toolUpdate("call-s", { status: "in_progress", kind: "execute", rawInput: gmailRun }));
    const text = challengeText();
    const projected = [70, 260, 400, text.length].flatMap(
      (end, index, ends) =>
        observe(toolChunk("call-s", text.slice(index === 0 ? 0 : ends[index - 1], end)))
          .notifications,
    );
    const ending = observe(toolUpdate("call-s", { status: "failed" }));
    const all = [...projected, ...ending.notifications];
    expect(JSON.stringify(all)).not.toContain(STATE);
    expect(JSON.stringify(all)).not.toContain(CHALLENGE_CODE);
    expect(textOf(all)).toContain(LINK_REMOVED);
    expect(ending.candidate?.challenge.authorizationUrl).toBe(URL_OK);
  });

  it("scrubs a page from a tool that earns no notice", () => {
    const { signIns, observe } = setup();
    for (const fields of [
      { kind: "other" as const, rawInput: { url: "https://example.com" } },
      { rawInput: { CommandLine: "cat notes.txt; gmail readonly search" } },
    ]) {
      const { notifications, candidate } = observe(challengeUpdate(fields));
      expect(candidate).toBeUndefined();
      expect(JSON.stringify(notifications)).not.toContain(STATE);
    }
    expect(signIns.takeToolNotice("session-1", "call-1", owner)).toBeUndefined();
  });

  it("never opens the page for another thread or session", () => {
    const { signIns, observe, admit } = setup();
    admit(observe(challengeUpdate()).candidate);
    signIns.takeToolNotice("session-1", "call-1", owner);
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
    const { signIns, generation, observe, admit } = setup({ ttlMs: 1_000 });
    admit(observe(challengeUpdate()).candidate);
    signIns.takeToolNotice("session-1", "call-1", owner);
    const redeem = (now: number) =>
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-1", now });
    expect(redeem(1_000)).toEqual({ failure: "expired" });
    expect(redeem(999)).toEqual({ url: URL_OK });
    signIns.closeGeneration(generation);
    expect(redeem(1)).toEqual({ failure: "expired" });
  });

  it("ignores model text that writes a card or a page", () => {
    const { signIns, observe } = setup();
    const { candidate } = observe(textChunk(challengeText()));
    expect(candidate).toBeUndefined();
    expect(signIns.takeToolNotice("session-1", "call-1", owner)).toBeUndefined();
  });

  it("scrubs a repeated page across chunks and hides the repeated card", () => {
    const { signIns, generation, observe, admit } = setup();
    admit(observe(challengeUpdate()).candidate);
    const reply = `Sign in here: ${URL_OK}\n\n${card()}`;
    const projected = [
      ...observe(textChunk(reply.slice(0, 30))).notifications,
      ...observe(textChunk(reply.slice(30, 300))).notifications,
      ...observe(textChunk(reply.slice(300))).notifications,
      ...signIns.flush(generation),
    ];
    expect(textOf(projected)).toBe(`Sign in here: ${LINK_REMOVED}\n\n`);
  });

  // regression: an interleaved update used to release half of a split page.
  it("holds a split page across interleaved updates until its stream ends", () => {
    const { signIns, generation, observe } = setup();
    const reply = `Open ${URL_OK} please`;
    const projected = [
      ...observe(textChunk(reply.slice(0, 120))).notifications,
      ...observe(usage).notifications,
      ...observe(textChunk(reply.slice(120))).notifications,
      ...signIns.flush(generation),
    ];
    expect(JSON.stringify(projected)).not.toContain(STATE);
    expect(textOf(projected)).toBe(`Open ${LINK_REMOVED} please`);
  });

  // regression: a tool status between two reply chunks used to flush the reply's held text.
  it("holds a split page in the reply across another tool's updates", () => {
    const { signIns, generation, observe } = setup();
    const reply = `Open ${URL_OK} please`;
    const projected = [
      ...observe(textChunk(reply.slice(0, 120))).notifications,
      ...observe(toolUpdate("call-9", { status: "in_progress", kind: "read" })).notifications,
      ...observe(toolUpdate("call-9", { status: "completed", kind: "read" })).notifications,
      ...observe(textChunk(reply.slice(120))).notifications,
      ...signIns.flush(generation),
    ];
    expect(JSON.stringify(projected)).not.toContain(STATE);
    expect(textOf(projected)).toBe(`Open ${LINK_REMOVED} please`);
  });

  // regression: whole messages, compaction summaries and terminal output skipped the scrub.
  it("scrubs a page from every other update that shows text", () => {
    const { signIns, generation, observe } = setup();
    const reply = `Open ${URL_OK} please`;
    const whole = observe({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message",
        messageId: "m-1",
        content: [{ type: "text", text: reply }],
      },
    } as EffectAcpSchema.SessionNotification).notifications;
    const summary = [
      ...observe({
        sessionId: "session-1",
        update: {
          sessionUpdate: "compaction_summary_chunk",
          compactionId: "c-1",
          content: { type: "text", text: reply.slice(0, 120) },
        },
      } as EffectAcpSchema.SessionNotification).notifications,
      ...observe({
        sessionId: "session-1",
        update: {
          sessionUpdate: "compaction_summary_chunk",
          compactionId: "c-1",
          content: { type: "text", text: reply.slice(120) },
        },
      } as EffectAcpSchema.SessionNotification).notifications,
    ];
    const bytes = Buffer.from(reply, "utf8");
    const terminal = (data: Buffer) =>
      observe({
        sessionId: "session-1",
        update: {
          sessionUpdate: "terminal_output_chunk",
          terminalId: "t-1",
          data: data.toString("base64"),
        },
      } as EffectAcpSchema.SessionNotification).notifications;
    const output = [...terminal(bytes.subarray(0, 120)), ...terminal(bytes.subarray(120))];
    const rest = signIns.flush(generation);
    const shown = JSON.stringify([...whole, ...summary, ...rest]);
    expect(shown).not.toContain(STATE);
    expect(shown).toContain(LINK_REMOVED);
    const terminalText = [...output, ...rest]
      .map((entry) =>
        entry.update.sessionUpdate === "terminal_output_chunk"
          ? Buffer.from(entry.update.data, "base64").toString("utf8")
          : "",
      )
      .join("");
    expect(terminalText).toBe(`Open ${LINK_REMOVED} please`);
  });

  it("keeps two sessions' notices for the same tool call id apart", () => {
    const { signIns, observe, admit } = setup();
    admit(observe(challengeUpdate()).candidate);
    expect(signIns.takeToolNotice("session-2", "call-1", owner)).toBeUndefined();
    expect(signIns.takeToolNotice("session-1", "call-1", owner)).toBeDefined();
  });

  it("reports the plugin's next successful call as signed in", () => {
    const { signIns, observe, admit } = setup();
    admit(observe(challengeUpdate()).candidate);
    signIns.takeToolNotice("session-1", "call-1", owner);
    observe(
      toolUpdate("call-2", {
        status: "completed",
        kind: "execute",
        rawInput: { CommandLine: "gmail readonly search --max 3" },
        rawOutput: { output: "3 messages", exit_code: 0 },
      }),
    );
    expect(signIns.takeToolNotice("session-1", "call-2", owner)?.pluginSignIn).toEqual({
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
    const { signIns, observe, admit } = setup();
    admit(observe(challengeUpdate()).candidate);
    signIns.takeToolNotice("session-1", "call-1", owner);
    const second = challengeText(signInUrl({ state: "second-state" }));
    admit(
      observe(
        toolUpdate("call-3", {
          status: "completed",
          kind: "execute",
          rawInput: gmailRun,
          rawOutput: { output: second },
        }),
      ).candidate,
    );
    signIns.takeToolNotice("session-1", "call-3", owner);
    expect(
      signIns.redeem({ attemptId: "attempt-1", owner, nativeSessionId: "session-1", now: 1 }),
    ).toEqual({ failure: "expired" });
    expect(
      signIns.redeem({ attemptId: "attempt-2", owner, nativeSessionId: "session-1", now: 1 }),
    ).toEqual({ url: signInUrl({ state: "second-state" }) });
  });
});

import { describe, expect, it } from "@effect/vitest";
import type { ChatGptDictationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CHATGPT_TRANSCRIBE_URL,
  type CodexSignInConnection,
  makeChatGptDictationThroughCodex,
} from "./CodexChatGptDictation.ts";

const wav = new TextEncoder().encode("RIFF-test-recording");

/** A synthetic ChatGPT access token whose claims name a workspace. */
const accessToken = (name: string) =>
  [
    "header",
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: `workspace-${name}` },
      }),
    ).toString("base64url"),
    name,
  ].join(".");

interface Run {
  readonly tokenReads: Array<{ readonly includeToken: unknown; readonly refreshToken: unknown }>;
  readonly uploads: Array<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly file: string | undefined;
    readonly language: string | undefined;
  }>;
}

/**
 * Dictates once against a stand-in Codex that answers `getAuthStatus` with `auth(refresh)`, and a
 * stand-in transcription service that answers each upload with the next of `replies`.
 */
const dictateWith = (input: {
  readonly auth: (refresh: boolean) => { authMethod: unknown; authToken: string | null };
  readonly replies: ReadonlyArray<{ readonly status: number; readonly body?: unknown }>;
  readonly language?: "he";
}) =>
  Effect.gen(function* () {
    const run: Run = { tokenReads: [], uploads: [] };
    const replies = [...input.replies];
    const connection = {
      version: "0.169.0",
      client: {
        request: ((method: string, params: { includeToken: unknown; refreshToken: unknown }) => {
          expect(method).toBe("getAuthStatus");
          run.tokenReads.push(params);
          return Effect.succeed({
            ...input.auth(params.refreshToken === true),
            requiresOpenaiAuth: true,
          });
        }) as unknown as CodexSignInConnection["client"]["request"],
      },
    } satisfies CodexSignInConnection;
    const http = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.promise(async () => {
        const form = request.body._tag === "FormData" ? request.body.formData : undefined;
        const file = form?.get("file");
        run.uploads.push({
          url: request.url,
          headers: request.headers,
          file: file instanceof Blob ? await file.text() : undefined,
          language: form?.get("language")?.toString(),
        });
        const reply = replies.shift() ?? { status: 500 };
        return HttpClientResponse.fromWeb(
          request,
          Response.json(reply.body ?? {}, { status: reply.status }),
        );
      }),
    );
    const dictation = makeChatGptDictationThroughCodex(Effect.succeed(connection), http);
    const exit = yield* Effect.exit(
      dictation.dictate({ wav, ...(input.language ? { language: input.language } : {}) }),
    );
    return { exit, run };
  });

const reasonOf = (exit: Exit.Exit<unknown, ChatGptDictationError>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as ChatGptDictationError).reason : undefined;

const signedIn = () => ({ authMethod: "chatgpt", authToken: accessToken("current") });

describe("dictation with ChatGPT through Codex", () => {
  it.effect("uploads the recording with Codex's sign-in and returns ChatGPT's text", () =>
    Effect.gen(function* () {
      const { exit, run } = yield* dictateWith({
        auth: signedIn,
        replies: [{ status: 200, body: { text: " The p value was below 0.05. " } }],
        language: "he",
      });
      expect(exit).toEqual(Exit.succeed({ text: "The p value was below 0.05." }));
      expect(run.tokenReads).toEqual([{ includeToken: true, refreshToken: false }]);
      expect(run.uploads).toHaveLength(1);
      const [upload] = run.uploads;
      expect(upload!.url).toBe(CHATGPT_TRANSCRIBE_URL);
      expect(upload!.headers.authorization).toBe(`Bearer ${accessToken("current")}`);
      expect(upload!.headers["chatgpt-account-id"]).toBe("workspace-current");
      expect(upload!.file).toBe("RIFF-test-recording");
      expect(upload!.language).toBe("he");
    }),
  );

  it.effect("asks Codex for a fresh token once when ChatGPT refuses the current one", () =>
    Effect.gen(function* () {
      const { exit, run } = yield* dictateWith({
        auth: (refresh) => ({
          authMethod: "chatgpt",
          authToken: accessToken(refresh ? "fresh" : "stale"),
        }),
        replies: [{ status: 401 }, { status: 200, body: { text: "hello" } }],
      });
      expect(exit).toEqual(Exit.succeed({ text: "hello" }));
      expect(run.tokenReads.map((read) => read.refreshToken)).toEqual([false, true]);
      expect(run.uploads.map((upload) => upload.headers.authorization)).toEqual([
        `Bearer ${accessToken("stale")}`,
        `Bearer ${accessToken("fresh")}`,
      ]);
    }),
  );

  it.effect("asks for a sign-in when the fresh token is refused too", () =>
    Effect.gen(function* () {
      const { exit, run } = yield* dictateWith({
        auth: signedIn,
        replies: [{ status: 401 }, { status: 401 }],
      });
      expect(reasonOf(exit)).toBe("signed-out");
      expect(run.uploads).toHaveLength(2);
    }),
  );

  it.effect("uploads nothing when Codex is signed in with an API key", () =>
    Effect.gen(function* () {
      const { exit, run } = yield* dictateWith({
        auth: () => ({ authMethod: "apikey", authToken: "sk-synthetic" }),
        replies: [],
      });
      expect(reasonOf(exit)).toBe("signed-out");
      expect(run.uploads).toEqual([]);
    }),
  );

  it.effect.each([
    [413, "invalid-audio"],
    [429, "rate-limited"],
    [503, "unavailable"],
  ] as const)("reports a %s from ChatGPT as %s", ([status, reason]) =>
    Effect.gen(function* () {
      const { exit } = yield* dictateWith({ auth: signedIn, replies: [{ status }] });
      expect(reasonOf(exit)).toBe(reason);
    }),
  );
});

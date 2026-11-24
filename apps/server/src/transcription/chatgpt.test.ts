import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { CodexSignInConnection } from "../scient/voice/CodexChatGptDictation.ts";
import { checkChatGptSignIn, openChatGptRecognizer } from "./chatgpt.ts";

it.effect("uses one scoped Codex connection and backs off before pausing later windows", () =>
  Effect.gen(function* () {
    let opens = 0;
    let closes = 0;
    const refresh: boolean[] = [];
    const replies = [401, 200, 429, 429, 429];
    const connection: CodexSignInConnection = {
      version: undefined,
      client: {
        request: ((_method: string, params: { refreshToken?: boolean }) => {
          refresh.push(params.refreshToken === true);
          return Effect.succeed({ authMethod: "chatgpt", authToken: "synthetic" });
        }) as CodexSignInConnection["client"]["request"],
      },
    };
    const connect = Effect.acquireRelease(
      Effect.sync(() => {
        opens++;
        return connection;
      }),
      () =>
        Effect.sync(() => {
          closes++;
        }),
    );
    const http = HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          Response.json({ text: "hello" }, { status: replies.shift() ?? 500 }),
        ),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const transcribe = yield* openChatGptRecognizer(connect, http, "en");
        expect(yield* transcribe(new Float32Array(800))).toEqual([{ text: "hello" }]);
        const work = yield* transcribe(new Float32Array(800)).pipe(
          Effect.result,
          Effect.forkScoped,
        );
        yield* TestClock.adjust("21 seconds");
        const result = yield* Fiber.join(work);
        expect(result._tag === "Failure" && result.failure._tag).toBe("TranscriptionRateLimited");
        expect(replies).toEqual([]);
      }),
    );
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(refresh).toEqual([false, true, false, false, false]);
  }),
);

it.effect(
  "reports ChatGPT sign-in without refreshing credentials or returning account details",
  () =>
    Effect.gen(function* () {
      for (const [account, expected] of [
        [{ type: "chatgpt", email: "synthetic@example.invalid", planType: "plus" }, true],
        [{ type: "apiKey" }, false],
        [null, false],
      ] as const) {
        const connection: CodexSignInConnection = {
          version: undefined,
          client: {
            request: ((method: string, input: unknown) => {
              expect(method).toBe("account/read");
              expect(input).toEqual({ refreshToken: false });
              return Effect.succeed({ account });
            }) as CodexSignInConnection["client"]["request"],
          },
        };
        expect(yield* checkChatGptSignIn(Effect.succeed(connection))).toBe(expected);
      }
      expect(yield* checkChatGptSignIn(Effect.fail("unavailable"))).toBeNull();
    }),
);

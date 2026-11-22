/**
 * Dictation with ChatGPT through Codex's sign-in. Scient asks this Codex instance for its ChatGPT
 * access token (`getAuthStatus`), uploads the recording to ChatGPT's own transcription service,
 * the one the Codex and ChatGPT apps dictate with, and returns the text. The token is held only
 * for the request; Codex keeps owning, storing and refreshing it.
 */
import {
  ChatGptDictationError,
  type ChatGptDictationErrorReason,
  type CodexSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import {
  type CodexAppServerConnection,
  openCodexAppServerConnection,
} from "../../provider/CodexProvider.ts";
import type { ProviderVoiceDictation } from "../../provider/ScientProviderInstanceSeams.ts";

export const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
/** The client ChatGPT's dictation service knows, as Scient Agent's dictation sends it. */
const ORIGINATOR = "Codex Desktop";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

const AccessTokenClaims = Schema.Struct({
  [JWT_AUTH_CLAIM]: Schema.optionalKey(
    Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
  ),
});
const decodeAccessTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(AccessTokenClaims),
);
const TranscribeResponse = Schema.Struct({ text: Schema.String });

/** The ChatGPT workspace an access token belongs to, which the service expects as a header. */
function chatGptAccountIdOfAccessToken(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  const claims = decodeAccessTokenClaims(Buffer.from(payload, "base64url").toString("utf8"));
  return claims._tag === "Some" ? claims.value[JWT_AUTH_CLAIM]?.chatgpt_account_id : undefined;
}

/** What a non-success answer from the transcription service means for the user. */
function chatGptTranscribeFailure(status: number): ChatGptDictationErrorReason {
  if (status === 400 || status === 413 || status === 415) return "invalid-audio";
  if (status === 401 || status === 403) return "signed-out";
  if (status === 429) return "rate-limited";
  return "unavailable";
}

const fail = (reason: ChatGptDictationErrorReason) => new ChatGptDictationError({ reason });
const isDictationError = Schema.is(ChatGptDictationError);

export interface CodexChatGptDictationOptions {
  readonly settings: CodexSettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly http: HttpClient.HttpClient;
}

export function makeCodexChatGptDictation(
  options: CodexChatGptDictationOptions,
): ProviderVoiceDictation {
  return makeChatGptDictationThroughCodex(
    openCodexAppServerConnection({
      binaryPath: options.settings.binaryPath,
      homePath: options.settings.homePath,
      launchArgs: resolveCodexLaunchArgs(options.settings.launchArgs, options.environment),
      cwd: options.cwd,
      environment: options.environment,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
      Effect.mapError(() => fail("agent-unavailable")),
    ),
    options.http,
  );
}

/** The part of a Codex app-server connection that dictation reads the sign-in through. */
export interface CodexSignInConnection {
  readonly client: Pick<CodexAppServerConnection["client"], "request">;
  readonly version: string | undefined;
}

/** Dictation over one Codex connection per recording, opened by `connect`. */
export function makeChatGptDictationThroughCodex(
  connect: Effect.Effect<CodexSignInConnection, ChatGptDictationError, Scope.Scope>,
  http: HttpClient.HttpClient,
): ProviderVoiceDictation {
  const open = connect.pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(fail("agent-unavailable")),
    }),
  );

  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(() => fail("unavailable")),
    );

  const dictate: ProviderVoiceDictation["dictate"] = Effect.fn("CodexChatGptDictation.dictate")(
    function* (input) {
      if (input.wav.byteLength === 0) return yield* fail("invalid-audio");
      const { client, version } = yield* open;
      /** The sign-in's access token; `refresh` asks Codex for a fresh one after a refusal. */
      const accessToken = Effect.fn("CodexChatGptDictation.accessToken")(function* (
        refresh: boolean,
      ) {
        const status = yield* client
          .request("getAuthStatus", { includeToken: true, refreshToken: refresh })
          .pipe(Effect.mapError(() => fail("agent-unavailable")));
        // Codex's own ChatGPT OAuth, or ChatGPT tokens a host app such as Scient supplies.
        const chatGptSignIn =
          status.authMethod === "chatgpt" || status.authMethod === "chatgptAuthTokens";
        if (!chatGptSignIn || !status.authToken) return yield* fail("signed-out");
        return status.authToken;
      });
      const upload = Effect.fn("CodexChatGptDictation.upload")(function* (token: string) {
        const form = new FormData();
        form.set(
          "file",
          new Blob([new Uint8Array(input.wav)], { type: "audio/wav" }),
          "dictation.wav",
        );
        if (input.language) form.set("language", input.language);
        const accountId = chatGptAccountIdOfAccessToken(token);
        return yield* execute(
          HttpClientRequest.post(CHATGPT_TRANSCRIBE_URL).pipe(
            HttpClientRequest.bearerToken(Redacted.make(token)),
            HttpClientRequest.setHeaders({
              originator: ORIGINATOR,
              ...(version ? { version, "user-agent": `${ORIGINATOR}/${version}` } : {}),
              ...(accountId ? { "chatgpt-account-id": accountId } : {}),
            }),
            HttpClientRequest.bodyFormData(form),
          ),
        );
      });

      let response = yield* upload(yield* accessToken(false));
      // A token Codex has not refreshed yet is refused once; a fresh one is tried before signing out.
      if (response.status === 401) response = yield* upload(yield* accessToken(true));
      if (response.status < 200 || response.status >= 300)
        return yield* fail(chatGptTranscribeFailure(response.status));
      const { text } = yield* HttpClientResponse.schemaBodyJson(TranscribeResponse)(response).pipe(
        Effect.mapError(() => fail("unavailable")),
      );
      return { text: text.trim() };
    },
    Effect.scoped,
    // ChatGPT answers a long dictation in seconds; a stuck upload must not hold the composer.
    Effect.timeoutOrElse({
      duration: "90 seconds",
      orElse: () => Effect.fail(fail("unavailable")),
    }),
    Effect.mapError((error) => (isDictationError(error) ? error : fail("agent-unavailable"))),
  );

  return { dictate };
}

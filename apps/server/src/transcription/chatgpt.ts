import {
  ChatGptDictationError,
  VoiceTranscriptionLanguage,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import {
  makeChatGptDictationThroughCodex,
  type CodexSignInConnection,
} from "../scient/voice/CodexChatGptDictation.ts";
import { wave } from "../speech/CloudSpeech.ts";
import { RateLimited } from "./job.ts";

const isLanguage = Schema.is(VoiceTranscriptionLanguage);

export const dictateWithChatGptInstance = Effect.fn("Speech.dictateWithChatGptInstance")(function* (
  instances: Pick<ProviderInstances.ProviderInstanceRegistry["Service"], "getInstance">,
  id: ProviderInstanceId,
  wav: Uint8Array,
  language?: VoiceTranscriptionLanguage,
) {
  const instance = yield* instances.getInstance(id);
  if (!instance?.enabled || !instance.voiceDictation)
    return yield* new ChatGptDictationError({ reason: "agent-unavailable" });
  return yield* instance.voiceDictation.dictate({ wav, ...(language ? { language } : {}) });
});

export const openChatGptRecognizer = Effect.fn("Transcription.openChatGptRecognizer")(function* <E>(
  connect: Effect.Effect<CodexSignInConnection, E, Scope.Scope>,
  http: HttpClient.HttpClient,
  language: string,
) {
  const connection = yield* connect.pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new ChatGptDictationError({ reason: "agent-unavailable" })),
  );
  const adapter = makeChatGptDictationThroughCodex(Effect.succeed(connection), http);
  let uploaded = false;
  return Effect.fn("Transcription.recognizeChatGpt")(function* (pcm: Float32Array) {
    if (uploaded) yield* Effect.sleep("1 second");
    uploaded = true;
    const wav = new Uint8Array(wave(pcm));
    for (const delay of [5_000, 15_000, 0]) {
      const outcome = yield* adapter
        .dictate({ wav, ...(isLanguage(language) ? { language } : {}) })
        .pipe(Effect.result);
      if (outcome._tag === "Success") return [{ text: outcome.success.text }];
      if (outcome.failure.reason !== "rate-limited") return yield* outcome.failure;
      if (!delay) return yield* new RateLimited();
      yield* Effect.sleep(delay);
    }
    return yield* new RateLimited();
  });
});

export const checkChatGptSignIn = Effect.fn("Transcription.checkChatGptSignIn")(
  function* <E>(connect: Effect.Effect<CodexSignInConnection, E, Scope.Scope>) {
    const connection = yield* connect;
    const status = yield* connection.client.request("account/read", { refreshToken: false });
    return status.account?.type === "chatgpt";
  },
  Effect.scoped,
  Effect.timeout("5 seconds"),
  Effect.orElseSucceed(() => null),
);

export class ChatGptEngineServices extends Context.Service<
  ChatGptEngineServices,
  {
    readonly resolve: (id?: ProviderInstanceId) => Effect.Effect<
      | {
          id: ProviderInstanceId;
          signedIn: (cwd: string) => Effect.Effect<boolean | null>;
          open: (cwd: string, language: string) => ReturnType<typeof openChatGptRecognizer>;
        }
      | undefined
    >;
  }
>()("t3/transcription/chatgpt/ChatGptEngineServices") {}

export const layer = Layer.effect(
  ChatGptEngineServices,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const instances = yield* ProviderInstances.ProviderInstanceRegistry;
    return ChatGptEngineServices.of({
      resolve: Effect.fn("ChatGptEngineServices.resolve")(function* (id) {
        const instance = id
          ? yield* instances.getInstance(id)
          : (yield* instances.listInstances).find(
              (entry) => entry.enabled && entry.openCodexConnection,
            );
        const open = instance?.openCodexConnection;
        if (!instance?.enabled || !open) return undefined;
        return {
          id: instance.instanceId,
          signedIn: (cwd) => checkChatGptSignIn(open(cwd)),
          open: (cwd, language) => openChatGptRecognizer(open(cwd), http, language),
        };
      }),
    });
  }),
);

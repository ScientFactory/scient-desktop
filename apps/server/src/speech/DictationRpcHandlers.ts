import { dispatchDictation, type DictationDependencies } from "./dictation.ts";
import type { CloudEngines } from "../transcription/CloudEngines.ts";
import { DictationError, WS_METHODS, WsWorkspaceRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../scient/ScientRpcObservers.ts";

export const makeDictationRpcHandlers = ({
  observeRpcEffect,
  speech,
  cloud,
  cloudChoices,
  providerInstances,
}: Pick<ScientRpcObservers, "observeRpcEffect"> &
  DictationDependencies & {
    cloudChoices?:
      | Pick<
          CloudEngines["Service"],
          "listDictationChoices" | "chooseForDictation" | "execute" | "savedKeys"
        >
      | undefined;
  }) =>
  ({
    [WS_METHODS.voiceDictationWait]: () =>
      observeRpcEffect(
        WS_METHODS.voiceDictationWait,
        (speech?.waitingForWorker ?? Effect.succeed(false)).pipe(
          Effect.map((waiting) => ({ waiting })),
        ),
        { "rpc.aggregate": "voice" },
      ),
    [WS_METHODS.voiceCloudChoices]: () =>
      observeRpcEffect(
        WS_METHODS.voiceCloudChoices,
        (cloudChoices?.listDictationChoices ?? Effect.succeed([])).pipe(
          Effect.mapError(() => new DictationError({ reason: "cloud-unavailable" })),
        ),
        { "rpc.aggregate": "voice" },
      ),
    [WS_METHODS.voiceChooseCloud]: (input) =>
      observeRpcEffect(
        WS_METHODS.voiceChooseCloud,
        cloudChoices
          ? cloudChoices
              .chooseForDictation(input)
              .pipe(Effect.mapError(() => new DictationError({ reason: "cloud-unavailable" })))
          : Effect.fail(new DictationError({ reason: "cloud-unavailable" })),
        { "rpc.aggregate": "voice" },
      ),
    [WS_METHODS.voiceSavedKeys]: ({ origin }) =>
      observeRpcEffect(
        WS_METHODS.voiceSavedKeys,
        cloudChoices
          ? cloudChoices
              .savedKeys(origin)
              .pipe(Effect.mapError(() => new DictationError({ reason: "cloud-unavailable" })))
          : Effect.succeed([]),
        { "rpc.aggregate": "voice" },
      ),
    [WS_METHODS.voiceConfigureCloud]: (input) =>
      observeRpcEffect(
        WS_METHODS.voiceConfigureCloud,
        cloudChoices
          ? cloudChoices
              .execute(
                input.action === "add" || input.action === "update"
                  ? { ...input, maxAudioBytes: 25_000_000 }
                  : input,
              )
              .pipe(
                Effect.asVoid,
                Effect.mapError(() => new DictationError({ reason: "cloud-unavailable" })),
              )
          : Effect.fail(new DictationError({ reason: "cloud-unavailable" })),
        { "rpc.aggregate": "voice" },
      ),
    [WS_METHODS.voiceDictate]: (input) =>
      observeRpcEffect(
        WS_METHODS.voiceDictate,
        dispatchDictation({ speech, cloud, providerInstances }, input),
        { "rpc.aggregate": "voice" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    | typeof WS_METHODS.voiceDictate
    | typeof WS_METHODS.voiceDictationWait
    | typeof WS_METHODS.voiceCloudChoices
    | typeof WS_METHODS.voiceSavedKeys
    | typeof WS_METHODS.voiceConfigureCloud
    | typeof WS_METHODS.voiceChooseCloud
  >;

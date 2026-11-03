import { ProviderDriverKind, type OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import {
  droidControlCall,
  DroidControlError,
  withDroidControl,
  type DroidControlClientFactory,
} from "./DroidControl.ts";

interface DroidPrompt {
  readonly id: string;
  readonly text: string;
}

const isText = (block: unknown): block is { readonly type: "text"; readonly text: string } =>
  Predicate.isObject(block) && block.type === "text" && typeof block.text === "string";

/**
 * The prompts Droid received, oldest first: user messages with text that are
 * neither Droid's injected context nor its hook records (which have no text).
 */
function droidPrompts(messages: ReadonlyArray<unknown>): ReadonlyArray<DroidPrompt> {
  const prompts: Array<DroidPrompt> = [];
  for (const message of messages) {
    if (!Predicate.isObject(message) || message.role !== "user") continue;
    if (typeof message.id !== "string" || message.id.startsWith("context-")) continue;
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter(isText)
      .map((block) => block.text)
      .filter((part) => !part.trimStart().startsWith("<system-reminder>"))
      .join("\n");
    if (text.trim().length > 0) prompts.push({ id: message.id, text });
  }
  return prompts;
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * Forks Droid's session before the first removed turn; the source stays intact. Each accepted
 * provider turn is one Droid prompt: delivery must be known, the counts must match and the last
 * kept prompt must carry the kept message, or nothing changes (after compaction, say).
 */
export const rewindDroidSession = (
  control: { readonly binaryPath: string; readonly environment: NodeJS.ProcessEnv },
  input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly keptTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
    readonly removedTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
    readonly keptMessageText: string | undefined;
  },
  makeClient?: DroidControlClientFactory,
): Effect.Effect<string, ProviderAdapter.ProviderAdapterProtocolError> =>
  withDroidControl(
    {
      ...control,
      cwd: input.cwd,
      sessionId: input.sessionId,
      purpose: "rewinding this conversation",
    },
    (client) =>
      Effect.gen(function* () {
        const prompts = droidPrompts(client.messages);
        const reached = (turns: ReadonlyArray<OrchestrationV2ProviderTurn>) =>
          turns.filter((turn) => turn.nativeAcceptance === "accepted").length;
        const kept = reached(input.keptTurns);
        const lastKept = kept === 0 ? undefined : prompts[kept - 1];
        const keptText = normalize(input.keptMessageText ?? "").slice(0, 200);
        if (
          [...input.keptTurns, ...input.removedTurns].some(
            (turn) => turn.nativeAcceptance !== "accepted" && turn.nativeAcceptance !== "pending",
          ) ||
          prompts.length !== kept + reached(input.removedTurns) ||
          (lastKept !== undefined &&
            keptText.length > 0 &&
            !normalize(lastKept.text).includes(keptText))
        ) {
          return yield* new DroidControlError({
            detail:
              "Droid's history no longer matches this conversation (it may have been compacted), so it cannot be rewound here.",
          });
        }
        const firstRemoved = prompts[kept];
        // The removed turns never reached Droid: its conversation already ends at the target.
        if (firstRemoved === undefined) return input.sessionId;
        const { newSessionId } = yield* droidControlCall(
          "Droid could not rewind this conversation. Update Droid if this keeps happening.",
          () => client.rewindBefore(firstRemoved.id),
        );
        return newSessionId;
      }),
    makeClient,
  ).pipe(
    Effect.mapError(
      (error) =>
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ProviderDriverKind.make("droid"),
          detail: error.detail,
        }),
    ),
  );

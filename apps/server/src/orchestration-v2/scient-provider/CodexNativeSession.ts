// @effect-diagnostics nodeBuiltinImport:off -- The pure native-session launch key preserves its persisted identity.
import * as NodeCrypto from "node:crypto";

import {
  CodexSettings,
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type { IdAllocatorV2Shape } from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { isPreAcceptanceRejectionCode } from "./NativeTurnReceipts.ts";

const encodeRuntime = Schema.encodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      settings: CodexSettings,
      command: Schema.String,
      args: Schema.Array(Schema.String),
      shell: Schema.Boolean,
      environment: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)),
    }),
  ),
);

/** Hash exactly the immutable inputs handed to open; never persist credentials. */
export const codexLaunchConfiguration = (input: {
  readonly settings: CodexSettings;
  readonly launch: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly shell: boolean;
  };
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string =>
  `codex-launch:v1:${NodeCrypto.createHash("sha256")
    .update(
      encodeRuntime({
        version: 1,
        settings: input.settings,
        ...input.launch,
        environment: Object.fromEntries(
          Object.entries(input.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      }),
    )
    .digest("hex")}`;

/** Context windows Codex reported for root turns, per exact launch configuration and selection. */
export const makeCodexModelContextWindows = (instanceId: ProviderInstanceId) => {
  const modelWindows: Array<{
    readonly configuration: string;
    readonly selection: ModelSelection;
    window: number;
  }> = [];
  return {
    record: (
      configuration: string,
      context: {
        readonly subagent: unknown;
        readonly input: { readonly modelSelection: ModelSelection };
      },
      window: number | null | undefined,
    ): void => {
      if (
        context.subagent === null &&
        context.input.modelSelection.instanceId === instanceId &&
        typeof window === "number" &&
        Number.isFinite(window) &&
        window > 0
      ) {
        const known = modelWindows.find(
          (report) =>
            report.configuration === configuration &&
            modelSelectionsEqual(report.selection, context.input.modelSelection),
        );
        if (known) known.window = window;
        else
          modelWindows.push({
            configuration,
            selection: context.input.modelSelection,
            window,
          });
      }
    },
    get: (configuration: string, selection: ModelSelection): number | undefined =>
      selection.instanceId === instanceId
        ? modelWindows.find(
            (report) =>
              report.configuration === configuration &&
              modelSelectionsEqual(report.selection, selection),
          )?.window
        : undefined,
  };
};

const isCodexRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

/**
 * Only an in-flight native start owns this observation. Exact input identity
 * fences thread/run/root/attempt/instance, and survives native completion
 * removing activeTurns before the request's response arrives.
 */
export const makeCodexStartReceipts = (input: {
  readonly driver: ProviderDriverKind;
  readonly idAllocator: IdAllocatorV2Shape;
}) => {
  const rootStartReceipts = new Map<
    ProviderAdapterV2TurnInput,
    OrchestrationV2ProviderTurn | undefined
  >();
  return {
    /** This records only a possibly offered request, never a native cursor or receipt. */
    offered: (turnInput: ProviderAdapterV2TurnInput): OrchestrationV2ProviderTurn => ({
      id: input.idAllocator.derive.providerTurn({
        driver: input.driver,
        nativeTurnId: `offered:${turnInput.attemptId}`,
      }),
      providerThreadId: turnInput.providerThread.id,
      nodeId: turnInput.rootNodeId,
      runAttemptId: turnInput.attemptId,
      nativeTurnRef: null,
      ordinal: turnInput.providerTurnOrdinal,
      status: "pending",
      nativeAcceptance: "unknown",
      startedAt: null,
      completedAt: null,
    }),
    begin: (turnInput: ProviderAdapterV2TurnInput): void => {
      rootStartReceipts.set(turnInput, undefined);
    },
    observe: (turnInput: ProviderAdapterV2TurnInput, providerTurn: OrchestrationV2ProviderTurn) => {
      if (rootStartReceipts.has(turnInput)) {
        rootStartReceipts.set(turnInput, providerTurn);
      }
    },
    /** A failed start reports the native receipt, or the offered turn with its acceptance. */
    settle:
      (turnInput: ProviderAdapterV2TurnInput, offered: () => OrchestrationV2ProviderTurn) =>
      <A, E, R>(request: Effect.Effect<A, E, R>) =>
        request.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterTurnStartError({
                driver: input.driver,
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                runId: turnInput.runId,
                providerTurn: rootStartReceipts.get(turnInput) ?? {
                  ...offered(),
                  nativeAcceptance:
                    isCodexRequestError(cause) && isPreAcceptanceRejectionCode(cause.code)
                      ? "pending"
                      : "unknown",
                },
                cause,
              }),
          ),
          Effect.ensuring(Effect.sync(() => rootStartReceipts.delete(turnInput))),
        ),
  };
};

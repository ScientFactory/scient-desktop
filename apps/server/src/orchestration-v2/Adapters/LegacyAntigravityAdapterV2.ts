import {
  ProviderDriverKind,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type AntigravitySettings,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { makeAgySession } from "../../provider/antigravity/AgySession.ts";
import type { ServerConfig } from "../../config.ts";
import { ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS } from "../../provider/antigravity/WorkspaceInstructions.ts";
import { AcpProviderCapabilitiesV2 } from "./AcpAdapterV2.ts";
import {
  makeNativeSessionAdapterV2,
  nativeSessionFailure,
  NativeSessionOperationError,
  type NativeSession,
  type NativeSessionAdapterV2Options,
} from "./NativeSessionAdapterV2.ts";

export interface LegacyAntigravityAdapterV2Options extends Pick<
  NativeSessionAdapterV2Options,
  "instanceId" | "idAllocator" | "continuations"
> {
  readonly settings: AntigravitySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly serverConfig: ServerConfig["Service"];
}

export function makeLegacyAntigravityAdapterV2(options: LegacyAntigravityAdapterV2Options) {
  const scopes = new Set<Scope.Scope>();
  const adapter = makeNativeSessionAdapterV2({
    ...options,
    // Legacy agy has no host MCP transport; modern Antigravity uses the ACP bridge.
    mcpSessionInjection: false,
    defaultCwd: options.serverConfig.cwd,
    driver: ProviderDriverKind.make("antigravity"),
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
      checkpointing: {
        ...AcpProviderCapabilitiesV2.checkpointing,
        providerCanRollbackConversation: false,
      },
      approvals: {
        ...AcpProviderCapabilitiesV2.approvals,
        supportsCommandApproval: false,
        supportsFileChangeApproval: false,
        supportsFileReadApproval: false,
        supportsApplyPatchApproval: false,
      },
      streaming: { ...AcpProviderCapabilitiesV2.streaming, streamsReasoning: false },
      planning: {
        ...AcpProviderCapabilitiesV2.planning,
        emitsPlanUpdated: false,
        emitsTodoList: false,
        supportsStructuredQuestions: false,
      },
    },
    open: (input, onUpdate) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        scopes.add(scope);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            scopes.delete(scope);
          }),
        );
        const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
        let conversationId = input.initialNativeThreadId;
        const effort = getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort");
        const launch = (nativeId: string | undefined) =>
          makeAgySession({
            binaryPath: options.settings.binaryPath || "agy",
            cwd,
            environment: options.environment,
            runtimeMode: input.runtimePolicy.runtimeMode,
            ...(input.modelSelection.model === "default"
              ? {}
              : { model: input.modelSelection.model }),
            ...(effort === undefined ? {} : { effort }),
            ...(nativeId === undefined ? {} : { conversationId: nativeId }),
            addDirs: [options.serverConfig.attachmentsDir],
            onUnexpectedExit: (error) =>
              onUpdate({ type: "terminal", status: "failed", detail: error.detail, broken: true }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner),
            Effect.provideService(Scope.Scope, scope),
          );
        let session = yield* launch(conversationId);
        yield* Effect.addFinalizer(() => session.close);
        const native: NativeSession = {
          nativeId: conversationId ?? `${input.threadId}:agy:${input.providerSessionId}`,
          nativeThreadKnown: conversationId !== undefined,
          interruptBreaksSession: true,
          send: (turnInput) =>
            Effect.gen(function* () {
              const attachmentLines: string[] = [];
              for (const attachment of turnInput.message.attachments) {
                const attachmentPath = resolveAttachmentPath({
                  attachmentsDir: options.serverConfig.attachmentsDir,
                  attachment,
                });
                if (attachmentPath === null)
                  return yield* new NativeSessionOperationError({
                    detail: "Invalid Antigravity attachment path.",
                  });
                const root = yield* options.fileSystem.realPath(
                  options.serverConfig.attachmentsDir,
                );
                const real = yield* options.fileSystem.realPath(attachmentPath);
                const relative = options.path.relative(root, real);
                const info = yield* options.fileSystem.stat(real);
                if (
                  options.path.isAbsolute(relative) ||
                  relative === ".." ||
                  relative.startsWith(`..${options.path.sep}`) ||
                  info.type !== "File" ||
                  Number(info.size) >
                    (attachment.type === "image"
                      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
                      : PROVIDER_SEND_TURN_MAX_FILE_BYTES)
                )
                  return yield* new NativeSessionOperationError({
                    detail:
                      "Antigravity attachment escaped its directory or exceeded its size limit.",
                  });
                attachmentLines.push(`[Attachment saved at ${real}]`);
              }
              const text = `${turnInput.message.text}\n\n${ANTIGRAVITY_WORKSPACE_TOOL_INSTRUCTIONS}\n${attachmentLines.join("\n")}`;
              yield* session
                .prompt({
                  text,
                  onEvent: (event) => {
                    switch (event._tag) {
                      case "AssistantText":
                        return onUpdate({ type: "text", id: "assistant", delta: event.text });
                      case "ToolCall":
                        return onUpdate({
                          type: "tool",
                          id: event.id,
                          name: event.name,
                          status: "running",
                          input: event.input,
                        });
                      case "ToolCallUpdate":
                        return onUpdate({
                          type: "tool",
                          id: event.id,
                          name: event.name,
                          status: event.status,
                          ...(event.output === undefined
                            ? {}
                            : {
                                output:
                                  typeof event.output === "string"
                                    ? event.output
                                    : JSON.stringify(event.output),
                              }),
                        });
                    }
                  },
                })
                .pipe(
                  Effect.flatMap((result) =>
                    Effect.gen(function* () {
                      conversationId = result.conversationId;
                      yield* onUpdate({ type: "native-thread", id: result.conversationId });
                      yield* onUpdate({
                        type: "terminal",
                        status:
                          result.status === "success"
                            ? "completed"
                            : result.status === "cancelled"
                              ? "cancelled"
                              : "failed",
                        ...(result.error === undefined ? {} : { detail: result.error }),
                        broken: result.status === "cancelled",
                      });
                    }),
                  ),
                  Effect.catch((cause) =>
                    onUpdate({
                      type: "terminal",
                      status: "failed",
                      detail: cause.detail,
                      broken: true,
                    }),
                  ),
                  Effect.forkIn(scope),
                );
            }).pipe(Effect.mapError(nativeSessionFailure)),
          interrupt: Effect.suspend(() => session.cancel).pipe(
            Effect.mapError(nativeSessionFailure),
          ),
          respond: () =>
            Effect.fail(
              new NativeSessionOperationError({
                detail: "Legacy Antigravity does not expose approval callbacks in headless mode.",
              }),
            ),
          resume: (nativeId) =>
            Effect.gen(function* () {
              if (nativeId === conversationId) return;
              yield* session.close;
              session = yield* launch(nativeId);
              conversationId = nativeId;
            }).pipe(Effect.mapError(nativeSessionFailure)),
        };
        return native;
      }).pipe(Effect.mapError(nativeSessionFailure)),
  });
  return {
    ...adapter,
    stopAll: () =>
      Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true }),
  };
}

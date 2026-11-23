import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
  // SCIENT-FORK: plugin sign-in failures are safe to show.
  PluginSignInError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import { parseSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import {
  antigravityAppendsSystemPrompt,
  antigravityPermissionDisposition,
  antigravityPermissionMode,
  antigravityRuntimeModeForSessionMode,
  antigravitySteersWithPrompt,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
  readAntigravityChildrenAtWork,
  readAntigravityPendingReply,
} from "../../provider/acp/AntigravityChildWork.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import { watchAntigravityPromptOutcome } from "../../provider/acp/AntigravityTurnOutcome.ts";
import {
  antigravityApprovalOptions,
  antigravityToolOutlivesPrompt,
  antigravityCommandOutlivesPrompt,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityReadRepair,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
// SCIENT-FORK:START Scient ACP application bridge
import { scientAntigravityBridge } from "./ScientAcpApplicationBridge.ts";
// SCIENT-FORK:END Scient ACP application bridge
// SCIENT-FORK:START — plugin sign-in challenges from tool results.
import { makeAntigravityPluginSignIns } from "../../scient/antigravity/pluginSignIn.ts";
import { verifyPluginSignIn } from "../../scient/antigravity/pluginAuthManifest.ts";
// SCIENT-FORK:END
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** Thread variables reach the driver here; `makeAntigravityAcpRuntime` never reads them. */
export type AntigravityAdapterV2RuntimeInput = Omit<
  AntigravityAcpRuntimeInput,
  "spawn" | "childProcessSpawner"
> & { readonly processEnvironment?: NodeJS.ProcessEnv };

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: AntigravityAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly supportsNativeGoals?: Effect.Effect<boolean>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The agent's GEMINI_HOME. Its session logs show turns that ended on an upstream error. */
  readonly profileDirectory?: string;
  // SCIENT-FORK:START — where `agy` installs plugins; their manifests vouch for sign-ins.
  /** Defaults to `~/.gemini/config/plugins`; without plugins no sign-in notice is offered. */
  readonly pluginsDirectory?: string;
  // SCIENT-FORK:END
}

/**
 * Native subagent tools report no child session ids, so children stay read-only.
 * Only permission prompts carry the launch; NativeChildWorkQuery matches their ids by this text.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "failed" ? "failed" : toolCall.status === "pending" ? "pending" : "running";
  const launches = antigravitySubagentLaunches(toolCall.data.rawInput);
  const launch = launches === undefined ? undefined : describeAntigravitySubagentLaunches(launches);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      launch?.prompt ??
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    title: launch?.title ?? ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    model: null,
    status,
    childSessionId: null,
    result: status === "failed" ? (antigravitySubagentOutput(toolCall) ?? null) : null,
  };
};

interface AntigravityFlavorServices {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory, pluginsDirectory } = options;
  // SCIENT-FORK:START — daemon commands tracked as background work. A later update can carry only
  // the tool ID and status, so a tracked daemon is known by its ID until it ends.
  const daemonToolCallIds = new Set<string>();
  type ToolCall = Parameters<NonNullable<AcpAdapterV2Flavor["extractBackgroundTaskId"]>>[0];
  const isDaemonCommand = (toolCall: ToolCall) =>
    daemonToolCallIds.has(toolCall.toolCallId) ||
    (toolCall.kind === "execute" && !antigravityToolOutlivesPrompt(toolCall));
  // SCIENT-FORK:END
  // SCIENT-FORK:START — only sessions that offer agy's native Auto defer to its review. Scient's
  // managed 1.4.5 harness offers none: it runs Auto as `default`, answered by Scient's policy.
  const nativeAutoSessionIds = new Set<string>();
  // SCIENT-FORK:END
  // SCIENT-FORK:START — sign-in challenges a plugin's tool result printed, by agent process.
  const pluginSignIns = makeAntigravityPluginSignIns();
  // SCIENT-FORK:END
  const antigravityClientFileRoots = (cwd: string | null) =>
    cwd === null ? [options.host.paths.attachmentsDir] : [cwd, options.host.paths.attachmentsDir];
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const scope = yield* Scope.fork(yield* Effect.scope);
      // SCIENT-FORK:START — a challenge's loopback listener lives in this process.
      const generation = pluginSignIns.openGeneration();
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => pluginSignIns.closeGeneration(generation)),
      );
      // SCIENT-FORK:END
      const platform = yield* HostProcess.Platform;
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void).pipe(
            // Closing the reader's scope can interrupt its EOF notification.
            // Retire this runtime generation explicitly so the next turn respawns.
            Effect.ensuring(
              Effect.suspend(
                () =>
                  input.onTermination?.(
                    new EffectAcpErrors.AcpTransportError({
                      detail: "The Antigravity process stopped for account setup.",
                      cause: "Antigravity auth owner closed the process scope",
                    }),
                  ) ?? Effect.void,
              ),
            ),
          ),
          options.makeRuntime({
            ...input,
            clientFileReads: true,
            ownDetachedProcessGroup: true,
            ownDescendantProcessGroups: platform === "linux",
            processGroupPlatform: platform,
            sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS,
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      // SCIENT-FORK:START — text held while it could begin a sign-in link goes out at prompt end.
      const releaseHeldText = Effect.suspend(() =>
        projectUpdate === undefined
          ? Effect.void
          : updates.withPermit(
              Effect.forEach(pluginSignIns.flush(generation), projectUpdate, { discard: true }),
            ),
      ).pipe(Effect.ignore);
      // SCIENT-FORK:END
      return {
        ...runtime,
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            handler(request, context).pipe(
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                if (served === undefined || projectUpdate === undefined) return Effect.void;
                return updates
                  .withPermit(
                    projectUpdate({
                      sessionId: served.sessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: served.toolCallId,
                        status: "completed",
                      },
                    }),
                  )
                  .pipe(Effect.ignore);
              }),
            ),
          ),
        prompt: (payload, promptOptions) =>
          Effect.sync(reads.reset).pipe(
            Effect.andThen(runtime.prompt(payload, promptOptions)),
            // SCIENT-FORK: see releaseHeldText.
            Effect.ensuring(releaseHeldText),
          ),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((notification) =>
            updates.withPermit(
              // SCIENT-FORK:START — challenges are kept and scrubbed before anything projects them.
              Effect.gen(function* () {
                const { notifications, candidate } = pluginSignIns.observe({
                  generation,
                  notification: reads.repair(notification),
                });
                // Only the installed plugin's own CLI and OAuth client earn a sign-in notice.
                const verified =
                  candidate === undefined || pluginsDirectory === undefined
                    ? undefined
                    : yield* verifyPluginSignIn({ pluginsDirectory, candidate }).pipe(
                        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
                        Effect.provideService(Path.Path, options.path),
                      );
                if (candidate !== undefined && verified !== undefined) {
                  pluginSignIns.admit(candidate, {
                    attemptId: yield* options.random.uuidV4(),
                    displayName: verified.displayName,
                    programs: verified.programs,
                    now: yield* Clock.currentTimeMillis,
                  });
                }
                yield* Effect.forEach(notifications, handler, { discard: true });
              }),
              // SCIENT-FORK:END
            ),
          );
        },
        start: () =>
          runtime.start().pipe(
            // SCIENT-FORK:START — see nativeAutoSessionIds.
            Effect.tap((started) =>
              Effect.sync(() => {
                if (
                  parseSessionModeState(started.sessionSetupResult)?.availableModes.some(
                    (mode) => mode.id === "auto",
                  ) === true
                ) {
                  nativeAutoSessionIds.add(started.sessionId);
                } else {
                  nativeAutoSessionIds.delete(started.sessionId);
                }
              }),
            ),
            // SCIENT-FORK:END
            Effect.tap((started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void),
          ),
      } satisfies typeof runtime;
    },
    Effect.provideService(SecureRandom.SecureRandom, options.random),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    // SCIENT-FORK:START Scient prompt and native-delivery observation mount
    // Scient's awareness rides the first prompt, as upstream's orchestration text does.
    application: scientAntigravityBridge,
    // SCIENT-FORK:END Scient prompt and native-delivery observation mount
    supportsNativeGoals: options.supportsNativeGoals ?? Effect.succeed(false),
    // Agents that advertise HTTP MCP skip the stdio bridge process; others keep stdio.
    mcpOverHttp: true,
    sessionCarriesPullRequestLinking: antigravityAppendsSystemPrompt,
    makeRuntime,
    buildAttachmentPrompt: ({
      text,
      attachments,
      resolveAttachmentPath,
      promptCapabilities,
      // SCIENT-FORK: the managed 1.4.5 runtime links MP4 video for Gemini models.
      agentVersion,
      currentModel,
    }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        resolveAttachmentPath,
        promptCapabilities,
        agentVersion,
        currentModel,
      }).pipe(
        Effect.map((blocks) => (text.trim() ? blocks.slice(1) : blocks)),
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    // Loading history replays tool calls; resume avoids replay.
    subagentsIdleOnTurnCompletion: true,
    // SCIENT-FORK: Stop ends the whole agent process group, including its commands.
    terminateRuntimeProcessGroupOnInterrupt: true,
    // A finished background command or timer wakes the agent with no prompt open: it streams a
    // reply and asks for permissions, and no prompt response ever ends that reply.
    enablePostSettleContinuation: true,
    deferFinalizeForBackgroundWork: true,
    wakeOnDetachedRequest: true,
    replyEndsWithUsageUpdate: true,
    toolOutlivesPrompt: antigravityToolOutlivesPrompt,
    // SCIENT-FORK:START — a daemon (a dev server) never reports its end, so it does not hold the
    // turn; tracking it as background work keeps its row running and gives Stop its process.
    extractBackgroundTaskId: (toolCall) => {
      if (!isDaemonCommand(toolCall) || toolCall.status === undefined) return undefined;
      if (toolCall.status === "pending") return undefined;
      if (toolCall.status === "completed" || toolCall.status === "failed") {
        daemonToolCallIds.delete(toolCall.toolCallId);
      } else {
        daemonToolCallIds.add(toolCall.toolCallId);
      }
      return toolCall.toolCallId;
    },
    isPersistentBackgroundTool: isDaemonCommand,
    // SCIENT-FORK:END
    // agy sometimes loses the terminal update or wake for a background command, which would
    // hold the turn in Working forever. 30 minutes still leaves long commands room.
    postSettleCommandHold: {
      timeout: "30 minutes",
      isCommand: antigravityCommandOutlivesPrompt,
    },
    // session/cancel ends the agent's running commands, so only Stop sends it once the prompt
    // has ended. A message sent while a command runs leaves the command alone.
    preserveRuntimeOnSettledInterrupt: true,
    // `agy acp` reads a prompt sent mid-turn as a steer; cancel-and-restart killed its subagents.
    steersWithPrompt: antigravitySteersWithPrompt,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model:
          modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
        defaultModel,
        mapError: (cause) => cause,
      });
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    runtimeModeForSessionMode: antigravityRuntimeModeForSessionMode,
    clientFileSystem: {
      readTextFile: (request, cwd) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: antigravityClientFileRoots(cwd),
          request,
        }),
    },
    // SCIENT-FORK: see nativeAutoSessionIds.
    permissionDisposition: (policy, request) =>
      nativeAutoSessionIds.has(request.sessionId)
        ? antigravityPermissionDisposition(policy, request)
        : acpPermissionDisposition(policy, request),
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    // SCIENT-FORK:START — plugin sign-in notices and the pages they open.
    scientToolNotice: (sessionId, toolCallId, owner) =>
      pluginSignIns.takeToolNotice(sessionId, toolCallId, owner),
    scientPluginSignIn: {
      open: Effect.fn("AntigravityAdapterV2.pluginSignIn.open")(function* (input) {
        const redeemed = pluginSignIns.redeem({
          attemptId: input.attemptId,
          owner: input.owner,
          nativeSessionId: input.nativeSessionId ?? undefined,
          now: yield* Clock.currentTimeMillis,
        });
        if ("url" in redeemed) return { authorizationUrl: redeemed.url };
        return yield* new PluginSignInError({
          reason: "expired",
          detail: "This sign-in has ended. Ask the agent to try again.",
        });
      }),
    },
    // SCIENT-FORK:END
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    compactViaAdvertisedCommand: true,
    requiresSignIn: isAntigravitySignInRequiredError,
    checksVersionAtHandshake: true,
    // Antigravity can leave a prompt open without updates; long tools and approvals pause this.
    promptInactivityTimeout: "15 minutes",
    reportsPerTurnPromptUsage: true,
    geminiPromptUsage: true,
    ...(profileDirectory === undefined
      ? {}
      : {
          // SCIENT-FORK: the session's delivered connectors say whose tool server failed.
          watchPromptOutcome: (sessionId: string, delivery) =>
            watchAntigravityPromptOutcome(profileDirectory, sessionId, delivery),
          subagentsOutlivingPrompt: ({ sessionId, nativeTaskIds }) =>
            readAntigravityChildrenAtWork({
              profileDirectory,
              rootSessionId: sessionId,
              toolCallIds: nativeTaskIds,
            }),
          hasPendingReply: (sessionId: string) =>
            readAntigravityPendingReply({
              profileDirectory,
              sessionId,
            }),
        }),
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    random: yield* SecureRandom.SecureRandom,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  // SCIENT-FORK:START — the agy CLI loads plugins from the OS user's home, not GEMINI_HOME.
  const pluginsDirectory =
    options.pluginsDirectory ??
    services.path.join(yield* HostProcess.HomeDirectory, ".gemini", "config", "plugins");
  // SCIENT-FORK:END
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services, pluginsDirectory }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

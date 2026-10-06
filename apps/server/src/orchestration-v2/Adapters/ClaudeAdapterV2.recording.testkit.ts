import {
  ProviderReplayEntry,
  type ModelSelection,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { randomUuidV4 } from "../RandomUuid.ts";
import {
  ClaudeAgentSdkReplayTranscript,
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
} from "./ClaudeAdapterV2.replay-protocol.testkit.ts";
import {
  recordClaudeStreamingQuery,
  recordClaudeActiveSteeringQuery,
  recordClaudeRestartingQueries,
  recordClaudeResumeAtCursorQuery,
} from "./ClaudeAdapterV2.recording-turns.testkit.ts";
import { recordClaudeForkSessionQuery } from "./ClaudeAdapterV2.recording-fork.testkit.ts";
import {
  recordClaudeInterruptQuery,
  recordClaudeInterruptRestartQuery,
} from "./ClaudeAdapterV2.recording-interrupt.testkit.ts";

export async function recordClaudeAgentSdkReplayTranscript(input: {
  readonly scenario: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly queryMode?:
    | "streaming"
    | "restart"
    | "resume_at_cursor"
    | "fork_session"
    | "fork_session_prior_turn"
    | "fork_session_continue"
    | "fork_session_siblings"
    | "fork_session_merge_back"
    | "fork_session_merge_back_siblings"
    | "active_steering"
    | "interrupt"
    | "interrupt_restart";
  readonly enableTools?: boolean;
  readonly tools?: ClaudeAdapterV2.ClaudeAgentSdkQueryTools;
  readonly permissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly enablePermissionCallback?: boolean;
  readonly permissionDecision?: ProviderApprovalDecision;
  readonly backgroundWakeCounts?: ReadonlyArray<number>;
  readonly offerNextPromptImmediately?: boolean;
  readonly interruptAfter?: "prompt_offer" | "tool_use";
  readonly interruptAfterToolUses?: number;
}): Promise<ClaudeAgentSdkReplayTranscript> {
  if (input.prompts.length === 0) {
    throw new Error(
      `Claude Agent SDK replay scenario ${input.scenario} needs at least one prompt.`,
    );
  }

  const entries: Array<ProviderReplayEntry> = [];
  const sessionId = input.sessionId ?? (await Effect.runPromise(randomUuidV4));
  const queryMode = input.queryMode ?? "streaming";
  const recordingMetadata: Record<string, unknown> = {};
  if (queryMode === "streaming") {
    await recordClaudeStreamingQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.backgroundWakeCounts === undefined
        ? {}
        : { backgroundWakeCounts: input.backgroundWakeCounts }),
      ...(input.offerNextPromptImmediately === undefined
        ? {}
        : { offerNextPromptImmediately: input.offerNextPromptImmediately }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
    });
  } else if (queryMode === "active_steering") {
    await recordClaudeActiveSteeringQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
    });
  } else if (queryMode === "restart") {
    await recordClaudeRestartingQueries({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (queryMode === "resume_at_cursor") {
    await recordClaudeResumeAtCursorQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      metadata: recordingMetadata,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (
    queryMode === "fork_session" ||
    queryMode === "fork_session_prior_turn" ||
    queryMode === "fork_session_continue" ||
    queryMode === "fork_session_siblings" ||
    queryMode === "fork_session_merge_back" ||
    queryMode === "fork_session_merge_back_siblings"
  ) {
    await recordClaudeForkSessionQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      metadata: recordingMetadata,
      ...(queryMode === "fork_session_prior_turn" ? { forkFromPromptIndex: 1 as const } : {}),
      ...(queryMode === "fork_session_continue" ? { sourcePromptCount: 1 } : {}),
      ...(queryMode === "fork_session_siblings"
        ? {
            sourcePromptCount: 1,
            forkPromptGroups: [[input.prompts[1]!], [input.prompts[2]!]],
          }
        : {}),
      ...(queryMode === "fork_session_merge_back"
        ? {
            sourcePromptCount: 1,
            forkPromptGroups: [[input.prompts[1]!]],
            sourceContinuationPromptCount: 2,
          }
        : {}),
      ...(queryMode === "fork_session_merge_back_siblings"
        ? {
            sourcePromptCount: 1,
            forkPromptGroups: [[input.prompts[1]!], [input.prompts[2]!]],
            sourceContinuationPromptCount: 3,
          }
        : {}),
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
    });
  } else if (queryMode === "interrupt") {
    await recordClaudeInterruptQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
      ...(input.interruptAfterToolUses === undefined
        ? {}
        : { interruptAfterToolUses: input.interruptAfterToolUses }),
    });
  } else {
    await recordClaudeInterruptRestartQuery({
      scenario: input.scenario,
      prompts: input.prompts,
      modelSelection: input.modelSelection,
      cwd: input.cwd,
      sessionId,
      entries,
      ...(input.enableTools === undefined ? {} : { enableTools: input.enableTools }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions }),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
    });
  }

  return {
    provider: ClaudeAdapterV2.CLAUDE_PROVIDER,
    protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
    version: "0.2.111",
    scenario: input.scenario,
    metadata: {
      prompts: [...input.prompts],
      model: input.modelSelection.model,
      nativeSessionId: sessionId,
      queryMode,
      tools: input.enableTools === true ? (input.tools ?? "claude_code") : "none",
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
      ...(input.disallowedTools === undefined ? {} : { disallowedTools: input.disallowedTools }),
      ...(input.enablePermissionCallback === undefined
        ? {}
        : { enablePermissionCallback: input.enablePermissionCallback }),
      ...(input.permissionDecision === undefined
        ? {}
        : { permissionDecision: input.permissionDecision }),
      ...(input.backgroundWakeCounts === undefined
        ? {}
        : { backgroundWakeCounts: [...input.backgroundWakeCounts] }),
      ...(input.offerNextPromptImmediately === true ? { offerNextPromptImmediately: true } : {}),
      ...(input.interruptAfter === undefined ? {} : { interruptAfter: input.interruptAfter }),
      ...(input.interruptAfterToolUses === undefined
        ? {}
        : { interruptAfterToolUses: input.interruptAfterToolUses }),
      generatedBy: "recordClaudeAgentSdkReplayTranscript",
      ...recordingMetadata,
    },
    entries,
  };
}

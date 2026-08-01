/**
 * Read/coordination MCP tools for the Scient agent gateway.
 *
 * Serves the read surface an agent uses to observe sibling threads in its own
 * project: `scient_context`, `scient_list_projects`, `scient_list_threads`,
 * `scient_read_thread`, and `scient_wait_for_threads`. Every tool that names a
 * target thread funnels through the central {@link authorizeThreadRead} policy;
 * cross-project observation is denied. All tools are read-only and none require
 * an active turn.
 *
 * `scient_wait_for_threads` is poll-based over the shell snapshot: it pins each
 * thread to a run id and long-polls until every pinned turn is terminal or the
 * deadline elapses. A pinned turn that is no longer the thread's latest turn is
 * reported as best-effort `completed` (the shell alone cannot distinguish the
 * terminal state of a superseded turn).
 *
 * @module agentGateway/threadReadTools
 */
import { ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { authorizeThreadRead } from "./authorization.ts";
import { SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION } from "./contract.ts";
import { SYNARA_HARNESS_POLICY_VERSION } from "./harnessPolicy.ts";
import { mcpToolResultJson } from "./protocol.ts";
import {
  summarizeThreadDetail,
  toAgentSafeThreadError,
  summarizeThreadShell,
  summarizeWaitThreadText,
  WAIT_THREAD_SUMMARY_MAX_CHARS,
} from "./threadSummary.ts";
import {
  decodeWaitForThreadsInput,
  readBooleanArg,
  readNumberArg,
  readStringArg,
  ToolInputError,
} from "./toolInput.ts";
import {
  gatewayToolFailureResult,
  gatewayToolErrorResult,
  GatewayToolError,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
  unexpectedGatewayToolError,
} from "./toolRuntime.ts";

const LIST_THREADS_DEFAULT_LIMIT = 50;
const LIST_THREADS_MAX_LIMIT = 200;
type WaitThreadState = "idle" | "pending" | "running" | "completed" | "error" | "interrupted";

export interface ThreadReadToolsInput {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
}

export function makeThreadReadTools(input: ThreadReadToolsInput): ReadonlyArray<ToolEntry> {
  const { snapshotQuery, requireThreadShell } = input;

  const contextTool: ToolEntry = {
    operation: "project.context.read",
    decodeInput: () => ({}),
    definition: {
      name: "scient_context",
      description:
        "Inspect the current Scient harness identity, caller thread/turn, and authorized coordination capabilities.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Scient context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const caller = yield* requireThreadShell(context.callerThreadId);
        const turnId = caller.latestTurn?.state === "running" ? caller.latestTurn.turnId : null;
        return mcpToolResultJson({
          harness: { name: "Scient", policyVersion: SYNARA_HARNESS_POLICY_VERSION },
          caller: {
            threadId: caller.id,
            turnId,
            provider: context.callerProvider,
            projectId: caller.projectId,
          },
          capabilities: {
            threadRead: context.operationAuthority.capabilities.includes("thread:read"),
            // Drive (scient_send_message / scient_interrupt_thread) needs the
            // write capability and is only usable while the caller's own turn is
            // active, so it is reported false without a live turn.
            threadDrive:
              turnId !== null && context.operationAuthority.capabilities.includes("thread:drive"),
            threadWait: context.operationAuthority.capabilities.includes("thread:read"),
            automations:
              turnId !== null && context.operationAuthority.capabilities.includes("automation:run"),
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error)))),
  };

  const listProjects: ToolEntry = {
    operation: "project.list",
    decodeInput: () => ({}),
    definition: {
      name: "scient_list_projects",
      description:
        "List the Scient project you belong to (id, title, workspace root). Cross-project observation is not permitted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List Scient projects", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      snapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          mcpToolResultJson({
            projects: snapshot.projects
              .filter((project) => project.id === context.callerProjectId)
              .map((project) => ({
                projectId: project.id,
                title: project.title,
                workspaceRoot: project.workspaceRoot,
                isPinned: project.isPinned,
              })),
          }),
        ),
        Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error))),
      ),
  };

  const listThreads: ToolEntry = {
    operation: "thread.list",
    decodeInput: (args) => ({
      ...(readStringArg(args, "parentThreadId") === undefined
        ? {}
        : { parentThreadId: readStringArg(args, "parentThreadId") }),
      includeArchived: readBooleanArg(args, "includeArchived") ?? false,
      limit: Math.max(
        1,
        Math.min(
          readNumberArg(args, "limit") ?? LIST_THREADS_DEFAULT_LIMIT,
          LIST_THREADS_MAX_LIMIT,
        ),
      ),
    }),
    definition: {
      name: "scient_list_threads",
      description:
        "List Scient threads in your project with status (working/idle/waiting-for-approval/...), provider, model and hierarchy. Filter by parentThreadId (e.g. your own thread id). Archived threads are hidden unless includeArchived is true. Only threads in your own project are returned.",
      inputSchema: {
        type: "object",
        properties: {
          parentThreadId: {
            type: "string",
            description: "Only child threads of this thread (e.g. your own thread id).",
          },
          includeArchived: { type: "boolean", description: "Include archived threads." },
          limit: { type: "number", description: "Max results (default 50, max 200)." },
        },
        additionalProperties: false,
      },
      annotations: { title: "List Scient threads", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const parentThreadId = readStringArg(args, "parentThreadId");
        const includeArchived = readBooleanArg(args, "includeArchived") ?? false;
        const limit = Math.max(
          1,
          Math.min(
            readNumberArg(args, "limit") ?? LIST_THREADS_DEFAULT_LIMIT,
            LIST_THREADS_MAX_LIMIT,
          ),
        );
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(
            Effect.mapError((error) =>
              unexpectedGatewayToolError(error, { operation: "list_threads_snapshot" }),
            ),
          );
        // Project scope is enforced here, not accepted as an argument: an agent
        // can only ever enumerate threads in its own project.
        const matching = snapshot.threads
          .filter((thread) => thread.projectId === context.callerProjectId)
          .filter((thread) => (parentThreadId ? thread.parentThreadId === parentThreadId : true))
          .filter((thread) => (includeArchived ? true : (thread.archivedAt ?? null) === null))
          .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        const threads = matching
          .slice(0, limit)
          .map((thread) => summarizeThreadShell(thread, context.callerThreadId));
        return mcpToolResultJson({ threads, totalMatching: matching.length });
      }).pipe(Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error)))),
  };

  const readThread: ToolEntry = {
    operation: "thread.read",
    decodeInput: (args) => ({
      threadId: readStringArg(args, "threadId", { required: true })!,
      ...(readStringArg(args, "cursor") === undefined
        ? {}
        : { cursor: readStringArg(args, "cursor") }),
      ...(readNumberArg(args, "messageLimit") === undefined
        ? {}
        : { messageLimit: readNumberArg(args, "messageLimit") }),
      ...(readNumberArg(args, "maxMessageChars") === undefined
        ? {}
        : { maxMessageChars: readNumberArg(args, "maxMessageChars") }),
    }),
    definition: {
      name: "scient_read_thread",
      description:
        "Read one Scient thread's status and recent messages (newest last, truncated). Pass the returned nextCursor as cursor to page older messages. Only threads in your own project can be read.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to read." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
          messageLimit: { type: "number", description: "Messages per page (default 20, max 100)." },
          maxMessageChars: {
            type: "number",
            description: "Per-message truncation limit (default 1500).",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read a Scient thread", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const cursor = readStringArg(args, "cursor");
        const messageLimit = readNumberArg(args, "messageLimit");
        const maxMessageChars = readNumberArg(args, "maxMessageChars");
        const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(threadId)).pipe(
          Effect.mapError((error) =>
            unexpectedGatewayToolError(error, { operation: "read_thread_detail" }),
          ),
          Effect.flatMap(
            Option.match({
              // Not-found must be byte-for-byte indistinguishable from the
              // cross-project denial below: same code, same message, same JSON
              // shape (via the GatewayToolError branch of the tail catch). A
              // plain-text ToolInputError here would leak an existence oracle —
              // a caller could tell "no such thread" from "exists elsewhere".
              onNone: () =>
                Effect.fail(
                  new GatewayToolError("thread_not_found", `Thread "${threadId}" was not found.`),
                ),
              onSome: (thread) => Effect.succeed(thread),
            }),
          ),
        );
        const decision = authorizeThreadRead({
          callerProjectId: context.callerProjectId,
          targetThreadId: threadId,
          targetProjectId: detail.projectId,
        });
        if (!decision.allow) {
          return gatewayToolErrorResult(new GatewayToolError(decision.code, decision.message));
        }
        return mcpToolResultJson(
          summarizeThreadDetail({
            thread: detail,
            callerThreadId: context.callerThreadId,
            cursor,
            messageLimit,
            maxMessageChars,
          }),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error)))),
  };

  const waitForThreads: ToolEntry = {
    operation: "thread.wait",
    decodeInput: (args) => {
      const waitInput = decodeWaitForThreadsInput(args);
      if (waitInput.runIds && waitInput.runIds.length !== waitInput.threadIds.length) {
        throw new ToolInputError('Argument "runIds" must have the same length as "threadIds".');
      }
      return {
        threadIds: [...waitInput.threadIds],
        ...(waitInput.runIds === undefined ? {} : { runIds: [...waitInput.runIds] }),
        timeoutMs: waitInput.timeoutMs ?? 30_000,
      };
    },
    definition: {
      name: "scient_wait_for_threads",
      description: `Wait for the pinned turns of 1–20 Scient threads in your project and return every outcome in input order. Assistant summaries are capped at ${WAIT_THREAD_SUMMARY_MAX_CHARS} characters; use each result's readThread call to page the full transcript. Timeouts only report progress; they never retry, replace, cancel, or create work. Only threads in your own project can be waited on.`,
      inputSchema: {
        type: "object",
        properties: {
          threadIds: {
            type: "array",
            minItems: 1,
            maxItems: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: "string" },
          },
          runIds: {
            type: "array",
            maxItems: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: ["string", "null"] },
            description: "Optional pinned turn ids from a prior wait. Must match threadIds length.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: 60_000,
            description: "Long-poll duration; defaults to 30000ms.",
          },
        },
        required: ["threadIds"],
        additionalProperties: false,
      },
      annotations: {
        title: "Wait for Scient threads",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const waitInput = decodeWaitForThreadsInput(args);
        if (waitInput.runIds && waitInput.runIds.length !== waitInput.threadIds.length) {
          throw new ToolInputError('Argument "runIds" must have the same length as "threadIds".');
        }
        const timeoutMs = waitInput.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        const pinned = yield* Effect.forEach(waitInput.threadIds, (threadId, index) =>
          snapshotQuery.getThreadShellById(threadId).pipe(
            Effect.mapError((error) =>
              unexpectedGatewayToolError(error, { operation: "wait_thread_pin" }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new GatewayToolError("thread_not_found", `Thread "${threadId}" was not found.`),
                  ),
                onSome: (thread) => {
                  const decision = authorizeThreadRead({
                    callerProjectId: context.callerProjectId,
                    targetThreadId: threadId,
                    targetProjectId: thread.projectId,
                  });
                  if (!decision.allow) {
                    return Effect.fail(new GatewayToolError(decision.code, decision.message));
                  }
                  return Effect.succeed({
                    threadId,
                    runId: waitInput.runIds?.[index] ?? thread.latestTurn?.turnId ?? null,
                  });
                },
              }),
            ),
          ),
        );

        // One shell-snapshot read per poll; index the pinned threads out of it.
        const readPinnedStates = () =>
          context.requireCurrentOperationCaller().pipe(
            Effect.flatMap(() => snapshotQuery.getShellSnapshot()),
            Effect.mapError((error) =>
              unexpectedGatewayToolError(error, { operation: "wait_threads_snapshot" }),
            ),
            Effect.flatMap((snapshot) => {
              const shellsById = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
              const missing = pinned.find((pin) => !shellsById.has(pin.threadId));
              if (missing) {
                return Effect.fail(
                  new GatewayToolError(
                    "thread_not_found",
                    `Thread "${missing.threadId}" was not found.`,
                  ),
                );
              }
              return Effect.succeed(
                pinned.map((pin) => {
                  const shell = shellsById.get(pin.threadId)!;
                  let state: WaitThreadState;
                  if (pin.runId === null) {
                    state = "idle";
                  } else if (shell.latestTurn?.turnId === pin.runId) {
                    state = shell.latestTurn.state;
                  } else {
                    // Pinned turn is no longer the thread's latest turn, so it
                    // has finished. The shell cannot distinguish completed/error
                    // for a superseded turn; report best-effort completed.
                    state = "completed";
                  }
                  const terminal =
                    state === "idle" ||
                    state === "completed" ||
                    state === "error" ||
                    state === "interrupted";
                  return {
                    threadId: pin.threadId,
                    runId: pin.runId,
                    state,
                    terminal,
                    timedOut: false,
                    summary: null as string | null,
                    summaryTruncated: false,
                    error: null as string | null,
                    readThread: {
                      tool: "scient_read_thread" as const,
                      arguments: { threadId: pin.threadId },
                    },
                  };
                }),
              );
            }),
          );

        let results = yield* readPinnedStates();
        let pollDelayMs = 200;
        while (results.some((result) => !result.terminal) && Date.now() < deadline) {
          yield* Effect.sleep(Math.min(pollDelayMs, Math.max(1, deadline - Date.now())));
          results = yield* readPinnedStates();
          pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5));
        }
        const timedOut = results.some((result) => !result.terminal);
        const finalResults = yield* Effect.forEach(results, (result) =>
          Effect.gen(function* () {
            if (!result.terminal || result.runId === null) {
              return { ...result, timedOut: !result.terminal && timedOut };
            }
            const detail = yield* snapshotQuery.getThreadDetailById(result.threadId).pipe(
              Effect.mapError((error) =>
                unexpectedGatewayToolError(error, { operation: "wait_thread_detail" }),
              ),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new GatewayToolError(
                        "thread_not_found",
                        `Thread "${result.threadId}" was not found.`,
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
            const assistantMessage = detail.messages.findLast(
              (message) => message.role === "assistant" && message.turnId === result.runId,
            );
            const summary = summarizeWaitThreadText(assistantMessage?.text);
            return {
              ...result,
              timedOut: false,
              summary: summary.summary,
              summaryTruncated: summary.truncated,
              error:
                result.state === "error"
                  ? (toAgentSafeThreadError(detail.session?.lastError) ?? "Turn failed.")
                  : null,
            };
          }),
        );
        return mcpToolResultJson({
          callerThreadId: context.callerThreadId,
          runIds: pinned.map((pin) => pin.runId),
          allTerminal: finalResults.every((result) => result.terminal),
          timedOut,
          threads: finalResults,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(gatewayToolFailureResult(error)))),
  };

  return [contextTool, listProjects, listThreads, readThread, waitForThreads];
}

// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ProviderApprovalPushHooks, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";
import { randomUuidV4 } from "./randomUuid.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;
const MAX_KEPT_TOOL_RESULTS = 64;
// A request whose call never comes back for its answer stays until the session ends.
const MAX_KEPT_APPROVAL_REQUESTS = 8;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly path: string | undefined;
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

interface KeptToolResult {
  readonly toolName: string;
  readonly inputHash: string;
  readonly outputJson: string;
  readonly output: Record<string, unknown>;
}

/** What one of T3's own MCP tools is asking the person behind a thread to approve. */
export interface T3ApprovalRequest {
  /** The whole question, as the provider's client hands it on. */
  readonly message: string;
  readonly pushHooks?: ProviderApprovalPushHooks | undefined;
  /** What an answer is given for; an answer to another state does not count for this request. */
  readonly state?: string | undefined;
}

/** A request T3 is waiting on, and what the person answered once an adapter has shown it. */
export interface KeptApprovalRequest extends T3ApprovalRequest {
  readonly id: string;
  readonly approved?: boolean | undefined;
}

interface ToolResultState {
  readonly entries: ReadonlyMap<ThreadId, ReadonlyArray<KeptToolResult>>;
  readonly epochs: ReadonlyMap<ThreadId, number>;
  // SCIENT-FORK:START — generations are unique tokens held only while their thread has one.
  readonly nextEpoch: number;
  // The thread's active provider session, kept here so a generation is issued and written only
  // while that session is open, checked in the same update.
  readonly sessions: ReadonlyMap<ThreadId, string>;
  // SCIENT-FORK:END
}

const hashText = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export const hashToolInput = (input: unknown): string => {
  const normalized = Predicate.isObject(input) && !Array.isArray(input) ? input : {};
  return hashText(stableStringify(normalized));
};

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: {
        readonly html: string;
        readonly path?: string | undefined;
        readonly title: string;
        readonly height: number;
      },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    // A reported attachment consumes that exact page; otherwise the oldest page for a path, or a
    // unique inline match.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: PageInput,
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
    // SCIENT-FORK:START — given a provider session, a generation is issued only while it is the
    // thread's active one; otherwise the token matches no write.
    readonly toolResultEpoch: (
      threadId: ThreadId,
      providerSessionId?: string,
    ) => Effect.Effect<number>;
    // SCIENT-FORK:END
    readonly recordToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      output: Record<string, unknown>,
      options?: {
        readonly providerSessionId?: string | undefined;
        readonly epoch?: number | undefined;
      },
    ) => Effect.Effect<void>;
    // A reported output consumes only an exact (tool, input, output) match; input-only recovery
    // consumes a match only when all matching candidates carry the same output.
    readonly takeToolResult: (
      threadId: ThreadId,
      toolName: string,
      input: unknown,
      reported?: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown> | undefined>;
    readonly clearToolResults: (threadId: ThreadId) => Effect.Effect<void>;
    // The provider's client hands an adapter a server name and the message. This is how the
    // adapter learns a request is T3's own, and what it names, from T3 itself: kept from when
    // T3 asks until it has the answer. Recording returns the request's own id, and only that id
    // forgets it: two calls may ask the same thing at once, and one may outlive its session.
    readonly recordApprovalRequest: (
      threadId: ThreadId,
      request: T3ApprovalRequest,
    ) => Effect.Effect<string>;
    readonly findApprovalRequest: (
      threadId: ThreadId,
      message: string,
    ) => Effect.Effect<KeptApprovalRequest | undefined>;
    readonly forgetApprovalRequest: (threadId: ThreadId, id: string) => Effect.Effect<void>;
    // An adapter that shows T3's own requests says so for its provider instance and passes on
    // each answer the person gave in the app. It is handed the message and no id, so the answer
    // counts for every request of the thread asking `message` that has none yet. For those
    // instances that answer, not the client's reply, is what T3 goes by.
    readonly showsApprovalRequests: (providerInstanceId: ProviderInstanceId) => Effect.Effect<void>;
    readonly areApprovalRequestsShown: (
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<boolean>;
    readonly answerApprovalRequests: (
      threadId: ThreadId,
      message: string,
      approved: boolean,
    ) => Effect.Effect<void>;
    // Ends the request and returns it as it was, with the person's answer if one was given.
    readonly takeApprovalRequest: (
      threadId: ThreadId,
      id: string,
    ) => Effect.Effect<KeptApprovalRequest | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

interface PageInput {
  readonly html?: unknown;
  readonly path?: unknown;
  readonly title?: unknown;
  readonly height?: unknown;
}

const matchingPageIndex = (kept: ReadonlyArray<KeptHtmlRender>, input: PageInput): number => {
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const sameFrame = (page: KeptHtmlRender) => page.title === input.title && page.height === height;
  const path = input.path;
  // The handler refuses a call with both sources, so it published nothing to recover. Its decoder
  // reads null as an omitted source.
  if (path !== undefined && path !== null && input.html !== undefined && input.html !== null) {
    return -1;
  }
  if (typeof path === "string" && path.length > 0) {
    // An edited file is published again under the same path; completions arrive in publish order.
    return kept.findIndex((page) => page.path === path && sameFrame(page));
  }
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  const htmlHash = hashText(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.path === undefined &&
    sameFrame(page) &&
    (page.htmlHash === htmlHash ||
      (tail !== undefined &&
        tail.length > 0 &&
        tail.length < page.htmlLength &&
        page.htmlEnd.endsWith(tail)))
      ? [index]
      : [],
  );
  // Identical pages are interchangeable, so repeats are taken in publish order.
  if (matches.length > 1 && matches.every((index) => kept[index]!.htmlHash === htmlHash)) {
    return matches[0]!;
  }
  return matches.length === 1 ? matches[0]! : -1;
};

// SCIENT-FORK:START Scient Extensions connectors
/** Callers hold `ReadonlySet`/`ReadonlyArray` views only at compile time; never share the backing objects. */
const copyConfig = (config: McpProviderSessionConfig): McpProviderSessionConfig => ({
  ...config,
  capabilities: new Set(config.capabilities),
  connectors: config.connectors.map((connector) => ({ ...connector })),
});
// SCIENT-FORK:END

const matchingToolResultIndex = (
  kept: ReadonlyArray<KeptToolResult>,
  toolName: string,
  input: unknown,
  reported?: Record<string, unknown>,
): number => {
  const inputHash = hashToolInput(input);
  if (reported !== undefined) {
    const reportedJson = stableStringify(reported);
    return kept.findIndex(
      (entry) =>
        entry.toolName === toolName &&
        entry.inputHash === inputHash &&
        entry.outputJson === reportedJson,
    );
  }
  const matches = kept.flatMap((entry, index) =>
    entry.toolName === toolName && entry.inputHash === inputHash ? [index] : [],
  );
  if (matches.length === 0) return -1;
  if (matches.length === 1) return matches[0]!;
  // Identical outputs (e.g. repeated send_to_user calls) are interchangeable; differing outputs
  // (e.g. parallel identical-input delegate_task calls) stay unclaimed to avoid misattribution.
  const firstOutput = kept[matches[0]!]!.outputJson;
  return matches.every((index) => kept[index]!.outputJson === firstOutput) ? matches[0]! : -1;
};

const clearThreadToolResults = (state: ToolResultState, threadId: ThreadId): ToolResultState => {
  // SCIENT-FORK:START — clearing drops the thread's generation: no later token equals it, so a
  // late write is refused and a closed thread leaves nothing behind.
  if (!state.entries.has(threadId) && !state.epochs.has(threadId)) return state;
  const entries = new Map(state.entries);
  entries.delete(threadId);
  const epochs = new Map(state.epochs);
  epochs.delete(threadId);
  return { ...state, entries, epochs };
  // SCIENT-FORK:END
};

// SCIENT-FORK:START — a generation is issued and written only while its session is open.
const REFUSED_EPOCH = 0;
const openThreadToolResults = (
  state: ToolResultState,
  threadId: ThreadId,
  providerSessionId: string,
): ToolResultState =>
  state.sessions.get(threadId) === providerSessionId
    ? state
    : {
        ...clearThreadToolResults(state, threadId),
        sessions: new Map(state.sessions).set(threadId, providerSessionId),
      };
const closeThreadToolResults = (state: ToolResultState, threadId: ThreadId): ToolResultState => {
  const cleared = clearThreadToolResults(state, threadId);
  if (!cleared.sessions.has(threadId)) return cleared;
  const sessions = new Map(cleared.sessions);
  sessions.delete(threadId);
  return { ...cleared, sessions };
};
// SCIENT-FORK:END

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const toolResultState = yield* Ref.make<ToolResultState>({
    entries: new Map(),
    epochs: new Map(),
    // SCIENT-FORK:START — generations are unique tokens held only while their thread has one.
    // Tokens start at 1, so a thread without one never matches a handed-out token.
    nextEpoch: 1,
    sessions: new Map(),
    // SCIENT-FORK:END
  });
  const approvalRequests = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptApprovalRequest>>());
  const approvalRequestsShownBy = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());
  const withoutThread = <A>(kept: ReadonlyMap<ThreadId, A>, threadId: ThreadId) => {
    const next = new Map(kept);
    next.delete(threadId);
    return next;
  };
  const takeApprovalRequest = (threadId: ThreadId, id: string) =>
    Ref.modify(approvalRequests, (current) => {
      const kept = current.get(threadId);
      const taken = kept?.find((candidate) => candidate.id === id);
      if (kept === undefined || taken === undefined) return [undefined, current];
      const rest = kept.filter((candidate) => candidate !== taken);
      return [
        taken,
        rest.length === 0 ? withoutThread(current, threadId) : new Map(current).set(threadId, rest),
      ];
    });
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
        yield* Ref.update(toolResultState, (state) =>
          clearThreadToolResults(state, config.threadId),
        );
        yield* Ref.update(approvalRequests, (kept) => withoutThread(kept, config.threadId));
      }
      // SCIENT-FORK:START Scient Extensions connectors
      yield* Ref.update(sessions, (current) =>
        new Map(current).set(config.threadId, copyConfig(config)),
      );
      // SCIENT-FORK:END
      // SCIENT-FORK:START — a generation is issued and written only while its session is open.
      yield* Ref.update(toolResultState, (state) =>
        openThreadToolResults(state, config.threadId, config.providerSessionId),
      );
      // SCIENT-FORK:END
    }),
    read: Effect.fn("McpProviderSessions.read")(function (threadId) {
      return Ref.get(sessions).pipe(
        Effect.map((current) => {
          const config = current.get(threadId);
          // SCIENT-FORK:START Scient Extensions connectors
          return config ? copyConfig(config) : undefined;
          // SCIENT-FORK:END
        }),
      );
    }),
    clear: Effect.fn("McpProviderSessions.clear")(function (threadId) {
      return Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(htmlRenders, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
        // SCIENT-FORK:START — a generation is issued and written only while its session is open.
        Effect.andThen(
          Ref.update(toolResultState, (state) => closeThreadToolResults(state, threadId)),
        ),
        // SCIENT-FORK:END
        Effect.andThen(Ref.update(approvalRequests, (kept) => withoutThread(kept, threadId))),
      );
    }),
    recordHtmlRender: Effect.fn("McpProviderSessions.recordHtmlRender")(
      function (threadId, input, reference) {
        return Ref.update(htmlRenders, (current) =>
          new Map(current).set(
            threadId,
            [
              ...(current.get(threadId) ?? []),
              {
                path: input.path,
                title: input.title,
                height: input.height,
                htmlLength: input.html.length,
                htmlHash: hashText(input.html),
                // Copy the tail so its backing storage cannot retain the entire HTML string.
                htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                  "utf16le",
                ),
                reference,
              },
            ].slice(-MAX_KEPT_HTML_RENDERS),
          ),
        );
      },
    ),
    takeHtmlRender: Effect.fn("McpProviderSessions.takeHtmlRender")(
      function (threadId, input, reported) {
        return Ref.modify(htmlRenders, (current) => {
          const kept = current.get(threadId) ?? [];
          const index =
            reported === undefined
              ? matchingPageIndex(kept, input)
              : kept.findIndex((page) => page.reference.attachmentId === reported.attachmentId);
          if (index === -1) {
            return [undefined, current];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const next = new Map(current);
          if (rest.length === 0) {
            next.delete(threadId);
          } else {
            next.set(threadId, rest);
          }
          return [kept[index]!.reference, next];
        });
      },
    ),
    toolResultEpoch: Effect.fn("McpProviderSessions.toolResultEpoch")(
      function (threadId, providerSessionId) {
        // SCIENT-FORK:START — generations are unique tokens held only while their thread has one.
        return Ref.modify(toolResultState, (state): [number, ToolResultState] => {
          const open = state.sessions.get(threadId);
          if (open === undefined || (providerSessionId !== undefined && open !== providerSessionId))
            return [REFUSED_EPOCH, state];
          const current = state.epochs.get(threadId);
          if (current !== undefined) return [current, state];
          const epochs = new Map(state.epochs).set(threadId, state.nextEpoch);
          return [state.nextEpoch, { ...state, epochs, nextEpoch: state.nextEpoch + 1 }];
        });
        // SCIENT-FORK:END
      },
    ),
    recordToolResult: Effect.fn("McpProviderSessions.recordToolResult")(
      function* (threadId, toolName, input, output, options) {
        const providerSessionId = options?.providerSessionId;
        if (providerSessionId !== undefined) {
          const activeSession = (yield* Ref.get(sessions)).get(threadId);
          // A handler finishing after session replacement must not populate the new session.
          if (
            activeSession !== undefined &&
            activeSession.providerSessionId !== providerSessionId
          ) {
            return;
          }
        }
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        const entry: KeptToolResult = {
          toolName: canonicalTool,
          inputHash: hashToolInput(input),
          outputJson: stableStringify(output),
          output,
        };
        const expectedEpoch = options?.epoch;
        yield* Ref.update(toolResultState, (state) => {
          // A handler finishing after its turn closed must not populate the next turn.
          // SCIENT-FORK:START — no generation, or a refused one, matches; a write names its session.
          if (expectedEpoch !== undefined && state.epochs.get(threadId) !== expectedEpoch) {
            return state;
          }
          if (
            providerSessionId !== undefined &&
            state.sessions.get(threadId) !== providerSessionId
          ) {
            return state;
          }
          // SCIENT-FORK:END
          const entries = new Map(state.entries);
          entries.set(
            threadId,
            [...(entries.get(threadId) ?? []), entry].slice(-MAX_KEPT_TOOL_RESULTS),
          );
          return { ...state, entries };
        });
      },
    ),
    takeToolResult: Effect.fn("McpProviderSessions.takeToolResult")(
      function (threadId, toolName, input, reported) {
        const canonicalTool = resolveT3McpToolId(toolName) ?? toolName;
        return Ref.modify(toolResultState, (state) => {
          const kept = state.entries.get(threadId) ?? [];
          const index = matchingToolResultIndex(kept, canonicalTool, input, reported);
          if (index === -1) {
            return [undefined, state];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const entries = new Map(state.entries);
          if (rest.length === 0) {
            entries.delete(threadId);
          } else {
            entries.set(threadId, rest);
          }
          return [kept[index]!.output, { ...state, entries }];
        });
      },
    ),
    clearToolResults: Effect.fn("McpProviderSessions.clearToolResults")(function (threadId) {
      return Ref.update(toolResultState, (state) => clearThreadToolResults(state, threadId));
    }),
    recordApprovalRequest: Effect.fn("McpProviderSessions.recordApprovalRequest")(
      function (threadId, request) {
        return randomUuidV4.pipe(
          Effect.tap((id) =>
            Ref.update(approvalRequests, (current) =>
              new Map(current).set(
                threadId,
                [...(current.get(threadId) ?? []), { ...request, id }].slice(
                  -MAX_KEPT_APPROVAL_REQUESTS,
                ),
              ),
            ),
          ),
        );
      },
    ),
    findApprovalRequest: Effect.fn("McpProviderSessions.findApprovalRequest")(
      function (threadId, message) {
        return Ref.get(approvalRequests).pipe(
          Effect.map((current) => current.get(threadId)?.find((kept) => kept.message === message)),
        );
      },
    ),
    forgetApprovalRequest: Effect.fn("McpProviderSessions.forgetApprovalRequest")(
      function (threadId, id) {
        return Effect.asVoid(takeApprovalRequest(threadId, id));
      },
    ),
    showsApprovalRequests: Effect.fn("McpProviderSessions.showsApprovalRequests")(
      function (providerInstanceId) {
        return Ref.update(approvalRequestsShownBy, (current) =>
          new Set(current).add(providerInstanceId),
        );
      },
    ),
    areApprovalRequestsShown: Effect.fn("McpProviderSessions.areApprovalRequestsShown")(
      function (providerInstanceId) {
        return Ref.get(approvalRequestsShownBy).pipe(
          Effect.map((current) => current.has(providerInstanceId)),
        );
      },
    ),
    answerApprovalRequests: Effect.fn("McpProviderSessions.answerApprovalRequests")(
      function (threadId, message, approved) {
        return Ref.update(approvalRequests, (current) => {
          const kept = current.get(threadId);
          // A request's first answer stands.
          const waits = (request: KeptApprovalRequest) =>
            request.message === message && request.approved === undefined;
          if (kept === undefined || !kept.some(waits)) return current;
          return new Map(current).set(
            threadId,
            kept.map((request) => (waits(request) ? { ...request, approved } : request)),
          );
        });
      },
    ),
    takeApprovalRequest: Effect.fn("McpProviderSessions.takeApprovalRequest")(takeApprovalRequest),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);

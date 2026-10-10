import * as Crypto from "effect/Crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ProviderApprovalDecision,
  ProviderSessionId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { CLAUDE_SCIENT_TOOL_PROJECTION } from "../../provider/ScientToolProjection.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  makeClaudeTestTurnInput,
} from "./ClaudeAdapterV2.fixture.ts";

describe("ClaudeAdapterV2 Auto-accept edits", () => {
  it.effect.each(
    [false, true].map((granted) => ({
      caseTitle: `asks before a command and delivers actual session awareness with grants ${granted}`,
      granted,
    })),
  )("$caseTitle", ({ granted }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-accept-edits-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-accept-edits"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  setPermissionMode: () =>
                    Effect.die("Permission-mode mutation is outside this fixture."),
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const threadId = ThreadId.make("thread-claude-accept-edits");
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const capabilities = new Set([
          "documents:build",
          "compute:inventory",
          "skills:read",
        ] as const);
        if (granted) {
          yield* mcpSessions.set({
            environmentId: EnvironmentId.make("claude-native-awareness"),
            threadId,
            providerSessionId: "claude-native-awareness",
            providerInstanceId: CLAUDE_TEST_MODEL_SELECTION.instanceId,
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer synthetic-claude",
            capabilities,
          });
          yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));
        }
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-accept-edits"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-accept-edits"),
            text: "Run node.",
            attachments: [],
            runtimePolicy,
          }),
        );
        assert.equal(openedOptions?.permissionMode, "acceptEdits");
        const systemPrompt = openedOptions?.systemPrompt;
        if (
          typeof systemPrompt !== "object" ||
          systemPrompt === null ||
          !("type" in systemPrompt) ||
          systemPrompt.type !== "preset"
        )
          return yield* Effect.die("Missing native Claude system prompt");
        assert.include(
          systemPrompt.append ?? "",
          buildScientAwareness(granted ? capabilities : undefined, CLAUDE_SCIENT_TOOL_PROJECTION),
        );
        assert.equal(
          (systemPrompt.append ?? "").includes("mcp__scient__scient_pdf_build"),
          granted,
        );
        assert.equal(
          (systemPrompt.append ?? "").includes("mcp__scient__scient_skill_load"),
          granted,
        );
        assert.notInclude(systemPrompt.append ?? "", "preview_status");
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);

        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const command = { command: "node -e 'console.log(42)'" };
        const decision = yield* Effect.promise(() =>
          canUseTool!("Bash", command, {
            signal: new AbortController().signal,
            toolUseID: "tool-bash-accept-edits",
            requestId: "request-bash-accept-edits",
          }),
        ).pipe(Effect.forkScoped);
        // Without a callback that asks, the command is allowed before any
        // request is raised.
        const first = yield* Effect.raceFirst(
          Fiber.join(requestEvent).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(decision).pipe(
            Effect.map((result) => ({ type: "decision", result }) as const),
          ),
        );
        assert.equal(first.type, "request", "the command ran without asking");
        if (first.type !== "request") return;
        const event = first.event;
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        assert.equal(event.value.runtimeRequest.kind, "command");

        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          decision: "accept",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "allow");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 approval cancellation", () => {
  it.effect("observes an approval signal that was already aborted", () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      const controller = new AbortController();
      controller.abort();

      const result = yield* ClaudeAdapterV2.awaitClaudeApprovalDecision(
        decision,
        controller.signal,
      );

      assert.equal(result, "cancel");
    }),
  );

  it.effect("removes the cancellation listener after approval resolves", () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      const controller = new AbortController();
      let removes = 0;
      const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.removeEventListener = (...args) => {
        removes += 1;
        return removeEventListener(...args);
      };
      const fiber = yield* Effect.forkChild(
        ClaudeAdapterV2.awaitClaudeApprovalDecision(decision, controller.signal),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(decision, "accept");
      const result = yield* Fiber.join(fiber);

      assert.equal(result, "accept");
      assert.equal(removes, 1);
    }),
  );
});

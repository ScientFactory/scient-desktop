import * as NodeOS from "node:os";
import type { Query as ClaudeQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionId, RunAttemptId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
} from "./ClaudeAdapterV2.fixture.ts";

describe("ClaudeAdapterV2 executable path", () => {
  it.effect("expands ~ in the configured binary path for the SDK", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const executablePaths: Array<string | undefined> = [];
        const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
          {
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            displayName: undefined,
            environment: [],
            enabled: true,
            config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath: "~/bin/claude" },
          },
          {},
        ).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-claude-binary-home-",
            }),
          ),
          Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
            allocateSessionId: Effect.succeed("native-thread-claude-binary-home"),
            open: (input) =>
              Effect.sync(() => {
                executablePaths.push(input.options.pathToClaudeCodeExecutable);
                return {
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
          }),
        );
        const threadId = ThreadId.make("thread-claude-binary-home");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-binary-home"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-binary-home"),
            text: "hello",
            attachments: [],
          }),
        );

        assert.deepEqual(executablePaths, [path.join(NodeOS.homedir(), "bin", "claude")]);
      }),
    ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});

describe("ClaudeAdapterV2 resume compaction", () => {
  it.effect("resolves and cancels the SDK resume dialog through structured runtime input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-resume-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-resume"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
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
        const threadId = ThreadId.make("thread-claude-resume");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-resume"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-resume"),
            text: "continue",
            attachments: [],
          }),
        );
        const callback = openedOptions?.onUserDialog;
        assert.isFunction(callback);
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);
        const ordinaryToolResult = yield* Effect.promise(() =>
          canUseTool!(
            "Bash",
            { command: "pwd" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-bash-full-access",
              requestId: "request-bash-full-access",
            },
          ),
        );
        assert.deepEqual(ordinaryToolResult, {
          behavior: "allow",
          updatedInput: { command: "pwd" },
          toolUseID: "tool-bash-full-access",
        });
        const longQuestion = `Choose a deployment target: ${"region ".repeat(80)}`;
        const questionRequestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const questionResult = yield* Effect.promise(() =>
          canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Target",
                  question: longQuestion,
                  options: [
                    { label: "Production", description: "Deploy to production." },
                    { label: "Staging", description: "Deploy to staging." },
                  ],
                  multiSelect: true,
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-question-full-access",
              requestId: "request-question-full-access",
            },
          ),
        ).pipe(Effect.forkScoped);
        const questionEvent = yield* Fiber.join(questionRequestEvent);
        assert.isTrue(Option.isSome(questionEvent));
        if (
          Option.isNone(questionEvent) ||
          questionEvent.value.type !== "runtime_request.updated"
        ) {
          return;
        }
        yield* runtime.respondToRuntimeRequest({
          requestId: questionEvent.value.runtimeRequest.id,
          answers: { [longQuestion]: ["Production", "Staging"] },
        });
        assert.deepEqual(yield* Fiber.join(questionResult), {
          behavior: "allow",
          updatedInput: {
            questions: [
              {
                header: "Target",
                question: longQuestion,
                options: [
                  { label: "Production", description: "Deploy to production." },
                  { label: "Staging", description: "Deploy to staging." },
                ],
                multiSelect: true,
              },
            ],
            answers: { [longQuestion]: "Production, Staging" },
          },
          toolUseID: "tool-question-full-access",
        });
        const longPlan = `# Deployment plan\n\n${"Validate every region before promotion.\n".repeat(120)}`;
        const proposedPlanEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "plan.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const exitPlanResult = yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: longPlan },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-full-access",
              requestId: "request-exit-plan-full-access",
            },
          ),
        );
        assert.deepEqual(exitPlanResult, {
          behavior: "deny",
          message:
            "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          toolUseID: "tool-exit-plan-full-access",
        });
        const planEvent = yield* Fiber.join(proposedPlanEvent);
        assert.isTrue(Option.isSome(planEvent));
        if (Option.isSome(planEvent) && planEvent.value.type === "plan.updated") {
          assert.equal(planEvent.value.plan.kind, "proposed_plan");
          if (planEvent.value.plan.kind === "proposed_plan") {
            assert.equal(planEvent.value.plan.markdown, longPlan.trim());
          }
        }
        const requestEvent = yield* runtime.events
          .pipe(
            Stream.filter((event) => event.type === "runtime_request.updated"),
            Stream.runHead,
          )
          .pipe(Effect.forkScoped);
        const controller = new AbortController();
        const dialog = yield* Effect.promise(() =>
          callback!(
            {
              dialogKind: "resume_return",
              payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
            },
            { signal: controller.signal, requestId: "dialog-resume-1" },
          ),
        ).pipe(Effect.forkScoped);
        const event = yield* Fiber.join(requestEvent);
        assert.isTrue(Option.isSome(event));
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        const question = formatClaudeResumeCompactionQuestion({
          ageMinutes: 90,
          estimatedTokens: 120000,
        });
        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          answers: { [question]: "Compact and continue" },
        });
        assert.deepEqual(yield* Fiber.join(dialog), { behavior: "completed", result: "compact" });

        const cancelledController = new AbortController();
        cancelledController.abort();
        assert.deepEqual(
          yield* Effect.promise(() =>
            callback!(
              {
                dialogKind: "resume_return",
                payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
              },
              { signal: cancelledController.signal, requestId: "dialog-resume-2" },
            ),
          ),
          { behavior: "cancelled" },
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});

describe("ClaudeAdapterV2 native session identity", () => {
  const openTurnWithOrdinal = (providerTurnOrdinal: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-session-identity-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-session-identity"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-session-identity");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-identity");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("run-attempt-claude-session-identity"),
            text: "Respond with identity ok",
            attachments: [],
            providerTurnOrdinal,
          }),
        );
        return openedQueries;
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    );

  it.effect("creates the native session on the first provider turn", () =>
    Effect.gen(function* () {
      const openedQueries = yield* openTurnWithOrdinal(1);
      assert.equal(openedQueries.length, 1);
      assert.equal(openedQueries[0]?.options.sessionId, "native-session-identity");
      assert.equal(openedQueries[0]?.options.resume, undefined);
    }),
  );

  it.effect(
    "resumes the native session on a fresh session instance when prior provider turns exist",
    () =>
      Effect.gen(function* () {
        const openedQueries = yield* openTurnWithOrdinal(2);
        assert.equal(openedQueries.length, 1);
        assert.equal(openedQueries[0]?.options.resume, "native-session-identity");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }),
  );
});

describe("ClaudeAdapterV2 query message stream", () => {
  it.effect("closes the query when the message stream is interrupted mid-read", () =>
    Effect.gen(function* () {
      let closed = false;
      let releaseRead = () => {};
      const readStarted = Promise.withResolvers<void>();
      // Never yields a message — the read stays pending until close() flips
      // `closed` and releases the in-flight await.
      // oxlint-disable-next-line require-yield
      async function* sdkMessages(): AsyncGenerator<SDKMessage, void> {
        for (;;) {
          if (closed) return;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
            readStarted.resolve();
          });
        }
      }
      const generator = sdkMessages();
      const close = () => {
        closed = true;
        releaseRead();
      };
      const query = {
        next: () => generator.next(),
        return: async (value?: void) => {
          close();
          return generator.return(value);
        },
        throw: (error?: unknown) => generator.throw(error),
        [Symbol.asyncIterator]: () => generator,
        close,
      } as unknown as ClaudeQuery;

      const scope = yield* Scope.make();
      yield* Stream.fromAsyncIterable(
        ClaudeAdapterV2.claudeQueryMessages(query),
        (cause) => cause,
      ).pipe(
        Stream.runForEach(() => Effect.void),
        Effect.forkIn(scope),
      );
      yield* Effect.promise(() => readStarted.promise);

      // Iterating query[Symbol.asyncIterator]() directly deadlocks here:
      // the raw generator's return() queues behind the in-flight read and
      // scope close never completes.
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(closed);
    }),
  );
});

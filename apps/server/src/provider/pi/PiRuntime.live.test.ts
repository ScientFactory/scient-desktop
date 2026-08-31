// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { ApprovalRequestId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { prepareScientSkillTurn } from "../../scient/skills/ScientSkillInvocation.ts";
import { BUILT_IN_SKILL_RELEASES } from "../../scient/skills/BuiltInSkillReleases.ts";

const binary = process.env.SCIENT_PI_TEST_BINARY;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const isSyntheticTool = Schema.is(Schema.Struct({ toolName: Schema.Literal("scient_test_echo") }));

const prepareSyntheticSkillTurn = (input: string) =>
  prepareScientSkillTurn(
    input,
    [
      {
        releaseKey: "synthetic-release",
        id: "scient.synthetic",
        name: "synthetic",
        description: "Synthetic test skill",
        origin: "scient",
        activationScope: "user",
        invocationPolicy: "automatic",
      },
    ],
    new Map([["synthetic-release", BUILT_IN_SKILL_RELEASES[0]!]]),
  );

it.effect.skipIf(!binary)(
  "real Pi extension questions resolve while command acceptance waits, without a model call",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-questions-" });
        const profile = path.join(root, "profile");
        yield* fs.makeDirectory(path.join(profile, "extensions"), { recursive: true });
        yield* fs.writeFileString(
          path.join(profile, "models.json"),
          json({
            providers: {
              "scient-test": {
                baseUrl: "http://127.0.0.1:9/v1",
                api: "openai-completions",
                apiKey: "synthetic",
                models: [
                  {
                    id: "synthetic",
                    name: "Unused synthetic model",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 32000,
                    maxTokens: 1024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(profile, "extensions", "question.js"),
          `export default function(pi) {
      pi.registerCommand("synthetic-question", { description: "Synthetic native questions", handler: async (args, ctx) => {
        if (args !== "") throw new Error("Native command arguments were changed");
        const choice = await ctx.ui.select("Select synthetic value", ["Beta", " Beta "]);
        const confirmed = await ctx.ui.confirm("Synthetic confirmation", "Confirm the test?");
        const input = await ctx.ui.input("Synthetic input", "Enter synthetic text");
        const editor = await ctx.ui.editor("Synthetic editor", "Initial text");
        ctx.ui.notify(JSON.stringify({choice, confirmed, input, editor}), "info");
      }});
    }`,
        );
        const instanceId = ProviderInstanceId.make("pi-questions");
        const threadId = ThreadId.make("pi-questions");
        const adapter = yield* makePiAdapter({
          binaryPath: binary!,
          providerInstanceId: instanceId,
          stateDir: root,
          attachmentsDir: path.join(root, "attachments"),
          environment: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: profile },
        });
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        const answers = [" Beta ", "true", "שלום π", "Line one\nLine two"];
        let questionCount = 0;
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (event.type !== "user-input.requested") return;
              const question = event.payload.questions[0]!;
              if (questionCount === 0) {
                expect(question.allowCustomAnswer).toBe(false);
                expect(question.options.map((option) => option.value)).toEqual(["Beta", " Beta "]);
              }
              if (questionCount === 3) expect(question.question).toContain("Initial text");
              yield* adapter.respondToUserInput(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                {
                  [question.id]: answers[questionCount++]!,
                },
              );
            }),
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const prepared = prepareSyntheticSkillTurn("/synthetic-question");
        expect(prepared.input).toContain("Scient runtime instruction:");
        const accepted = yield* adapter.sendTurn({
          threadId,
          input: prepared.input,
          originalInput: "/synthetic-question",
          modelSelection: createModelSelection(instanceId, "scient-test/synthetic"),
        });
        const events = Array.from(yield* Fiber.join(collected));
        expect(questionCount).toBe(4);
        expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(4);
        expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
          turnId: accepted.turnId,
          payload: { state: "completed" },
        });
        expect(
          events.find(
            (event) =>
              event.type === "runtime.warning" && event.payload.message.includes("confirmed"),
          )?.payload,
        ).toMatchObject({
          message: json({
            choice: " Beta ",
            confirmed: true,
            input: "שלום π",
            editor: "Line one\nLine two",
          }),
        });
        const cancelledEvents = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.type === "user-input.requested"
              ? adapter.interruptTurn(threadId, event.turnId)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const cancelled = yield* adapter
          .sendTurn({
            threadId,
            input: prepared.input,
            originalInput: "/synthetic-question",
            modelSelection: createModelSelection(instanceId, "scient-test/synthetic"),
          })
          .pipe(Effect.exit);
        expect(cancelled._tag).toBe("Failure");
        if (cancelled._tag === "Failure")
          expect(Cause.hasInterruptsOnly(cancelled.cause)).toBe(true);
        const stoppedEvents = Array.from(yield* Fiber.join(cancelledEvents));
        expect(stoppedEvents.filter((event) => event.type === "runtime.error")).toHaveLength(0);
        expect(stoppedEvents.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect(stoppedEvents.at(-1)).toMatchObject({ payload: { state: "interrupted" } });
        expect(yield* adapter.listSessions()).toHaveLength(0);
        const resumed = yield* adapter.startSession({
          threadId,
          cwd: root,
          runtimeMode: "full-access",
          resumeCursor: accepted.resumeCursor,
        });
        expect(resumed.resumeCursor).toEqual(accepted.resumeCursor);
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);

it.effect.skipIf(!binary)(
  "real Pi discovers and invokes the Scient bridge over SSE, preserving structured errors",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-bridge-" });
        const calls: Array<Record<string, unknown>> = [];
        const modelRequests: string[] = [];
        const server = NodeHttp.createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += String(chunk);
          const parsed = decodeRecord(body);
          if (request.url === "/mcp") {
            if (request.headers.authorization !== "Bearer synthetic-only") {
              response.writeHead(401);
              response.end();
              return;
            }
            calls.push(parsed);
            if (parsed.method === "notifications/initialized") {
              response.writeHead(202);
              response.end();
              return;
            }
            const result =
              parsed.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "synthetic-scient", version: "1" },
                  }
                : parsed.method === "tools/list"
                  ? {
                      tools: [
                        {
                          name: "scient_test_echo",
                          description: "Synthetic bridge verification",
                          inputSchema: {
                            type: "object",
                            properties: { value: { type: "string" } },
                            required: ["value"],
                          },
                        },
                      ],
                    }
                  : {
                      content: [{ type: "text", text: "Bridge: שלום π" }],
                      structuredContent: {
                        test: "preserved",
                        count: calls.filter((call) => call.method === "tools/call").length,
                      },
                      isError: calls.filter((call) => call.method === "tools/call").length === 2,
                    };
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "mcp-session-id": "synthetic-session",
            });
            response.write(": heartbeat\r\n\r\n");
            response.end(
              `event: message\r\ndata: ${json({ jsonrpc: "2.0", id: parsed.id, result })}\r\n\r\n`,
            );
            return;
          }
          modelRequests.push(body);
          const tool = modelRequests.length % 2 === 1;
          response.writeHead(200, { "content-type": "text/event-stream" });
          const delta = tool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${modelRequests.length}`,
                    type: "function",
                    function: { name: "scient_test_echo", arguments: json({ value: "synthetic" }) },
                  },
                ],
              }
            : { role: "assistant", content: "Bridge completed." };
          response.write(
            `data: ${json({ id: "bridge-test", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          );
          response.end(
            `data: ${json({ id: "bridge-test", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
          );
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Test endpoint did not start");
        const profile = path.join(root, "profile");
        yield* fs.makeDirectory(profile);
        yield* fs.writeFileString(
          path.join(profile, "models.json"),
          json({
            providers: {
              "scient-test": {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                api: "openai-completions",
                apiKey: "synthetic-not-a-secret",
                models: [
                  {
                    id: "synthetic",
                    name: "Synthetic test model",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 32000,
                    maxTokens: 1024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          }),
        );
        const threadId = ThreadId.make("pi-live-bridge-thread");
        const instanceId = ProviderInstanceId.make("pi-live-bridge");
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            setMcpProviderSession({
              threadId,
              providerInstanceId: instanceId,
              environmentId: EnvironmentId.make("pi-test"),
              providerSessionId: "synthetic",
              endpoint: `http://127.0.0.1:${address.port}/mcp`,
              authorizationHeader: "Bearer synthetic-only",
              capabilities: new Set(),
            }),
          ),
          () => Effect.sync(() => clearMcpProviderSession(threadId)),
        );
        const adapter = yield* makePiAdapter({
          binaryPath: binary!,
          providerInstanceId: instanceId,
          stateDir: root,
          attachmentsDir: path.join(root, "attachments"),
          environment: {
            PATH: process.env.PATH,
            HOME: root,
            PI_CODING_AGENT_DIR: profile,
            PI_TELEMETRY: "0",
            PI_SKIP_VERSION_CHECK: "1",
          },
        });
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        for (let turn = 0; turn < 2; turn++) {
          const collected = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* adapter.sendTurn({
            threadId,
            input: "Exercise the synthetic Scient tool",
            modelSelection: createModelSelection(instanceId, "scient-test/synthetic"),
          });
          const events = Array.from(yield* Fiber.join(collected));
          const completedTool = events.find(
            (event) => event.type === "item.completed" && isSyntheticTool(event.payload.data),
          );
          expect(completedTool?.type === "item.completed" && completedTool.payload.status).toBe(
            turn === 1 ? "failed" : "completed",
          );
          expect(completedTool?.raw?.payload).toMatchObject({ isError: turn === 1 });
          expect(events.some((event) => event.type === "thread.token-usage.updated")).toBe(true);
          expect(modelRequests[modelRequests.length - 1]).toContain("preserved");
        }
        expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(2);
        expect(modelRequests).toHaveLength(4);
        expect(modelRequests[0]).toContain("scient_test_echo");
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect.skipIf(!binary)(
  "real Pi streams repeat turns against a synthetic local model without user credentials",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-model-" });
        const requests: string[] = [];
        let completeFirstResponse: (() => void) | undefined;
        const server = NodeHttp.createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += String(chunk);
          requests.push(body);
          if (requests.length === 13) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: { message: "Synthetic model failure", type: "invalid_request_error" },
              }),
            );
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (requests.length === 1)
            response.write(
              `data: ${json({ id: "test", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Synthetic reasoning before completion." }, finish_reason: null }] })}\n\n`,
            );
          response.write(
            `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic response: שלום π \u2028 preserved." }, finish_reason: null }] })}\n\n`,
          );
          const finish = () =>
            response.end(
              `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`,
            );
          // A deterministic network gate: finish only after Scient has consumed
          // both native delta kinds, not after an arbitrary timer.
          if (requests.length === 1) completeFirstResponse = finish;
          else finish();
        });
        yield* Effect.acquireRelease(
          Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          ),
          () =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Test endpoint did not start");
        const profile = path.join(root, "profile");
        yield* fs.makeDirectory(profile);
        yield* fs.makeDirectory(path.join(profile, "prompts"));
        yield* fs.writeFileString(
          path.join(profile, "prompts", "native-template.md"),
          "Native prompt sentinel: $ARGUMENTS",
        );
        yield* fs.makeDirectory(path.join(profile, "skills", "native-skill"), { recursive: true });
        yield* fs.writeFileString(
          path.join(profile, "skills", "native-skill", "SKILL.md"),
          "---\nname: native-skill\ndescription: Synthetic native skill\n---\nNative skill sentinel.",
        );
        yield* fs.writeFileString(
          path.join(profile, "models.json"),
          json({
            providers: {
              "scient-test": {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                api: "openai-completions",
                apiKey: "synthetic-not-a-secret",
                models: [
                  {
                    id: "synthetic",
                    name: "Synthetic test model",
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 32000,
                    maxTokens: 1024,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          }),
        );
        const instanceId = ProviderInstanceId.make("pi-local-model");
        const threadId = ThreadId.make("pi-local-model-thread");
        const adapter = yield* makePiAdapter({
          binaryPath: binary!,
          providerInstanceId: instanceId,
          stateDir: root,
          attachmentsDir: path.join(root, "attachments"),
          environment: {
            PATH: process.env.PATH,
            HOME: root,
            PI_CODING_AGENT_DIR: profile,
            PI_TELEMETRY: "0",
            PI_SKIP_VERSION_CHECK: "1",
          },
        });
        yield* adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" });
        for (let turn = 0; turn < 14; turn++) {
          const textReceived = yield* Deferred.make<void>();
          const reasoningReceived = yield* Deferred.make<void>();
          let completedBeforeRelease = false;
          const collected = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                if (event.type === "turn.completed") completedBeforeRelease = true;
                if (event.type !== "content.delta") return;
                if (event.payload.streamKind === "assistant_text")
                  yield* Deferred.succeed(textReceived, undefined);
                if (event.payload.streamKind === "reasoning_text")
                  yield* Deferred.succeed(reasoningReceived, undefined);
              }),
            ),
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const originalInput =
            turn === 1
              ? "/native-template exact arguments"
              : turn === 2
                ? "/skill:native-skill"
                : `Synthetic turn ${turn}`;
          const prepared = prepareSyntheticSkillTurn(originalInput);
          const accepted = yield* adapter.sendTurn({
            threadId,
            input: prepared.input,
            originalInput,
            modelSelection: createModelSelection(instanceId, "scient-test/synthetic"),
          });
          if (turn === 0) {
            yield* Deferred.await(textReceived);
            yield* Deferred.await(reasoningReceived);
            expect(completedBeforeRelease).toBe(false);
            expect(completeFirstResponse).toBeDefined();
            completeFirstResponse!();
          }
          const events = Array.from(yield* Fiber.join(collected));
          const completed = events.filter((event) => event.type === "turn.completed");
          expect(completed).toHaveLength(1);
          expect(completed[0]?.turnId).toBe(accepted.turnId);
          expect(completed[0]?.payload.state).toBe(turn === 12 ? "failed" : "completed");
          if (turn !== 12)
            expect(
              events
                .filter((event) => event.type === "content.delta")
                .map((event) => event.payload.delta)
                .join(""),
            ).toContain("שלום π \u2028 preserved");
        }
        const concurrentThreads = Array.from({ length: 4 }, (_, index) =>
          ThreadId.make(`pi-concurrent-${index}`),
        );
        const sessions = yield* Effect.forEach(
          concurrentThreads,
          (threadId) => adapter.startSession({ threadId, cwd: root, runtimeMode: "full-access" }),
          { concurrency: 2 },
        );
        expect(new Set(sessions.map((session) => json(session.resumeCursor))).size).toBe(4);
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        const sent = yield* Effect.forEach(
          concurrentThreads,
          (threadId) =>
            adapter.sendTurn({
              threadId,
              input: "Concurrent synthetic turn",
              modelSelection: createModelSelection(instanceId, "scient-test/synthetic"),
            }),
          { concurrency: 4 },
        );
        expect(
          Array.from(yield* Fiber.join(completed))
            .map((event) => event.turnId)
            .sort(),
        ).toEqual(sent.map((turn) => turn.turnId).sort());
        expect(requests).toHaveLength(18);
        expect(requests[0]).toContain("Scient");
        expect(requests[1]).toContain("Native prompt sentinel: exact arguments");
        expect(requests[2]).toContain("Native skill sentinel.");
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect.skipIf(!binary)(
  "real Pi loads the Scient bridge and resumes only its exact private session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-native-" });
        const adapter = yield* makePiAdapter({
          binaryPath: binary!,
          providerInstanceId: ProviderInstanceId.make("pi-live-test"),
          stateDir: root,
          attachmentsDir: path.join(root, "attachments"),
          environment: {
            PATH: process.env.PATH,
            HOME: root,
            PI_CODING_AGENT_DIR: path.join(root, "profile"),
            PI_TELEMETRY: "0",
            PI_SKIP_VERSION_CHECK: "1",
          },
        });
        const input = {
          threadId: ThreadId.make("pi-live-thread"),
          cwd: root,
          runtimeMode: "full-access" as const,
        };
        const first = yield* adapter.startSession(input);
        expect(first.status).toBe("ready");
        expect(first.resumeCursor).toBeDefined();
        yield* adapter.stopSession(input.threadId);
        expect(yield* adapter.hasSession(input.threadId)).toBe(false);
        const resumed = yield* adapter.startSession({ ...input, resumeCursor: first.resumeCursor });
        expect(resumed.resumeCursor).toEqual(first.resumeCursor);
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);

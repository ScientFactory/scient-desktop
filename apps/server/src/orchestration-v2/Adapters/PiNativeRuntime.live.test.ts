// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import {
  binary,
  json,
  decodeRecord,
  layer,
  fixture,
  collect,
  serve,
  ensure,
} from "./PiNativeTestHarness.ts";

it.layer(layer, { excludeTestServices: true })("real Pi native V2", (it) => {
  it.effect.skipIf(!binary)(
    "real native Pi discovers and invokes the Scient MCP bridge over SSE with structured errors",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: Array<Record<string, unknown>> = [];
          const modelRequests: string[] = [];
          const baseUrl = yield* serve(async (request, response) => {
            assert.equal(request.method, "POST");
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
                      function: {
                        name: "mcp__t3-code__scient_test_echo",
                        arguments: json({ value: "synthetic" }),
                      },
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

          const h = yield* fixture("bridge");
          yield* h.models(`${baseUrl}/v1`);
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                threadId: h.threadId,
                providerInstanceId: h.instanceId,
                environmentId: EnvironmentId.make("pi-real-mcp"),
                providerSessionId: "synthetic",
                endpoint: `${baseUrl}/mcp`,
                authorizationHeader: "Bearer synthetic-only",
                capabilities: new Set(),
              }),
            ),
            () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(h.threadId)),
          );
          const runtime = yield* h.open();
          const thread = yield* ensure(h, runtime);
          const c = yield* collect(runtime);
          for (let turn = 0; turn < 2; turn++) {
            const offset = c.events.length;
            yield* h.send(runtime, thread, turn + 1, "Exercise the synthetic Scient tool");
            const terminal = yield* c.take((event) => event.type === "turn.terminal");
            assert.equal(
              terminal.type === "turn.terminal" ? terminal.status : undefined,
              "completed",
              json(terminal),
            );
            const events = c.events.slice(offset);
            const tool = events.findLast(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "dynamic_tool" &&
                event.turnItem.toolName === "mcp__t3-code__scient_test_echo",
            );
            if (tool?.type !== "turn_item.updated" || tool.turnItem.type !== "dynamic_tool")
              return yield* Effect.die("Missing bridge result");
            assert.equal(tool.turnItem.status, turn === 1 ? "failed" : "completed");
            assert.equal(tool.turnItem.output, "Bridge: שלום π");
            assert.isTrue(
              events.some(
                (event) =>
                  event.type === "provider_turn.updated" &&
                  event.providerTurn.tokenUsage !== undefined,
              ),
            );
            assert.include(modelRequests.at(-1)!, "Bridge: שלום π");
            assert.notInclude(modelRequests.at(-1)!, "preserved");
            const nativeFile = thread.nativeThreadRef?.nativeId;
            if (nativeFile == null) return yield* Effect.die("Missing native session file");
            const session = yield* h.fs.readFileString(nativeFile);
            const records = session
              .trim()
              .split("\n")
              .map((line) => decodeRecord(line));
            const results = records.flatMap((record) => {
              const message = record.message;
              return typeof message === "object" &&
                message !== null &&
                "role" in message &&
                message.role === "toolResult" &&
                "toolName" in message &&
                message.toolName === "mcp__t3-code__scient_test_echo"
                ? [message]
                : [];
            });
            assert.lengthOf(results, turn + 1);
            assert.deepInclude(decodeRecord(json(results.at(-1))), {
              isError: turn === 1,
              details: {
                server: "t3-code",
                tool: "scient_test_echo",
                result: {
                  content: [{ type: "text", text: "Bridge: שלום π" }],
                  structuredContent: { test: "preserved", count: turn + 1 },
                  isError: turn === 1,
                },
              },
            });
          }
          assert.lengthOf(
            calls.filter((call) => call.method === "tools/call"),
            2,
          );
          assert.lengthOf(modelRequests, 4);
          assert.include(modelRequests[0]!, "scient_test_echo");
        }),
      ),
    30000,
  );

  it.effect.skipIf(!binary)(
    "streams repeated real native turns, templates, skills, failures and concurrent isolated sessions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests: string[] = [];
          let finishFirst: (() => void) | undefined;
          const baseUrl = yield* serve(async (request, response) => {
            assert.equal(request.method, "POST");
            let body = "";
            for await (const chunk of request) body += String(chunk);
            requests.push(body);
            if (requests.length === 13) {
              response.writeHead(400, { "content-type": "application/json" });
              response.end(
                json({
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
              `data: ${json({ id: "test", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic response: שלום π \u2028 preserved." }, finish_reason: null }] })}\n\n`,
            );
            const exhausted = requests.length === 15;
            const finish = () =>
              response.end(
                `data: ${json({ id: "test", object: "chat.completion.chunk", model: "synthetic", choices: [{ index: 0, delta: {}, finish_reason: exhausted ? "length" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: exhausted ? 1024 : 8, total_tokens: exhausted ? 1034 : 18 } })}\n\ndata: [DONE]\n\n`,
              );
            if (requests.length === 1) finishFirst = finish;
            else finish();
          });
          const h = yield* fixture("repeat");
          yield* h.models(`${baseUrl}/v1`, true);
          yield* h.fs.makeDirectory(h.path.join(h.profile, "prompts"));
          yield* h.fs.writeFileString(
            h.path.join(h.profile, "prompts", "native-template.md"),
            "Native prompt sentinel: $ARGUMENTS",
          );
          yield* h.fs.makeDirectory(h.path.join(h.profile, "skills", "native-skill"), {
            recursive: true,
          });
          yield* h.fs.writeFileString(
            h.path.join(h.profile, "skills", "native-skill", "SKILL.md"),
            "---\nname: native-skill\ndescription: Synthetic native skill\n---\nNative skill sentinel.",
          );
          const runtime = yield* h.open();
          const thread = yield* ensure(h, runtime);
          const c = yield* collect(runtime);
          for (let turn = 0; turn < 16; turn++) {
            const offset = c.events.length;
            yield* h.send(
              runtime,
              thread,
              turn + 1,
              turn === 1
                ? "/native-template exact arguments"
                : turn === 2
                  ? "/skill:native-skill"
                  : `Synthetic turn ${turn}`,
            );
            if (turn === 0) {
              yield* c.take(
                (event) =>
                  event.type === "message.updated" &&
                  event.message.role === "assistant" &&
                  event.message.text.includes("שלום π"),
              );
              const hasReasoning = (event: (typeof c.events)[number]) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "reasoning" &&
                event.turnItem.text.includes("Synthetic reasoning");
              if (!c.events.some(hasReasoning)) yield* c.take(hasReasoning);
              assert.isFalse(c.events.some((event) => event.type === "turn.terminal"));
              assert.isDefined(finishFirst);
              finishFirst!();
            }
            const terminal = yield* c.take((event) => event.type === "turn.terminal");
            assert.equal(
              terminal.type === "turn.terminal" ? terminal.status : undefined,
              turn === 12 ? "failed" : "completed",
            );
            const events = c.events.slice(offset);
            assert.lengthOf(
              events.filter((event) => event.type === "turn.terminal"),
              1,
            );
            if (turn !== 12)
              assert.isTrue(
                events.some(
                  (event) =>
                    event.type === "message.updated" &&
                    event.message.role === "assistant" &&
                    event.message.text.includes("שלום π \u2028 preserved"),
                ),
              );
            if (turn === 14) {
              assert.isTrue(
                events.some(
                  (event) =>
                    event.type === "turn_item.updated" &&
                    event.turnItem.type === "notification" &&
                    event.turnItem.source.kind === "output_truncated",
                ),
              );
              assert.isFalse(
                events.some(
                  (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
                ),
              );
            }
          }
          const sessions = yield* Effect.forEach(
            [0, 1, 2, 3],
            (index) =>
              Effect.gen(function* () {
                const concurrent = yield* fixture(`concurrent-${index}`);
                yield* concurrent.models(`${baseUrl}/v1`, true);
                const runtime = yield* concurrent.open();
                const thread = yield* ensure(concurrent, runtime);
                const c = yield* collect(runtime);
                return { h: concurrent, runtime, thread, c };
              }),
            { concurrency: 2 },
          );
          assert.equal(
            new Set(sessions.map(({ thread }) => thread.nativeThreadRef?.nativeId)).size,
            4,
          );
          yield* Effect.forEach(
            sessions,
            ({ h, runtime, thread, c }) =>
              Effect.gen(function* () {
                yield* h.send(runtime, thread, 1, "Concurrent synthetic turn");
                const terminal = yield* c.take((event) => event.type === "turn.terminal");
                assert.equal(
                  terminal.type === "turn.terminal" ? terminal.status : undefined,
                  "completed",
                );
                assert.lengthOf(
                  c.events.filter((event) => event.type === "turn.terminal"),
                  1,
                );
              }),
            { concurrency: 4 },
          );
          assert.lengthOf(requests, 20);
          const firstRequest = decodeRecord(requests[0]!);
          assert.equal(firstRequest.max_tokens ?? firstRequest.max_completion_tokens, 1024);
          assert.include(requests[0]!, "Scient");
          assert.include(requests[1]!, "Native prompt sentinel: exact arguments");
          assert.include(requests[2]!, "Native skill sentinel.");
        }),
      ),
    60000,
  );

  it.effect.skipIf(!binary)(
    "resumes the exact native session file with the Scient extension loaded",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture("resume");
          yield* h.models("http://127.0.0.1:9/v1");
          const firstScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
          const first = yield* h.open().pipe(Scope.provide(firstScope));
          const original = yield* ensure(h, first);
          const nativeId = original.nativeThreadRef?.nativeId;
          assert.isString(nativeId);
          assert.isTrue(yield* h.fs.exists(nativeId!));
          yield* Scope.close(firstScope, Exit.void);
          const resumed = yield* h.open(nativeId ?? undefined);
          const restored = yield* resumed.resumeThread({
            providerThread: original,
            threadId: h.threadId,
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          assert.equal(restored.nativeThreadRef?.nativeId, nativeId);
          assert.equal(restored.id, original.id);
          assert.include(yield* h.fs.readFileString(nativeId!), '"type":"session"');
        }),
      ),
    30000,
  );

  it.effect.skipIf(!binary)(
    "answers real native extension questions exactly and cancels a pending question with Stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture("questions");
          yield* h.models("http://127.0.0.1:9/v1");
          yield* h.fs.makeDirectory(h.path.join(h.profile, "extensions"));
          yield* h.fs.writeFileString(
            h.path.join(h.profile, "extensions", "question.js"),
            `export default function(pi) {
      pi.registerCommand("synthetic-question", { description: "Synthetic native questions", handler: async (args, ctx) => {
        if (args !== "") throw new Error("Native command arguments were changed");
        const choice = await ctx.ui.select("Select synthetic value", ["Beta", " Beta "]);
        const confirmed = await ctx.ui.confirm("Synthetic confirmation", "Confirm the test?");
        const input = await ctx.ui.input("Synthetic input", "Enter synthetic text");
        const editor = await ctx.ui.editor("Synthetic editor", "Initial text");
        ctx.ui.notify(JSON.stringify({ choice, confirmed, input, editor }), "info");
      }});
    }`,
          );
          const runtime = yield* h.open();
          const providerThread = yield* ensure(h, runtime);
          const c = yield* collect(runtime);
          yield* h.send(runtime, providerThread, 1, "/synthetic-question");
          const answers = [" Beta ", "true", "שלום π", "Line one\nLine two"];
          for (let index = 0; index < answers.length; index++) {
            const pending = yield* c.take(
              (event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending",
            );
            assert.equal(pending.type, "runtime_request.updated");
            if (pending.type !== "runtime_request.updated") return;
            assert.isFalse(c.events.some((event) => event.type === "turn.terminal"));
            const item = yield* c.take(
              (event) =>
                event.type === "turn_item.updated" &&
                (event.turnItem.type === "user_input_request" ||
                  event.turnItem.type === "approval_request") &&
                event.turnItem.requestId === pending.runtimeRequest.id,
            );
            if (index === 1) {
              assert.equal(pending.runtimeRequest.kind, "command");
              yield* runtime.respondToRuntimeRequest({
                requestId: pending.runtimeRequest.id,
                decision: "accept",
              });
            } else {
              if (item?.type !== "turn_item.updated" || item.turnItem.type !== "user_input_request")
                return yield* Effect.die("Missing native question item");
              const question = item.turnItem.questions[0]!;
              if (index === 0) {
                assert.isFalse(question.allowCustomAnswer);
                assert.deepEqual(
                  question.options.map((option) => option.value),
                  ["Beta", " Beta "],
                );
              }
              if (index === 3) assert.include(question.question, "Initial text");
              yield* runtime.respondToRuntimeRequest({
                requestId: pending.runtimeRequest.id,
                answers: { [question.id]: answers[index]! },
              });
            }
          }
          const completed = yield* c.take((event) => event.type === "turn.terminal");
          assert.equal(
            completed.type === "turn.terminal" ? completed.status : undefined,
            "completed",
          );
          assert.lengthOf(
            c.events.filter(
              (event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "resolved",
            ),
            4,
          );
          const notice = c.events.findLast(
            (event) => event.type === "turn_item.updated" && event.turnItem.title === "notify",
          );
          if (notice?.type !== "turn_item.updated" || notice.turnItem.type !== "dynamic_tool")
            return yield* Effect.die("Missing native notification");
          assert.deepEqual(notice.turnItem.input, {
            message: json({
              choice: " Beta ",
              confirmed: true,
              input: "שלום π",
              editor: "Line one\nLine two",
            }),
            notifyType: "info",
          });
          yield* h.send(runtime, providerThread, 2, "/synthetic-question");
          const waiting = yield* c.take(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          );
          if (
            waiting.type !== "runtime_request.updated" ||
            waiting.runtimeRequest.providerTurnId === null
          )
            return yield* Effect.die("Missing question owner");
          yield* runtime.interruptTurn({
            providerThread,
            providerTurnId: waiting.runtimeRequest.providerTurnId,
            requestRuntimeRestart: true,
          });
          const stopped = yield* c.take((event) => event.type === "turn.terminal");
          assert.equal(
            stopped.type === "turn.terminal" ? stopped.status : undefined,
            "interrupted",
          );
          assert.lengthOf(
            c.events.filter((event) => event.type === "turn.terminal"),
            2,
          );
          assert.isFalse(
            c.events.some(
              (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
            ),
          );
          assert.isTrue(
            c.events.some(
              (event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.id === waiting.runtimeRequest.id &&
                event.runtimeRequest.status === "cancelled",
            ),
          );
          const replacement = yield* h.open(providerThread.nativeThreadRef?.nativeId ?? undefined);
          const recovered = yield* replacement.resumeThread({
            providerThread,
            threadId: h.threadId,
            modelSelection: h.modelSelection,
            runtimePolicy: h.policy,
          });
          assert.equal(
            recovered.nativeThreadRef?.nativeId,
            providerThread.nativeThreadRef?.nativeId,
          );
        }),
      ),
    30000,
  );
});

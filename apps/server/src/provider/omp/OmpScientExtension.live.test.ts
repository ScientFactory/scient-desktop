// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
/**
 * Opt-in qualification against a real `omp` (set OMP_QUALIFY_BINARY). Runs in
 * a temporary HOME and PI_CODING_AGENT_DIR with synthetic credentials, a local
 * OpenAI-compatible stub model and a local fake Scient MCP endpoint; outbound
 * HTTP is proxied to a dead port. No paid model is called.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { customModelProviderId, type ResolvedModelConnection } from "../../customModels.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import { SCIENT_CORE_AWARENESS } from "../ScientAwareness.ts";
import { makeOmpCustomModelsClientFactory } from "./OmpCustomModels.ts";
import { ompProcessEnvironment } from "./OmpEnvironment.ts";
import { writeOmpExtensionFiles } from "./OmpExtensionBootstrap.ts";
import { ompScientExtensionSource } from "./OmpScientExtension.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { ompQualifyBinary } from "./OmpLive.testFixtures.ts";
import { encodeOmpModelSlug } from "./OmpModel.ts";
import {
  makeOmpRpcProcess,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "./OmpRpcProcess.ts";

const binary = ompQualifyBinary;
const SCIENT_TOOL = "scient_fixture_echo";
const TOKEN = "Bearer synthetic-scient-live-token";

type ChatRequest = {
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>;
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
};

const readBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const listen = (server: NodeHttp.Server) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<number>((resolve) =>
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve(typeof address === "object" && address ? address.port : 0);
          }),
        ),
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

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
          )
          .join("\n")
      : "";

/** OpenAI-compatible stub: calls the Scient tool once, then answers. */
const makeStubModel = () => {
  const requests: Array<ChatRequest> = [];
  const server = NodeHttp.createServer((request, response) => {
    void readBody(request).then((raw) => {
      const body = JSON.parse(raw) as ChatRequest;
      requests.push(body);
      const toolAnswered = body.messages?.some((message) => message.role === "tool") === true;
      const offersTool = body.tools?.some((tool) => tool.function?.name === SCIENT_TOOL) === true;
      const id = `chatcmpl-live-${requests.length}`;
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1790000000,
          model: "stub-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: "" }));
      if (offersTool && !toolAnswered) {
        response.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_scient_echo",
                type: "function",
                function: { name: SCIENT_TOOL, arguments: '{"text":"live"}' },
              },
            ],
          }),
        );
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ content: "SCIENT_LIVE_OK" }));
        response.write(chunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  return { server, requests };
};

/**
 * OpenAI-compatible stub that makes one tool call per step, in order, then
 * answers. A step runs only when its tool is offered, so a missing tool ends
 * the script early and the test sees which step was skipped.
 */
const makeScriptedStubModel = (
  steps: ReadonlyArray<{ readonly name: string; readonly arguments: unknown }>,
) => {
  const requests: Array<ChatRequest> = [];
  const server = NodeHttp.createServer((request, response) => {
    void readBody(request).then((raw) => {
      const body = JSON.parse(raw) as ChatRequest;
      requests.push(body);
      const answered = body.messages?.filter((message) => message.role === "tool").length ?? 0;
      const step = steps[answered];
      const offered =
        step !== undefined && body.tools?.some((tool) => tool.function?.name === step.name);
      const id = `chatcmpl-scripted-${requests.length}`;
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1790000000,
          model: "stub-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: "" }));
      if (step && offered) {
        response.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_scripted_${answered}`,
                type: "function",
                function: { name: step.name, arguments: JSON.stringify(step.arguments) },
              },
            ],
          }),
        );
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ content: "SCIENT_LIVE_OK" }));
        response.write(chunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  return { server, requests };
};

/** Streamable-HTTP MCP endpoint that checks the bearer token like Scient's. */
const makeFakeScientMcp = () => {
  const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
  let rejected = 0;
  const server = NodeHttp.createServer((request, response) => {
    void readBody(request).then((raw) => {
      if (request.headers.authorization !== TOKEN) {
        rejected += 1;
        response.writeHead(401).end();
        return;
      }
      const body = JSON.parse(raw) as {
        readonly id?: number;
        readonly method: string;
        readonly params?: { readonly arguments?: { readonly text?: string } };
      };
      calls.push({ method: body.method, params: body.params });
      if (body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
          : body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: SCIENT_TOOL,
                    description: "Echo text through Scient.",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                      required: ["text"],
                    },
                  },
                ],
              }
            : { content: [{ type: "text", text: `echo:${body.params?.arguments?.text ?? ""}` }] };
      response
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "live-session" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  return { server, calls, rejected: () => rejected };
};

const makeRoot = (label: string) => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `scient-omp-live-${label}-`)),
  );
  for (const directory of ["home", "agent", "cwd", "state"])
    NodeFS.mkdirSync(NodePath.join(root, directory));
  // OMP otherwise probes a local Ollama.
  NodeFS.writeFileSync(
    NodePath.join(root, "agent", "config.yml"),
    "retry:\n  enabled: false\ndisabledProviders:\n  - ollama\n",
  );
  return root;
};

/** A temporary root removed when the test's scope closes, after everything in it. */
const scopedRoot = (label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => makeRoot(label)),
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

const isolatedEnvironment = (root: string) =>
  Effect.map(HostProcessPlatform, (platform) =>
    ompProcessEnvironment({
      platform,
      baseEnv: {
        PATH: `/usr/bin:/bin:${NodePath.dirname(binary ?? "/usr/bin/omp")}`,
        HOME: NodePath.join(root, "home"),
        TMPDIR: NodePath.join(root, "home"),
        PI_CODING_AGENT_DIR: NodePath.join(root, "agent"),
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      },
    }),
  );

const stubConnection = (
  baseUrl: string,
  instanceId: ProviderInstanceId,
): ResolvedModelConnection => ({
  id: "stub",
  name: "Stub",
  protocol: "openai-completions",
  baseUrl,
  credentialId: "stub-credential",
  apiKey: Redacted.make("sk-test-synthetic"),
  models: [
    {
      id: "stub-model",
      modelId: "stub-model",
      name: "Stub model",
      configurationMode: "manual",
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      images: false,
      reasoning: false,
      instanceIds: [instanceId],
    },
  ],
});

/** Scient's custom-model process factory, serving one stub connection. */
const makeStubModelFactory = (
  root: string,
  baseUrl: string,
  instanceId: ProviderInstanceId,
  makeProcess?: Parameters<typeof makeOmpCustomModelsClientFactory>[3],
) =>
  Effect.gen(function* () {
    const settingsChanges = yield* Queue.unbounded<ServerSettings>();
    return yield* makeOmpCustomModelsClientFactory(
      {
        resolveCustomModels: () => Effect.succeed([stubConnection(baseUrl, instanceId)]),
        subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
      },
      instanceId,
      NodePath.join(root, "state"),
      makeProcess,
    );
  });

/**
 * Every secret a launch hands OMP, wherever it travels: `SCIENT_*` variables
 * and the bootstrap file each generated extension names. Read before OMP
 * starts, because OMP consumes the bootstrap files while it loads.
 */
const launchSecrets = (options: OmpRpcProcessOptions) => {
  const secrets = new Set<string>();
  const bootstraps: Array<string> = [];
  for (const [name, value] of Object.entries(options.env ?? {}))
    if (name.startsWith("SCIENT_") && value && !value.startsWith("#")) secrets.add(value);
  const args = options.extraArgs ?? [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") secrets.add(value);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
  };
  args.forEach((arg, index) => {
    if (args[index - 1] !== "--extension") return;
    const embedded = /\bSCIENT_BOOTSTRAP_PATH = ("(?:[^"\\]|\\.)*");/u.exec(
      NodeFS.readFileSync(arg, "utf8"),
    )?.[1];
    if (!embedded) return;
    const bootstrap = JSON.parse(embedded) as string;
    bootstraps.push(bootstrap);
    collect(JSON.parse(NodeFS.readFileSync(bootstrap, "utf8")));
  });
  return { secrets, bootstraps };
};

const toolNames = (state: unknown): ReadonlyArray<string> => {
  const tools =
    typeof state === "object" && state !== null && "dumpTools" in state
      ? (state as { readonly dumpTools?: unknown }).dumpTools
      : undefined;
  return Array.isArray(tools)
    ? tools.flatMap((tool) =>
        typeof tool === "object" && tool !== null && "name" in tool ? [String(tool.name)] : [],
      )
    : [];
};

describe.runIf(binary)("real Oh My Pi with Scient tools and awareness", () => {
  it.live(
    "loads the Scient extension beside custom models, lists its tools as essential, and appends awareness",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedRoot("delivery");
          const stub = makeStubModel();
          const stubPort = yield* listen(stub.server);
          const mcp = makeFakeScientMcp();
          const mcpPort = yield* listen(mcp.server);
          const instanceId = ProviderInstanceId.make("omp-scient-live");
          const customModels = yield* makeStubModelFactory(
            root,
            `http://127.0.0.1:${stubPort}/v1`,
            instanceId,
          );
          let client: OmpRpcProcess | undefined;
          let extensionPath: string | undefined;
          const adapter = yield* makeOmpAdapter({
            binaryPath: binary!,
            providerInstanceId: instanceId,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            environment: yield* isolatedEnvironment(root),
            makeProcess: (options) =>
              customModels(options).pipe(
                Effect.tap((started) =>
                  Effect.sync(() => {
                    client = started;
                    extensionPath = options.extraArgs?.[1];
                  }),
                ),
              ),
          });
          const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          const threadId = ThreadId.make("omp-scient-live");
          setMcpProviderSession({
            environmentId: EnvironmentId.make("environment-omp-live"),
            threadId,
            providerSessionId: "provider-omp-live",
            providerInstanceId: instanceId,
            endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
            authorizationHeader: TOKEN,
            capabilities: new Set(["skills:read"]),
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => clearMcpProviderSession(threadId)));

          yield* adapter.startSession({
            threadId,
            cwd: NodePath.join(root, "cwd"),
            runtimeMode: "full-access",
          });

          // Both explicit extensions loaded into the one process.
          const models = yield* client!.getModels();
          expect(models.models).toContainEqual(
            expect.objectContaining({ provider: customModelProviderId("stub"), id: "stub-model" }),
          );
          const state = yield* client!.command({ type: "get_state" });
          expect(state.success).toBe(true);
          const listed = toolNames(state.data);
          expect(listed).toContain(SCIENT_TOOL);
          expect(listed).toContain("read");
          expect(mcp.calls.map((call) => call.method)).toEqual([
            "initialize",
            "notifications/initialized",
            "tools/list",
          ]);

          const completed = yield* Deferred.make<ProviderRuntimeEvent>();
          yield* Stream.fromQueue(events).pipe(
            Stream.runForEach((event) =>
              event.type === "turn.completed" ? Deferred.succeed(completed, event) : Effect.void,
            ),
            Effect.forkScoped,
          );
          const model = encodeOmpModelSlug(customModelProviderId("stub"), "stub-model");
          if (!model) return yield* Effect.die(new Error("The stub model slug did not encode."));
          yield* adapter.sendTurn({
            threadId,
            input: "Call the Scient echo tool with the text live.",
            modelSelection: createModelSelection(instanceId, model),
          });
          const terminal = yield* Deferred.await(completed).pipe(Effect.timeout("90 seconds"));
          expect(terminal.payload).toMatchObject({ state: "completed" });

          // Awareness reached the model as an appended system prompt element.
          const first = stub.requests[0];
          const system = (first?.messages ?? [])
            .filter((message) => message.role === "system" || message.role === "developer")
            .map((message) => textOf(message.content))
            .join("\n");
          expect(system).toContain(SCIENT_CORE_AWARENESS.split("\n")[1]!);
          expect(system).toContain("## Scient skills");
          expect(first?.tools?.map((tool) => tool.function?.name)).toContain(SCIENT_TOOL);
          // The tool call went through the session's bearer token.
          expect(mcp.calls).toContainEqual({
            method: "tools/call",
            params: { name: SCIENT_TOOL, arguments: { text: "live" } },
          });
          expect(mcp.rejected()).toBe(0);
          const followUp = stub.requests.at(-1);
          expect(
            followUp?.messages?.some(
              (message) => message.role === "tool" && textOf(message.content).includes("echo:live"),
            ),
          ).toBe(true);

          // OMP's own state reports the replacement prompt once a turn prepared it.
          const after = yield* client!.command({ type: "get_state" });
          const reported = (after.data as { readonly systemPrompt?: unknown }).systemPrompt;
          expect(Array.isArray(reported) ? reported.at(-1) : undefined).toContain(
            "## Scient skills",
          );

          yield* adapter.stopSession(threadId);
          expect(extensionPath && NodeFS.existsSync(extensionPath)).toBe(false);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    180_000,
  );

  it.live(
    "keeps every Scient credential out of the agent's shell while tools and custom models work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedRoot("shell-env");
          // `env` shows the shell's own environment; `ps -E` shows the
          // environment OMP itself was started with, which any child can read.
          // One entry per line, because OMP clips long output lines.
          const probe = 'env; echo SCIENT_PROBE_SPLIT; ps -Eww -o command= -p $PPID | tr " " "\\n"';
          const stub = makeScriptedStubModel([
            { name: "bash", arguments: { command: `sh -c '${probe}'` } },
            { name: SCIENT_TOOL, arguments: { text: "live" } },
          ]);
          const stubPort = yield* listen(stub.server);
          const mcp = makeFakeScientMcp();
          const mcpPort = yield* listen(mcp.server);
          const instanceId = ProviderInstanceId.make("omp-scient-live-shell");
          const launches: Array<ReturnType<typeof launchSecrets>> = [];
          const customModels = yield* makeStubModelFactory(
            root,
            `http://127.0.0.1:${stubPort}/v1`,
            instanceId,
            (options) =>
              Effect.suspend(() => {
                launches.push(launchSecrets(options));
                return makeOmpRpcProcess(options);
              }),
          );
          let client: OmpRpcProcess | undefined;
          const adapter = yield* makeOmpAdapter({
            binaryPath: binary!,
            providerInstanceId: instanceId,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            environment: yield* isolatedEnvironment(root),
            makeProcess: (options) =>
              customModels(options).pipe(
                Effect.tap((started) =>
                  Effect.sync(() => {
                    client = started;
                  }),
                ),
              ),
          });
          const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          const threadId = ThreadId.make("omp-scient-live-shell");
          setMcpProviderSession({
            environmentId: EnvironmentId.make("environment-omp-live"),
            threadId,
            providerSessionId: "provider-omp-live-shell",
            providerInstanceId: instanceId,
            endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
            authorizationHeader: TOKEN,
            capabilities: new Set(["skills:read"]),
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => clearMcpProviderSession(threadId)));

          yield* adapter.startSession({
            threadId,
            cwd: NodePath.join(root, "cwd"),
            runtimeMode: "full-access",
          });
          const launch = launches[0];
          expect(launches).toHaveLength(1);
          // The session's MCP bearer, the models token and the model API key.
          expect(launch?.secrets).toContain(TOKEN);
          expect(launch?.secrets).toContain("sk-test-synthetic");
          expect(launch?.secrets.size).toBeGreaterThanOrEqual(3);
          // OMP consumed every bootstrap file while it loaded.
          for (const bootstrap of launch?.bootstraps ?? [])
            expect(NodeFS.existsSync(bootstrap)).toBe(false);
          expect((yield* client!.getModels()).models).toContainEqual(
            expect.objectContaining({ provider: customModelProviderId("stub"), id: "stub-model" }),
          );

          const completed = yield* Deferred.make<ProviderRuntimeEvent>();
          yield* Stream.fromQueue(events).pipe(
            Stream.runForEach((event) =>
              event.type === "turn.completed" ? Deferred.succeed(completed, event) : Effect.void,
            ),
            Effect.forkScoped,
          );
          const model = encodeOmpModelSlug(customModelProviderId("stub"), "stub-model");
          if (!model) return yield* Effect.die(new Error("The stub model slug did not encode."));
          yield* adapter.sendTurn({
            threadId,
            input: "Print the environment, then call the Scient echo tool.",
            modelSelection: createModelSelection(instanceId, model),
          });
          const terminal = yield* Deferred.await(completed).pipe(Effect.timeout("90 seconds"));
          expect(terminal.payload).toMatchObject({ state: "completed" });

          // The custom model's key reached the stub model, so it still works.
          expect(stub.requests.length).toBeGreaterThanOrEqual(3);
          const shell = stub.requests
            .flatMap((request) => request.messages ?? [])
            .filter((message) => message.role === "tool")
            .map((message) => textOf(message.content))
            .find((text) => text.includes("SCIENT_PROBE_SPLIT"));
          expect(shell, "the bash probe did not run").toBeDefined();
          const [shellEnvironment = "", parentEnvironment = ""] =
            shell!.split("SCIENT_PROBE_SPLIT");
          // The probe really printed both environments.
          expect(shellEnvironment).toMatch(/^PATH=/mu);
          expect(parentEnvironment).toContain("PI_CODING_AGENT_DIR=");
          const names = shellEnvironment
            .split("\n")
            .map((line) => line.split("=", 1)[0] ?? "")
            .filter((name) => /^(?:SCIENT_|T3CODE_)/u.test(name));
          expect(names).toEqual([]);
          expect(parentEnvironment).not.toMatch(/\b(?:SCIENT_|T3CODE_)[A-Z_]*=/u);
          const leaked = [...(launch?.secrets ?? [])].filter((secret) => shell!.includes(secret));
          expect(leaked).toEqual([]);

          // Scient's tool still ran through the session's bearer token.
          expect(mcp.calls).toContainEqual({
            method: "tools/call",
            params: { name: SCIENT_TOOL, arguments: { text: "live" } },
          });
          expect(mcp.rejected()).toBe(0);
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    180_000,
  );

  it.live(
    "gives an in-process subagent the Scient tools over the session's one connection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedRoot("subagent");
          // The parent delegates once; the subagent, recognizable by OMP's
          // `yield` tool, calls the Scient tool and yields; both then answer.
          const requests: Array<ChatRequest & { readonly subagent: boolean }> = [];
          const stub = NodeHttp.createServer((request, response) => {
            void readBody(request).then((raw) => {
              const body = JSON.parse(raw) as ChatRequest;
              const names = body.tools?.map((tool) => tool.function?.name) ?? [];
              const subagent = names.includes("yield");
              requests.push({ ...body, subagent });
              const results = (body.messages ?? [])
                .filter((message) => message.role === "tool")
                .map((message) => textOf(message.content));
              const id = `chatcmpl-subagent-${requests.length}`;
              const chunk = (delta: unknown, finish: string | null = null) =>
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created: 1790000000,
                  model: "stub-model",
                  choices: [{ index: 0, delta, finish_reason: finish }],
                })}\n\n`;
              const call = (name: string, args: unknown) => {
                response.write(
                  chunk({
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_subagent_${requests.length}`,
                        type: "function",
                        function: { name, arguments: JSON.stringify(args) },
                      },
                    ],
                  }),
                );
                response.write(chunk({}, "tool_calls"));
              };
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.write(chunk({ role: "assistant", content: "" }));
              if (!subagent && results.length === 0)
                call("task", {
                  i: "delegate",
                  context: "Scient live qualification.",
                  tasks: [{ agent: "task", task: "Call the Scient echo tool, then yield." }],
                });
              else if (subagent && results.length === 0 && names.includes(SCIENT_TOOL))
                call(SCIENT_TOOL, { text: "subagent" });
              else if (subagent && !results.some((text) => /yield|result/iu.test(text)))
                call("yield", { data: { echoed: results.join(" ") } });
              else {
                response.write(chunk({ content: "SCIENT_LIVE_OK" }));
                response.write(chunk({}, "stop"));
              }
              response.end("data: [DONE]\n\n");
            });
          });
          const stubPort = yield* listen(stub);
          const mcp = makeFakeScientMcp();
          const mcpPort = yield* listen(mcp.server);
          const instanceId = ProviderInstanceId.make("omp-scient-live-subagent");
          const customModels = yield* makeStubModelFactory(
            root,
            `http://127.0.0.1:${stubPort}/v1`,
            instanceId,
          );
          const adapter = yield* makeOmpAdapter({
            binaryPath: binary!,
            providerInstanceId: instanceId,
            stateDir: NodePath.join(root, "state"),
            attachmentsDir: NodePath.join(root, "attachments"),
            environment: yield* isolatedEnvironment(root),
            makeProcess: customModels,
          });
          const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkScoped,
          );
          const threadId = ThreadId.make("omp-scient-live-subagent");
          setMcpProviderSession({
            environmentId: EnvironmentId.make("environment-omp-live"),
            threadId,
            providerSessionId: "provider-omp-live-subagent",
            providerInstanceId: instanceId,
            endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
            authorizationHeader: TOKEN,
            capabilities: new Set(["skills:read"]),
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => clearMcpProviderSession(threadId)));
          yield* adapter.startSession({
            threadId,
            cwd: NodePath.join(root, "cwd"),
            runtimeMode: "full-access",
          });
          const completed = yield* Deferred.make<ProviderRuntimeEvent>();
          yield* Stream.fromQueue(events).pipe(
            Stream.runForEach((event) =>
              // Newer OMP versions may finish the parent turn before the
              // child starts. Wait for the continuation after its tool call.
              event.type === "turn.completed" &&
              mcp.calls.some((call) => call.method === "tools/call")
                ? Deferred.succeed(completed, event)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          const model = encodeOmpModelSlug(customModelProviderId("stub"), "stub-model");
          if (!model) return yield* Effect.die(new Error("The stub model slug did not encode."));
          yield* adapter.sendTurn({
            threadId,
            input: "Delegate to a subagent.",
            modelSelection: createModelSelection(instanceId, model),
          });
          const terminal = yield* Deferred.await(completed).pipe(Effect.timeout("120 seconds"));
          expect(terminal.payload).toMatchObject({ state: "completed" });

          // The subagent ran on the custom model and saw the Scient tool...
          const subagent = requests.filter((request) => request.subagent);
          expect(
            subagent.length,
            requests
              .flatMap((request) => request.messages ?? [])
              .filter((message) => message.role === "tool")
              .map((message) => textOf(message.content))
              .join("\n"),
          ).toBeGreaterThan(0);
          expect(subagent[0]?.tools?.map((tool) => tool.function?.name)).toContain(SCIENT_TOOL);
          // ...and its call went through the session's bearer, over the MCP
          // connection the parent opened: one initialize, one catalog.
          expect(mcp.calls).toContainEqual({
            method: "tools/call",
            params: { name: SCIENT_TOOL, arguments: { text: "subagent" } },
          });
          expect(mcp.calls.filter((call) => call.method === "initialize")).toHaveLength(1);
          expect(mcp.calls.filter((call) => call.method === "tools/list")).toHaveLength(1);
          expect(mcp.rejected()).toBe(0);
          yield* adapter.stopSession(threadId);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    180_000,
  );

  it.live(
    "hides the same tools without an essential load mode",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* scopedRoot("discoverable");
          const mcp = makeFakeScientMcp();
          const mcpPort = yield* listen(mcp.server);
          const essential = 'loadMode: "essential",';
          const extension = yield* writeOmpExtensionFiles({
            directory: root,
            name: "discoverable-extension",
            source: (bootstrapPath) => {
              const source = ompScientExtensionSource(bootstrapPath);
              expect(source.split(essential)).toHaveLength(2);
              return source.replace(essential, "");
            },
            bootstrap: {
              endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
              authorization: TOKEN,
              awareness: "",
            },
          });
          // OMP refuses to start without any model; this one is never called.
          const customModels = yield* makeStubModelFactory(
            root,
            "http://127.0.0.1:9/v1",
            ProviderInstanceId.make("omp-scient-live-control"),
          );
          const process = yield* customModels({
            command: binary!,
            cwd: NodePath.join(root, "cwd"),
            env: yield* isolatedEnvironment(root),
            sessionDir: NodePath.join(root, "state"),
            extraArgs: ["--extension", extension.extensionPath],
          });
          yield* process.ready;
          const state = yield* process.command({ type: "get_state" });
          // The extension did load and register the tool...
          expect(mcp.calls.map((call) => call.method)).toContain("tools/list");
          // ...but OMP keeps a discoverable tool out of the top-level list.
          expect(toolNames(state.data)).not.toContain(SCIENT_TOOL);
          expect(toolNames(state.data)).toContain("read");
          yield* process.shutdown;
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    120_000,
  );
});

import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId, EnvironmentId, ProviderSessionId } from "@t3tools/contracts";
import { describe, it, assert } from "@effect/vitest";
import { HostProcessPlatform, HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  DEFAULT_CODEX_SETTINGS,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
} from "./CodexAdapterV2.replay.testkit.ts";

describe("CodexAdapterV2 file change approvals", () => {
  it("uses nonblank reasons before sorted file operations and renamed paths", () => {
    const fileChanges = {
      "/tmp/removed.md": { type: "delete" as const, content: "gone" },
      "/tmp/added.ts": { type: "add" as const, content: "export {};" },
      "/tmp/moved.ts": {
        type: "update" as const,
        unified_diff: "@@",
        move_path: "/tmp/renamed.ts",
      },
    };
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: "  Update configuration. ",
        fileChanges,
      }),
      "Update configuration.",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", fileChanges }),
      "add /tmp/added.ts\nupdate /tmp/moved.ts -> /tmp/renamed.ts\ndelete /tmp/removed.md",
    );
  });

  it("falls back to a nonblank grant root and omits empty details", () => {
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", grantRoot: " /workspace " }),
      "/workspace",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges: {}, grantRoot: "/workspace" }),
      "/workspace",
    );
    assert.isUndefined(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: " ",
        grantRoot: " ",
        fileChanges: {},
      }),
    );
  });

  it("bounds large patch descriptions without losing the remaining count", () => {
    const fileChanges = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `/tmp/file-${String(index).padStart(2, "0")}.ts`,
        { type: "add" as const, content: "" },
      ]),
    );
    const detail = CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges });
    assert.equal(detail?.split("\n").length, 21);
    assert.isTrue(detail?.startsWith("add /tmp/file-00.ts") ?? false);
    assert.isTrue(detail?.endsWith("+5 more") ?? false);
    assert.notInclude(detail, "file-20.ts");
  });
});

describe("CodexAdapterV2 runtime policy", () => {
  it.effect("derives concrete Codex turn policies from every T3 runtime mode", () =>
    Effect.gen(function* () {
      const build = (
        runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
      ) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode,
            interactionMode: "default",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

      const approvalRequired = yield* build("approval-required");
      const autoAcceptEdits = yield* build("auto-accept-edits");
      const auto = yield* build("auto");
      const fullAccess = yield* build("full-access");

      assert.equal(approvalRequired.approvalPolicy, "untrusted");
      assert.equal(approvalRequired.approvalsReviewer, "user");
      assert.equal(approvalRequired.sandboxPolicy?.type, "readOnly");
      assert.equal(autoAcceptEdits.approvalPolicy, "on-request");
      assert.equal(autoAcceptEdits.approvalsReviewer, "user");
      assert.equal(autoAcceptEdits.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(auto.approvalPolicy, "on-request");
      assert.equal(auto.approvalsReviewer, "auto_review");
      assert.equal(auto.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(fullAccess.approvalPolicy, "never");
      assert.equal(fullAccess.approvalsReviewer, "user");
      assert.equal(fullAccess.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("preserves explicit Codex turn policy overrides", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-override",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "readOnly",
          },
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      });

      assert.equal(params.approvalPolicy, "on-request");
      assert.equal(params.sandboxPolicy?.type, "readOnly");
    }),
  );

  it.effect("adds default-mode developer instructions when the T3 MCP server is attached", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-orchestration-instructions",
        codexInput: [{ type: "text", text: "delegate this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: true,
      });

      assert.equal(params.collaborationMode?.mode, "default");
      assert.include(
        params.additionalContext?.t3_code_orchestration?.value ?? "",
        "Use `delegate_task`",
      );
      assert.include(
        params.additionalContext?.t3_code_orchestration?.value ?? "",
        "structured object, never as JSON text",
      );
    }),
  );

  it.effect("omits default-mode collaboration settings without the T3 MCP server", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-default-without-t3-mcp",
        codexInput: [{ type: "text", text: "implement this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: false,
      });

      assert.isUndefined(params.collaborationMode);
    }),
  );

  it.effect("adds T3 plan-mode developer instructions when the T3 MCP server is attached", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-plan-with-t3-mcp",
        codexInput: [{ type: "text", text: "plan this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: true,
      });

      assert.equal(params.collaborationMode?.mode, "plan");
      assert.include(
        params.collaborationMode?.settings.developer_instructions ?? "",
        "request_user_input",
      );
      assert.include(params.additionalContext?.scient_awareness?.value ?? "", "preview_status");
    }),
  );

  it.effect("keeps Codex in plan mode without referencing unavailable T3 MCP tools", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-plan-without-t3-mcp",
        codexInput: [{ type: "text", text: "plan this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasT3Mcp: false,
      });

      assert.equal(params.collaborationMode?.mode, "plan");
      assert.notProperty(params.collaborationMode?.settings, "developer_instructions");
    }),
  );

  it.effect("compiles per-turn Codex model options and cwd from their owning inputs", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: "/workspace/model-options",
          reasoningEffort: "low",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "priority" },
          ],
        },
      });

      assert.equal(params.model, "gpt-5.4");
      assert.equal(params.effort, "xhigh");
      assert.equal(params.serviceTier, "priority");
      assert.equal(params.cwd, "/workspace/model-options");
      assert.equal(params.collaborationMode?.settings.model, "gpt-5.4");
      assert.equal(params.collaborationMode?.settings.reasoning_effort, "xhigh");

      // ChatGPT token sharing rejects service tiers, so managed sessions drop a stale pick.
      const managed = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/model-options",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [{ id: "serviceTier", value: "priority" }],
        },
        omitServiceTier: true,
      });
      assert.equal(managed.serviceTier, undefined);
    }),
  );
});

describe("CodexAdapterV2 process spawning", () => {
  it("injects cwd, model, and MCP authorization into thread-scoped params", () => {
    const threadId = ThreadId.make("thread-codex-mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-codex-mcp"),
      threadId,
      providerSessionId: "mcp-session-codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      capabilities: new Set(["preview"] as const),
    });

    try {
      assert.deepEqual(
        CodexAdapterV2.codexThreadRuntimeParams({
          threadId,
          modelSelection: { model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace/thread-codex-mcp",
          },
        }),
        {
          cwd: "/workspace/thread-codex-mcp",
          model: "gpt-5.4",
          config: {
            "tools.update_plan.enabled": true,
            mcp_servers: {
              scient: {
                url: "http://127.0.0.1:43123/mcp",
                http_headers: {
                  Authorization: "Bearer secret-codex-token",
                },
              },
            },
          },
        },
      );
      assert.deepEqual(CodexAdapterV2.codexThreadRuntimeParams({ threadId, configureMcp: false }), {
        config: CodexAdapterV2.CODEX_THREAD_CONFIG,
      });
      assert.equal(
        McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId,
        "mcp-session-codex",
      );
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it.effect("resolves Windows command shims through the shared spawn policy", () =>
    Effect.gen(function* () {
      const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
        command: "codex",
        args: ["app-server", "argument with spaces"],
        cwd: "C:\\workspace",
        env: { CUSTOM: "1" },
        extendEnv: true,
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, '^"C:\\npm\\codex.cmd^"');
      assert.deepEqual(command.args, ['^"app-server^"', '^"argument^ with^ spaces^"']);
      assert.equal(command.options.shell, true);
      assert.equal(command.options.cwd, "C:\\workspace");
      assert.deepEqual(command.options.env, { CUSTOM: "1" });
      assert.equal(command.options.extendEnv, true);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "C:\\Windows\\System32",
        HOST_ONLY: "1",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, environment) => {
        assert.equal(environment.HOST_ONLY, "1");
        assert.equal(environment.CUSTOM, "1");
        return "C:\\npm\\codex.cmd";
      }),
    ),
  );

  it.effect("uses direct execution for native executables", () =>
    Effect.gen(function* () {
      const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
        command: "codex.exe",
        args: ["app-server"],
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, "C:\\bin\\codex.exe");
      assert.deepEqual(command.args, ["app-server"]);
      assert.equal(command.options.shell, false);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\bin\\codex.exe"),
    ),
  );

  it.effect("launches the app-server with the configured launch arguments", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args);
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory.pipe(
        Effect.provide(CodexAdapterV2.layerAppServerClientFactory),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      );
      const open = (environment: NodeJS.ProcessEnv) =>
        factory
          .open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("thread-launch-args"),
            providerSessionId: ProviderSessionId.make("provider-session-launch-args"),
            runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            }),
            settings: {
              ...DEFAULT_CODEX_SETTINGS,
              launchArgs: " --strict-config -c model_reasoning_summary=detailed ",
            },
            environment,
          })
          .pipe(Effect.scoped, Effect.exit);

      yield* open({});
      yield* open({ T3CODE_CODEX_LAUNCH_ARGS: " --enable env-feature " });

      assert.deepEqual(spawnedArgs, [
        ["app-server", "--strict-config", "-c", "model_reasoning_summary=detailed"],
        ["app-server", "--enable", "env-feature"],
      ]);
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

  it.effect("expands ~ in the configured binary path before spawning", () =>
    Effect.gen(function* () {
      const spawnedCommands: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedCommands.push(command.command);
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const path = yield* Path.Path;
      const adapter = yield* CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: { ...DEFAULT_CODEX_SETTINGS, binaryPath: "~/bin/codex" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CodexAdapterV2.layerAppServerClientFactory,
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-binary-home-" }),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      );

      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-binary-home"),
          providerSessionId: ProviderSessionId.make("provider-session-binary-home"),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        })
        .pipe(Effect.scoped, Effect.exit);

      assert.deepEqual(spawnedCommands, [path.join(NodeOS.homedir(), "bin", "codex")]);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      Effect.provideService(HostProcessPlatform, "linux"),
    ),
  );
});

describe("CodexAdapterV2 skill mentions", () => {
  it("sends currency-sigil skill mentions as the $ mention Codex parses", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["€review do it", "$review do it"],
      ["£ship", "$ship"],
      ["please ¥review this diff", "please $review this diff"],
      ["first line\n₹ship it", "first line\n$ship it"],
      ["𑿝review then €2spec", "$review then $2spec"],
      ["$review", "$review"],
      ["costs €20", "costs €20"],
      ["€5k", "€5k"],
      ["budget €100M or €1e6", "budget €100M or €1e6"],
      ["5€review", "5€review"],
    ];
    for (const [text, expected] of cases) {
      assert.equal(CodexAdapterV2.codexSkillMentionText(text), expected, text);
    }
  });
});

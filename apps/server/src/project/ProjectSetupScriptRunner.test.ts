import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect } from "@effect/vitest";
import { type OrchestrationProject, type TerminalEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectServiceLayer = (project: OrchestrationProject) =>
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
  });

type TerminalOverrides = Pick<TerminalManager.TerminalManager["Service"], "open" | "write"> &
  Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe" | "closeIdle">>;

const makeTerminalManagerLayer = (overrides: TerminalOverrides) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    attachStream: () => Effect.die(new Error("unused")),
    observeStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    hasRunningSessionsForThread: () => Effect.succeed(false),
    closeIdle: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
    ...overrides,
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: TerminalOverrides,
  settings = ServerSettings.layerTest(),
) =>
  ProjectSetupScriptRunner.layer.pipe(
    Layer.provideMerge(makeProjectServiceLayer(project)),
    Layer.provideMerge(makeTerminalManagerLayer(terminal)),
    Layer.provide(settings),
    Layer.provideMerge(NodeCrypto.layer),
  );

describe("ProjectSetupScriptRunner", () => {
  it.effect("runs the inherited machine setup action in the checkout's worktree", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-default-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });
      expect(result).toMatchObject({ status: "started", scriptId: "default-setup" });
      expect(open).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        env: {
          T3CODE_PROJECT_ROOT: "/repo/project",
          T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          COLORTERM: "",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      });
      expect(write).toHaveBeenCalledWith({
        threadId: "thread-1",
        terminalId: "setup-default-setup",
        data: "npm install\r",
      });
    }).pipe(
      Effect.provide(
        testLayer(
          makeProject([]),
          { open, write },
          ServerSettings.layerTest({
            defaultProjectScripts: [
              {
                id: "default-setup",
                name: "Setup",
                command: "npm install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ],
          }),
        ),
      ),
    );
  });

  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        expect(result).toEqual({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "bun install",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          async: true,
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
            COLORTERM: "",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        });
        expect(write).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          data: "bun install\r",
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  it.effect(
    "wraps the command with a completion sentinel and resolves the exit code from terminal output",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const writes: string[] = [];
      const write = vi.fn((input: { data: string }) =>
        Effect.sync(() => void writes.push(input.data)),
      );
      let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
      const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
        listener = next;
        return Effect.succeed(() => {
          listener = null;
        });
      });
      const closeIdle = vi.fn(() => Effect.void);
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const emit = (data: string) =>
        Effect.suspend(() =>
          listener
            ? listener({ threadId: "thread-1", terminalId: "setup-setup", type: "output", data })
            : Effect.void,
        );

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const seen: string[] = [];
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {
            onOutputLine: (line) => Effect.sync(() => void seen.push(line)),
          },
        });
        expect(result.status).toBe("started");
        if (result.status !== "started") return;
        expect(result.completion).toBeDefined();

        // The subscription is attached before the command is written.
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(1);
        // The block closes on its own line so a trailing comment in the
        // command cannot swallow the sentinel, and the sentinel carries a
        // per-run token so script output cannot spoof it.
        const written = writes[0] ?? "";
        const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
        expect(sentinel).toBeDefined();
        expect(written).toBe(`( bun install\r); printf '\\n${sentinel}%s\\n' "$?"\r`);

        // Output arrives in chunks; partial lines are buffered until a newline,
        // control sequences are stripped, and the echoed wrapper is hidden.
        yield* emit(`( bun install\r\n> ); printf '\\n${sentinel}%s\\n' "$?"\r\n`);
        yield* emit("\u001b[32mResolving");
        yield* emit(" deps\u001b[0m\r\n");
        // Progress redraws separated by bare carriage returns are their own lines.
        yield* emit("Progress: 1/3\rProgress: 2/3\rProgress: 3/3\r\nDone in 2s\r\n");
        // A spoofed sentinel from the script itself must not settle completion.
        yield* emit("__T3_SETUP_DONE__:0\r\n");
        yield* emit(`__T3_SETUP_DONE___${"0".repeat(32)}:0\r\n`);
        yield* emit(`${sentinel}3\r\n$ `);

        const completion = yield* result.completion!;
        expect(completion.exitCode).toBe(3);
        expect(seen).toEqual([
          "Resolving deps",
          "Progress: 1/3",
          "Progress: 2/3",
          "Progress: 3/3",
          "Done in 2s",
          "__T3_SETUP_DONE__:0",
          `__T3_SETUP_DONE___${"0".repeat(32)}:0`,
        ]);
        // The subscription is torn down once the sentinel arrives.
        expect(listener).toBeNull();
        // A failed run keeps its shell open for a look.
        expect(closeIdle).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
      );
    },
  );

  it.effect("closes the idle setup shell after a clean exit", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    let written = "";
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void (written = input.data)),
    );
    let listener: ((event: TerminalEvent) => Effect.Effect<void>) | null = null;
    const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
      listener = next;
      return Effect.succeed(() => {
        listener = null;
      });
    });
    const closeIdle = vi.fn(() => Effect.void);
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      if (result.status !== "started" || !result.completion) {
        return yield* Effect.die("expected an observed setup run");
      }
      const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
      yield* listener!({
        threadId: "thread-1",
        terminalId: "setup-setup",
        type: "output",
        data: `${sentinel}0\r\n$ `,
      });

      expect((yield* result.completion).exitCode).toBe(0);
      expect(closeIdle).toHaveBeenCalledWith({ threadId: "thread-1", terminalId: "setup-setup" });
    }).pipe(
      Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
    );
  });

  it.effect("unsubscribes from terminal output when the command cannot be written", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(() =>
      Effect.fail(
        new TerminalManager.TerminalCwdStatError({ cwd: "/repo/worktrees/a", cause: {} }),
      ),
    );
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => Effect.succeed(unsubscribe));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
          observeCompletion: {},
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer(project, { open, write, subscribe })));
  });

  it.effect.each([
    {
      shell: "/usr/bin/fish",
      expected:
        /^begin\rbun install\rend; printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' \$status\r$/,
    },
    {
      shell: "/bin/bash",
      expected: /^\( bun install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
    },
  ])("wraps the command for the $shell syntax", ({ shell, expected }) => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const writes: string[] = [];
    const write = vi.fn((input: { data: string }) =>
      Effect.sync(() => void writes.push(input.data)),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(expected);
    }).pipe(
      Effect.provide(testLayer(project, { open, write })),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { SHELL: shell }),
    );
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });
});

it.effect.each(
  (["project", "settings", "terminal"] as const).map((stage) => ({
    caseTitle: `declines a settle command resumed during ${stage} preparation`,
    stage,
  })),
)("$caseTitle", ({ stage }) =>
  Effect.gen(function* () {
    const paused = yield* Deferred.make<void>();
    const continuePreparation = yield* Deferred.make<void>();
    const settled = yield* Ref.make(true);
    const lock = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const writes: string[] = [];
    const closed: string[] = [];
    const pause = Deferred.succeed(paused, undefined).pipe(
      Effect.andThen(Deferred.await(continuePreparation)),
    );
    const project = makeProject([
      {
        id: "cleanup",
        name: "Cleanup",
        command: "cleanup-worktree",
        icon: "configure",
        runOnSettle: true,
        runOnWorktreeCreate: false,
      },
    ]);
    const baseSettings = yield* ServerSettings.ServerSettingsService;
    const projectLayer = Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        (stage === "project" ? pause : Effect.void).pipe(Effect.as(Option.some(project))),
    });
    const settingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
      ...baseSettings,
      getSettings: (stage === "settings" ? pause : Effect.void).pipe(
        Effect.andThen(baseSettings.getSettings),
      ),
    });
    const terminalLayer = makeTerminalManagerLayer({
      open: () =>
        (stage === "terminal" ? pause : Effect.void).pipe(
          Effect.as({
            threadId: "thread-1",
            terminalId: "settle-fixture",
            cwd: "/repo/worktree",
            worktreePath: "/repo/worktree",
            status: "running" as const,
            pid: 123,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "settle-fixture",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
        ),
      write: (input) =>
        Effect.sync(() => {
          writes.push(input.data);
        }),
      closeIdle: (input) =>
        Effect.sync(() => {
          closed.push(input.terminalId!);
        }),
    });
    const operation = ProjectSetupScriptRunner.ProjectSetupScriptRunner.pipe(
      Effect.flatMap((runner) =>
        runner.runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktree",
          preferredTerminalId: "settle-fixture",
          trigger: "settle",
          startCommand: (write) =>
            lock.withLock(
              ThreadId.make("thread-1"),
              Ref.get(settled).pipe(
                Effect.flatMap((current) =>
                  current ? write.pipe(Effect.as(true)) : Effect.succeed(false),
                ),
              ),
            ),
        }),
      ),
      Effect.provide(
        ProjectSetupScriptRunner.layer.pipe(
          Layer.provide(
            Layer.mergeAll(projectLayer, settingsLayer, terminalLayer, NodeCrypto.layer),
          ),
        ),
      ),
    );
    const pending = yield* operation.pipe(Effect.forkScoped);
    yield* Deferred.await(paused);
    // Resume uses the same lifecycle owner and commits while preparation waits.
    yield* lock.withLock(ThreadId.make("thread-1"), Ref.set(settled, false));
    yield* Deferred.succeed(continuePreparation, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ status: "superseded" });
    expect(writes).toEqual([]);
    expect(closed).toEqual(["settle-fixture"]);
  }).pipe(
    Effect.provide(Layer.merge(ServerSettings.layerTest(), ThreadCommandExecutor.layer)),
    Effect.scoped,
  ),
);

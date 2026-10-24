import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it, vi } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect } from "@effect/vitest";
import { type OrchestrationProject, type TerminalEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

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
    resyncStream: () => Effect.die(new Error("unused")),
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
  // regression: b92ebce0ad fix(terminal): keep project script commands out of shell history (#13903)
  // (the leading space on the written command).
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
          data: " bun install\r",
        });
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  // regression: 1a0c915c41 fix(terminal): settling a thread closes its idle shells (#13673)
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

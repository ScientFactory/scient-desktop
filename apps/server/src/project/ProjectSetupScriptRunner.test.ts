import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { expect } from "@effect/vitest";
import { type OrchestrationProject } from "@t3tools/contracts";
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

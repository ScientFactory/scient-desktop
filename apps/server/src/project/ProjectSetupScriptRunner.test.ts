import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  ProjectId,
  TerminalNotRunningError,
  ThreadId,
  type OrchestrationProject,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = "thread-1";
const terminalId = "setup-setup";
const event = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.fn(function* (options: {
  readonly history?: string;
  readonly opening?: Deferred.Deferred<void>;
  readonly shell?: string | null;
}) {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const outputLines = yield* Queue.unbounded<string>();
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: () =>
      (options.opening
        ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void
      ).pipe(Effect.as(openSnapshot(options.history ?? ""))),
    getShell: () =>
      options.shell === null
        ? Effect.fail(new TerminalNotRunningError({ threadId, terminalId }))
        : Effect.succeed(options.shell ?? "/bin/zsh"),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) => Queue.offer(writes, input.data).pipe(Effect.asVoid),
    closeIdle: () => Effect.void,
  });
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );
  const start = runner.runForThread({
    threadId,
    worktreePath: "/repo/.t3/worktrees/feature",
    observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) },
    project: {
      id: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "vp i",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    },
  });
  const emit = (terminalEvent: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(terminalEvent), { discard: true });
  return { start, listeners, writes, outputLines, emit };
});

const setup = Effect.fn(function* (
  options: {
    readonly history?: string;
    readonly shell?: string | null;
  } = {},
) {
  const harness = yield* makeHarness(options);
  const result = yield* harness.start;
  const completion = result.status === "started" ? result.completion : undefined;
  if (!completion) return yield* Effect.die("setup did not start an observed run");
  return { ...harness, result, completion };
});

describe("ProjectSetupScriptRunner", () => {
  it.effect("writes immediately when the spawned fallback is PowerShell", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup({
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      });
      expect(yield* Queue.take(writes)).toContain("$global:LASTEXITCODE");
    }),
  );

  it.effect("shows a startup prompt and types only once the line editor starts", () =>
    Effect.gen(function* () {
      const { result, writes, outputLines, emit } = yield* setup();
      expect(result).toMatchObject({ status: "started", terminalId });

      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      expect(yield* Queue.takeAll(outputLines)).toEqual(["Missing Node.", "Install it? [y/N]:"]);

      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?2004h" });
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("types into a quiet shell that has no line editor", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup();
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("ignores line editor state restored from an earlier shell", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup({ history: "old run\r\n% \x1b[?2004h" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );

  it.effect("forgets a busy startup child when the shell restarts", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup();
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "restarted", snapshot: openSnapshot("") });
      // The restart lands inside a quiet window, so the next full window decides.
      yield* TestClock.adjust("6 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("drops its terminal listeners when cancelled while the terminal opens", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const { start, listeners } = yield* makeHarness({ opening });
      const fiber = yield* Effect.forkChild(start);
      yield* Deferred.await(opening);
      expect(listeners.size).toBe(2);
      yield* Fiber.interrupt(fiber);
      expect(listeners.size).toBe(0);
    }),
  );

  it.effect.each([false, true])(
    "does not type into a shell that exits during startup (before shell lookup: %s)",
    (beforeShellLookup) =>
      Effect.gen(function* () {
        const { completion, writes, emit, listeners } = yield* setup(
          beforeShellLookup ? { shell: null } : {},
        );
        if (!beforeShellLookup) {
          yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
        }
        expect(yield* completion).toMatchObject({ exitCode: null });
        yield* TestClock.adjust("1 minute");
        expect(yield* Queue.size(writes)).toBe(0);
        expect(listeners.size).toBe(0);
      }),
  );
});

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
  Partial<Pick<TerminalManager.TerminalManager["Service"], "subscribe" | "closeIdle" | "getShell">>;

const makeTerminalManagerLayer = (overrides: TerminalOverrides) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    attachStream: () => Effect.die(new Error("unused")),
    attachOutputStream: () => Stream.die(new Error("unused")),
    observeStream: () => Effect.die(new Error("unused")),
    resyncStream: () => Effect.die(new Error("unused")),
    getShell: () => Effect.succeed("/bin/zsh"),
    resize: () => Effect.void,
    clear: () => Effect.void,
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
    // SCIENT-FORK:START — the runner consults the thread's projection before scripting it.
    Layer.provideMerge(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThreadShell: () => Effect.succeed(null) }),
    ),
    // SCIENT-FORK:END
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
        // The command is typed once the quiet shell is ready.
        yield* TestClock.adjust("3 seconds");

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
    const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
      listeners.add(next);
      return Effect.succeed(() => {
        listeners.delete(next);
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
      yield* TestClock.adjust("3 seconds");
      const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
      yield* Effect.forEach(
        [...listeners],
        (listener) =>
          listener({
            threadId: "thread-1",
            terminalId: "setup-setup",
            type: "output",
            data: `${sentinel}0\r\n$ `,
          }),
        { discard: true },
      );

      expect((yield* result.completion).exitCode).toBe(0);
      expect(closeIdle).toHaveBeenCalledWith({ threadId: "thread-1", terminalId: "setup-setup" });
    }).pipe(Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })));
  });

  // regression: 9f40b2f563 feat(settings): add shared project defaults and scoped overrides (#9754)

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
      yield* TestClock.adjust("3 seconds");
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
        data: " npm install\r",
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

  // regression: b0a3a50448 [codex] Refactor project and workspace Effect services (#3190)

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

  // regression: 73b206f4bf feat(web): show each worktree setup step and let users cancel it (#11372)

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
      const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
      const subscribe = vi.fn((next: (event: TerminalEvent) => Effect.Effect<void>) => {
        listeners.add(next);
        return Effect.succeed(() => {
          listeners.delete(next);
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
        Effect.forEach(
          [...listeners],
          (listener) =>
            listener({ threadId: "thread-1", terminalId: "setup-setup", type: "output", data }),
          { discard: true },
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

        // The completion and shell-readiness listeners attach before the command is written.
        expect(subscribe).toHaveBeenCalledTimes(2);
        expect(writes).toHaveLength(0);
        yield* TestClock.adjust("3 seconds");
        expect(writes).toHaveLength(1);
        // The block closes on its own line so a trailing comment in the
        // command cannot swallow the sentinel, and the sentinel carries a
        // per-run token so script output cannot spoof it.
        const written = writes[0] ?? "";
        const sentinel = /__T3_SETUP_DONE___[0-9a-f]{32}:/.exec(written)?.[0];
        expect(sentinel).toBeDefined();
        expect(written).toBe(` ( bun install\r); printf '\\n${sentinel}%s\\n' "$?"\r`);

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
        // The subscriptions are torn down once the sentinel arrives.
        expect(listeners.size).toBe(0);
        // A failed run keeps its shell open for a look.
        expect(closeIdle).not.toHaveBeenCalled();
      }).pipe(Effect.provide(testLayer(project, { open, write, subscribe, closeIdle })));
    },
  );

  // regression: 73b206f4bf feat(web): show each worktree setup step and let users cancel it (#11372)

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
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectCwd: "/repo/project",
        worktreePath: "/repo/worktrees/a",
        observeCompletion: {},
      });
      if (result.status !== "started" || !result.completion) {
        return yield* Effect.die("expected an observed setup run");
      }
      // The command is written after startup, so a failed write ends the run without an exit code.
      yield* TestClock.adjust("3 seconds");
      expect((yield* result.completion).exitCode).toBeNull();
      expect(unsubscribe).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(testLayer(project, { open, write, subscribe })));
  });

  // regression: 73b206f4bf feat(web): show each worktree setup step and let users cancel it (#11372)

  it.effect.each([
    {
      shell: "/usr/bin/fish",
      expected:
        /^ begin\rbun install\rend; printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' \$status\r$/,
    },
    {
      shell: "/bin/bash",
      expected: /^ \( bun install\r\); printf '\\n__T3_SETUP_DONE___[0-9a-f]{32}:%s\\n' "\$\?"\r$/,
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
      yield* TestClock.adjust("3 seconds");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(expected);
    }).pipe(
      Effect.provide(testLayer(project, { open, write, getShell: () => Effect.succeed(shell) })),
    );
  });

  // regression: 833c8ab7c6 [codex] Remove project setup error constructor wrappers (#3329)

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
  (["project", "settings", "terminal", "shell readiness"] as const).map((stage) => ({
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
    // Built in the test's scope, which also owns the delayed command write.
    const runner = yield* ProjectSetupScriptRunner.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          projectLayer,
          settingsLayer,
          terminalLayer,
          // SCIENT-FORK: the runner consults the thread's projection before scripting it.
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () => Effect.succeed(null),
          }),
          NodeCrypto.layer,
        ),
      ),
    );
    const operation = runner.runForThread({
      threadId: "thread-1",
      projectId: "project-1",
      worktreePath: "/repo/worktree",
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
    });
    // Resume uses the same lifecycle owner and commits while preparation waits.
    const resume = lock.withLock(ThreadId.make("thread-1"), Ref.set(settled, false));
    const pending = yield* operation.pipe(Effect.forkScoped);
    if (stage !== "shell readiness") {
      yield* Deferred.await(paused);
      yield* resume;
      yield* Deferred.succeed(continuePreparation, undefined);
    }
    expect(yield* Fiber.join(pending)).toMatchObject({ status: "started" });
    if (stage === "shell readiness") yield* resume;
    // The command is offered only once the shell is ready.
    yield* TestClock.adjust("3 seconds");
    expect(writes).toEqual([]);
    expect(closed).toEqual([expect.stringMatching(/^settle-/)]);
  }).pipe(
    Effect.provide(Layer.merge(ServerSettings.layerTest(), ThreadCommandExecutor.layer)),
    Effect.scoped,
  ),
);

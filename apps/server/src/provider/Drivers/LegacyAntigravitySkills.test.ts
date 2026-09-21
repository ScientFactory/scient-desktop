import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverAntigravitySkills } from "./LegacyAntigravitySkills.ts";

const nativePayload = (skills: ReadonlyArray<unknown>) =>
  JSON.stringify({
    status: "SUCCESS",
    command: { name: "skills", data: { skills } },
  });

const makeSpawner = (
  stdout: string,
  exitCode = 0,
  commands?: Array<{ readonly args: ReadonlyArray<string>; readonly cwd?: string }>,
) =>
  ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") {
      commands?.push({
        args: command.args,
        ...(command.options.cwd ? { cwd: command.options.cwd } : {}),
      });
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

it.layer(NodeServices.layer)("discoverAntigravitySkills", (it) => {
  it.effect("uses the native global catalog including built-in and plugin skills", () => {
    const commands: Array<{ readonly args: ReadonlyArray<string>; readonly cwd?: string }> = [];
    return Effect.gen(function* () {
      const skills = yield* discoverAntigravitySkills(
        { binaryPath: "agy" },
        { HOME: "/home/test" },
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(
            nativePayload([
              {
                name: "guide",
                description: "Provider guide.",
                path: "/home/test/.gemini/antigravity-cli/builtin/skills/guide/SKILL.md",
                builtin: true,
                model_invocable: true,
              },
              {
                name: "science:literature",
                description: "Search literature.",
                path: "/home/test/.gemini/config/plugins/science/skills/literature/SKILL.md",
                plugin: "science",
                builtin: false,
                model_invocable: false,
              },
              {
                name: "review",
                path: "/home/test/.gemini/config/skills/review/SKILL.md",
                builtin: false,
                model_invocable: true,
              },
              {
                name: "project-only",
                path: "/workspace/.agents/skills/project-only/SKILL.md",
                builtin: false,
              },
            ]),
            0,
            commands,
          ),
        ),
      );

      assert.deepEqual(skills, [
        {
          name: "guide",
          description: "Provider guide.",
          path: "/home/test/.gemini/antigravity-cli/builtin/skills/guide/SKILL.md",
          scope: "app",
          enabled: true,
        },
        {
          name: "review",
          path: "/home/test/.gemini/config/skills/review/SKILL.md",
          scope: "user",
          enabled: true,
        },
        {
          name: "science:literature",
          description: "Search literature.",
          path: "/home/test/.gemini/config/plugins/science/skills/literature/SKILL.md",
          scope: "plugin",
          enabled: true,
          userInvocationOnly: true,
        },
      ]);
      assert.deepEqual(commands[0]?.args, [
        "-p",
        "/skills",
        "--output-format",
        "json",
        "--print-timeout",
        "10s",
      ]);
    });
  });

  it.effect("adds workspace skills only to contextual discovery", () => {
    const commands: Array<{ readonly args: ReadonlyArray<string>; readonly cwd?: string }> = [];
    return Effect.gen(function* () {
      const skills = yield* discoverAntigravitySkills(
        { binaryPath: "agy" },
        { HOME: "/home/test" },
        "/workspace",
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner(
            nativePayload([
              {
                name: "project-review",
                path: "/workspace/.agents/skills/project-review/SKILL.md",
                builtin: false,
              },
              {
                name: "outside",
                path: "/another-workspace/.agents/skills/outside/SKILL.md",
                builtin: false,
              },
            ]),
            0,
            commands,
          ),
        ),
      );

      assert.deepEqual(skills, [
        {
          name: "project-review",
          path: "/workspace/.agents/skills/project-review/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ]);
      assert.equal(commands[0]?.cwd, "/workspace");
    });
  });

  it.effect("rejects malformed output and failed native probes", () =>
    Effect.gen(function* () {
      for (const [stdout, exitCode, stage] of [
        ["not json", 0, "decode"],
        [nativePayload([]), 1, "exit"],
        ["x".repeat(2_000_001), 0, "output-limit"],
      ] as const) {
        const result = yield* discoverAntigravitySkills({ binaryPath: "agy" }, {}).pipe(
          Effect.result,
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            makeSpawner(stdout, exitCode),
          ),
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.stage, stage);
      }
    }),
  );
});

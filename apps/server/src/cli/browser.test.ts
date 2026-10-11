import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { resolveBrowserSetupBaseDir } from "./browser.ts";

it.layer(NodeServices.layer)("browser setup profiles", (it) => {
  it.effect(
    "keeps explicit Scient profiles ahead of environment defaults and ignores ambient T3 state",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve("/synthetic-user");
        const flag = path.join(home, "flag profile");
        const scient = path.join(home, "environment profile");
        const legacy = path.join(home, ".t3");
        for (const [explicit, env, expected] of [
          [Option.some(flag), { SCIENT_NEXT_HOME: scient, T3CODE_HOME: legacy }, flag],
          [Option.none<string>(), { SCIENT_NEXT_HOME: scient, T3CODE_HOME: legacy }, scient],
          [Option.some("  "), { SCIENT_NEXT_HOME: scient, T3CODE_HOME: legacy }, scient],
          [
            Option.none<string>(),
            { SCIENT_NEXT_HOME: "  ", T3CODE_HOME: legacy },
            path.join(home, ".scient-next"),
          ],
          [Option.none<string>(), { T3CODE_HOME: legacy }, path.join(home, ".scient-next")],
        ] as const) {
          expect(
            yield* resolveBrowserSetupBaseDir(explicit).pipe(
              Effect.provideService(HostProcess.HomeDirectory, home),
              Effect.provideService(HostProcess.Environment, env),
              Effect.provideService(HostProcess.UserId, 1000),
            ),
          ).toBe(expected);
        }
      }),
  );

  it.effect(
    "uses the invoking user's identity default rather than root or inherited T3 profiles",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const userHome = path.resolve("/synthetic-user");
        const rootHome = path.resolve("/synthetic-root");
        const env = { SUDO_USER: "fixture-user", T3CODE_HOME: path.join(userHome, ".t3") };
        const resolve = (explicit: Option.Option<string>, environment: NodeJS.ProcessEnv) =>
          resolveBrowserSetupBaseDir(explicit).pipe(
            Effect.provideService(HostProcess.HomeDirectory, rootHome),
            Effect.provideService(HostProcess.Environment, environment),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
              ...spawner,
              string: () =>
                Effect.succeed(`fixture-user:x:1000:1000:Fixture:${userHome}:/bin/sh\n`),
            }),
          );
        expect(yield* resolve(Option.none(), env)).toBe(path.join(userHome, ".scient-next"));
        const profile = path.join(userHome, "selected profile");
        expect(yield* resolve(Option.some(profile), env)).toBe(profile);
        expect(yield* resolve(Option.none(), { ...env, SCIENT_NEXT_HOME: profile })).toBe(profile);
      }),
  );

  it.effect("requires an explicit profile when sudo's invoking account cannot be resolved", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const error = yield* resolveBrowserSetupBaseDir(Option.none()).pipe(
        Effect.provideService(HostProcess.HomeDirectory, "/synthetic-root"),
        Effect.provideService(HostProcess.Environment, { SUDO_USER: "missing-fixture-user" }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
          ...spawner,
          string: () => Effect.succeed(""),
        }),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "BrowserSetupStepError" });
    }),
  );

  it.effect("does not select a new root profile without an explicit Scient profile", () =>
    Effect.gen(function* () {
      const error = yield* resolveBrowserSetupBaseDir(Option.none()).pipe(
        Effect.provideService(HostProcess.HomeDirectory, "/synthetic-root"),
        Effect.provideService(HostProcess.Environment, { T3CODE_HOME: "/synthetic-legacy" }),
        Effect.provideService(HostProcess.UserId, 0),
        Effect.flip,
      );
      expect(error).toMatchObject({ _tag: "BrowserSetupStepError" });
    }),
  );
});

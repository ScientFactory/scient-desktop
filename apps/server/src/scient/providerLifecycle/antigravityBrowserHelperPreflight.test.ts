import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { prepareAntigravityProfile } from "../../provider/antigravityAuthSupport.ts";
import { verifyAntigravityBrowserHelperOnce } from "./antigravityBrowserHelperPreflight.ts";

const timedOut = { _tag: "TimedOut" } as const;
const once = (spawner: object, helperExecutable: string, environment: NodeJS.ProcessEnv = {}) =>
  verifyAntigravityBrowserHelperOnce({
    spawner,
    helperExecutable,
    environment,
    timeout: "5 seconds",
    onTimeout: () => timedOut,
  });

it.effect("keeps a successful verification per helper and spawner", () =>
  Effect.gen(function* () {
    const spawner = {};
    let runs = 0;
    const verify = Effect.sync(() => {
      runs += 1;
    });
    yield* verify.pipe(once(spawner, "/helper/a"));
    yield* verify.pipe(once(spawner, "/helper/a"));
    expect(runs).toBe(1);
    yield* verify.pipe(once(spawner, "/helper/b"));
    yield* verify.pipe(once({}, "/helper/a"));
    expect(runs).toBe(3);
  }),
);

it.effect("checks again when the helper's Node or Electron startup settings change", () =>
  Effect.gen(function* () {
    const spawner = {};
    let runs = 0;
    const verify = Effect.sync(() => {
      runs += 1;
    });
    const launch = { ELECTRON_RUN_AS_NODE: "1", PATH: "/bin" };
    yield* verify.pipe(once(spawner, "/helper", launch));
    yield* verify.pipe(once(spawner, "/helper", { ...launch, PATH: "/usr/bin" }));
    expect(runs).toBe(1);
    yield* verify.pipe(once(spawner, "/helper", { ...launch, node_options: "--inspect" }));
    yield* verify.pipe(once(spawner, "/helper", { PATH: "/bin" }));
    expect(runs).toBe(3);
  }),
);

it.effect("checks again after a failure", () =>
  Effect.gen(function* () {
    const spawner = {};
    let runs = 0;
    const failing = Effect.suspend(() => {
      runs += 1;
      return Effect.fail("helper failed" as const);
    });
    expect(yield* failing.pipe(once(spawner, "/helper"), Effect.flip)).toBe("helper failed");
    expect(yield* failing.pipe(once(spawner, "/helper"), Effect.flip)).toBe("helper failed");
    expect(runs).toBe(2);
  }),
);

it.effect("times out without waiting for a teardown that never finishes", () =>
  Effect.gen(function* () {
    const spawner = {};
    // A helper that never exits, and whose kill never completes, as a stalled `taskkill` can.
    const stalled = Effect.addFinalizer(() => Effect.never).pipe(Effect.andThen(Effect.never));
    const fiber = yield* stalled.pipe(once(spawner, "/helper"), Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(fiber)).toBe(timedOut);

    let runs = 0;
    yield* Effect.sync(() => {
      runs += 1;
    }).pipe(once(spawner, "/helper"));
    expect(runs).toBe(1);
  }),
);

it.layer(NodeServices.layer)("Antigravity profile preparation preflight", (it) => {
  it.effect("spawns the browser helper once for repeated sign-ins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped();
      let spawns = 0;
      const counting = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawns += 1;
        return real.spawn(command);
      });
      for (const name of ["first", "second", "third"]) {
        yield* prepareAntigravityProfile({
          profileDirectory: path.join(directory, name),
          userHome: directory,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, counting));
      }
      expect(spawns).toBe(1);
    }),
  );
});

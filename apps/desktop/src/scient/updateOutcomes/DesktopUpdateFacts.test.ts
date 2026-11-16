// @effect-diagnostics nodeBuiltinImport:off -- a real temporary journal directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopUpdateFact } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import { PRIMARY_INSTANCE_ID } from "../../backend/DesktopBackendPool.ts";
import * as DesktopUpdateFacts from "./DesktopUpdateFacts.ts";

const WSL_SOURCE = "wsl:Ubuntu";

function journalLayer(home: string) {
  const config = DesktopConfig.layerTest({ SCIENT_NEXT_HOME: home });
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: home,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, config)));
  return DesktopUpdateFacts.layer.pipe(
    Layer.provide(
      Layer.succeed(DesktopManagedPolicy.DesktopManagedPolicy, {
        read: Effect.undefined,
      }),
    ),
    Layer.provide(environment),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

/** One desktop process: its journal service, with analytics on or off for that launch. */
function inLaunch<A>(
  home: string,
  analytics: "true" | "false",
  program: (
    facts: DesktopUpdateFacts.DesktopUpdateFacts["Service"],
  ) => Effect.Effect<A, never, Scope.Scope>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      return yield* program(yield* DesktopUpdateFacts.DesktopUpdateFacts);
    }),
  ).pipe(
    Effect.provide(journalLayer(home)),
    Effect.provideService(HostProcess.Environment, { SCIENT_ANALYTICS_ENABLED: analytics }),
  );
}

/** Collects the next offer each backend receives once `trigger` runs. */
const nextOffers = Effect.fn("test.nextOffers")(function* (
  facts: DesktopUpdateFacts.DesktopUpdateFacts["Service"],
  trigger: Effect.Effect<void>,
) {
  const watch = (sourceId: string) =>
    facts.deliveries(sourceId).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
  const primary = yield* watch(PRIMARY_INSTANCE_ID);
  const wsl = yield* watch(WSL_SOURCE);
  yield* Effect.yieldNow;
  yield* trigger;
  const offered = (yield* Fiber.join(primary)).flat();
  // Two backends have two analytics identities: an offer to both would count each fact twice.
  yield* Fiber.interrupt(wsl);
  assert.isFalse(Exit.isSuccess(yield* Fiber.await(wsl)));
  return offered;
});

const ids = (facts: ReadonlyArray<DesktopUpdateFact>) => facts.map((fact) => fact.id);

function temporaryHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-update-facts-"));
}

function journalFile(home: string): string {
  return NodePath.join(home, "runtime", DesktopUpdateFacts.DESKTOP_UPDATE_FACTS_FILE);
}

describe("DesktopUpdateFacts", () => {
  it.effect(
    "offers journaled facts to one backend, with the same ids after a restart, until acknowledged",
    () =>
      Effect.gen(function* () {
        const home = temporaryHome();
        const recorded = yield* inLaunch(home, "true", (facts) =>
          Effect.gen(function* () {
            yield* facts.sourceReady(WSL_SOURCE);
            return yield* nextOffers(
              facts,
              Effect.all([
                facts.sourceReady(PRIMARY_INSTANCE_ID),
                facts.record("app.update.outcome", {
                  step: "install",
                  outcome: "handoff-attempted",
                }),
              ]).pipe(Effect.asVoid),
            );
          }),
        );
        assert.lengthOf(recorded, 1);

        // The app quit before any backend acknowledged; the next launch offers the same events.
        const replayed = yield* inLaunch(home, "true", (facts) =>
          Effect.gen(function* () {
            const offered = yield* nextOffers(facts, facts.sourceReady(PRIMARY_INSTANCE_ID));
            yield* facts.acknowledge(ids(offered));
            return offered;
          }),
        );
        assert.deepEqual(ids(replayed), ids(recorded));
        const journal = JSON.parse(NodeFS.readFileSync(journalFile(home), "utf8")) as {
          readonly facts: ReadonlyArray<unknown>;
        };
        assert.lengthOf(journal.facts, 0);
      }),
  );

  it.effect("never keeps or replays facts while analytics is off", () =>
    Effect.gen(function* () {
      const home = temporaryHome();
      yield* inLaunch(home, "true", (facts) =>
        facts.record("app.update.outcome", { step: "apply", outcome: "not-applied" }),
      );
      assert.isTrue(NodeFS.existsSync(journalFile(home)));

      yield* inLaunch(home, "false", (facts) =>
        facts.record("app.update.summary", { reason: "launch", status: "idle" }),
      );
      assert.isFalse(NodeFS.existsSync(journalFile(home)));

      const offered = yield* inLaunch(home, "true", (facts) =>
        nextOffers(
          facts,
          facts
            .sourceReady(PRIMARY_INSTANCE_ID)
            .pipe(
              Effect.andThen(
                facts.record("app.update.summary", { reason: "launch", status: "idle" }),
              ),
            ),
        ),
      );
      assert.deepEqual(
        offered.map((fact) => fact.name),
        ["app.update.summary"],
      );
    }),
  );

  it.effect("counts facts dropped for room in the next summary", () =>
    Effect.gen(function* () {
      const home = temporaryHome();
      const journal = yield* inLaunch(home, "true", (facts) =>
        Effect.gen(function* () {
          for (let index = 0; index < 66; index += 1) {
            yield* facts.record("app.update.outcome", { step: "check", outcome: "up-to-date" });
          }
          yield* facts.record("app.update.summary", { reason: "daily", status: "up-to-date" });
          return yield* nextOffers(facts, facts.sourceReady(PRIMARY_INSTANCE_ID));
        }),
      );
      assert.lengthOf(journal, 64);
      assert.equal(journal.at(-1)?.properties.droppedFactCount, 2);
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off -- The pass checks project folders before handing them to the Promise-based move.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ensureScientLibrary,
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { moveProjectIntoLibrary, type ScientLibraryMoveRunOutcome } from "./LibraryMove.ts";
import { ScientSourcesBackend } from "./SourcesBackend.ts";

/** A folder that is not there (an unattached drive) waits for a later pass. */
async function scientProjectPresent(root: string): Promise<boolean> {
  return NodeFSP.lstat(NodePath.join(root, ".scient", "project.json")).then(
    (stats) => stats.isFile(),
    () => false,
  );
}

/**
 * Moves each listed project into the library, one at a time. Server maintenance run as the
 * environment itself, like storage cleanup; no connection's request starts it, and it does
 * nothing while this build runs the project backend.
 */
export const runLibraryMovePass = Effect.fn("ScientLibraryMove.pass")(function* (
  roots: ReadonlyArray<string>,
) {
  const outcomes = new Map<string, ScientLibraryMoveRunOutcome | "absent">();
  if ((yield* ScientSourcesBackend) !== "library") return outcomes;
  const config = yield* ServerConfig;
  const libraryRoot = scientLibraryRootFor(config.stateDir);
  let ensured = false;
  for (const root of roots) {
    if (!(yield* Effect.promise(() => scientProjectPresent(root)))) {
      outcomes.set(root, "absent");
      continue;
    }
    if (!ensured) {
      yield* Effect.promise(() => ensureScientLibrary(libraryRoot));
      ensured = true;
    }
    const outcome = yield* moveProjectIntoLibrary({
      root,
      library: scientLibraryLocation(libraryRoot),
      actor: "user",
      wait: "until-done",
    });
    outcomes.set(root, outcome);
    yield* Effect.yieldNow;
  }
  return outcomes;
});

const PASS_DELAY = "2 minutes";
const PASS_INTERVAL = "6 hours";

/** Starts the pass after the server settles and repeats it; inert on the project backend. */
export const libraryMovePassLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* ScientSourcesBackend) !== "library") return;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const pass = projects.listShells().pipe(
      Effect.flatMap((shells) =>
        runLibraryMovePass([
          ...new Set(shells.map((shell) => NodePath.resolve(shell.workspaceRoot))),
        ]),
      ),
      Effect.catchCause((cause) => Effect.logWarning("The library move pass failed.", { cause })),
    );
    yield* forkParked(
      Effect.sleep(PASS_DELAY).pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)))),
      ),
    );
  }),
);

import {
  scientLibraryLocation,
  scientLibraryRootFor,
} from "@scientfactory/scient-sources/library-root";
import { warmScientLibraryRecordIndex } from "@scientfactory/scient-sources/store";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import { ScientSourcesBackend } from "./SourcesBackend.ts";

/**
 * Below this many record files the first list builds the index within about a second even on the
 * slowest measured machine, so a smaller Library keeps nothing in memory until it is opened.
 */
export const LIBRARY_WARM_MINIMUM_RECORDS = 3_000;

/** After activation, so the first screens load before the index is read. */
const WARM_DELAY = "5 seconds";

const warmLibraryRecordIndex = Effect.fn("ScientLibrary.warmRecordIndex")(function* () {
  const config = yield* ServerConfig;
  const library = scientLibraryLocation(scientLibraryRootFor(config.stateDir));
  return yield* Effect.promise((signal) =>
    warmScientLibraryRecordIndex(library, {
      minimumRecords: LIBRARY_WARM_MINIMUM_RECORDS,
      signal,
    }),
  );
});

/** Reads a large Library's record index in the background once the server is up. */
export const libraryIndexWarmLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* ScientSourcesBackend) !== "library") return;
    yield* forkParked(
      Effect.sleep(WARM_DELAY).pipe(
        Effect.andThen(warmLibraryRecordIndex()),
        Effect.catchCause((cause) =>
          Effect.logWarning("Reading the Library's record index at start failed.", { cause }),
        ),
      ),
    );
  }),
);

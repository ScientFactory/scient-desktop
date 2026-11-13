import type { ScientReferenceFix } from "@scientfactory/scient-sources";
import * as Effect from "effect/Effect";

import {
  checkReferences,
  isReferenceCheckError,
  ReferenceIdentifierLookup,
} from "../../../scient/references/ReferenceCheck.ts";
import { resolveReferenceFindings } from "../../../scient/references/ReferenceResolution.ts";
import { referenceCheckSources } from "../../../scient/references/ReferenceStores.ts";
import { keyedBatchLookup } from "../../../scient/sources/researchKeys.ts";
import { resolveScientSourcesStoreFor } from "../../../scient/sources/SourcesBackend.ts";
import { resolveScientSourcesProject, resolveScientSourcesStore } from "../sources/handlers.ts";
import { ScientSourcesToolError } from "../sources/tools.ts";
import { ScientReferencesToolkit } from "./tools.ts";

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    // Reference check errors name project paths only; anything else may hold host paths.
    catch: (cause) =>
      new ScientSourcesToolError({
        code: "operation-failed",
        message: isReferenceCheckError(cause)
          ? cause.message
          : "The reference check could not be completed.",
      }),
  });

export const checkReferencesForInvocation = Effect.fn("ScientReferencesToolkit.check")(
  function* (input: { readonly path?: string }) {
    const project = yield* resolveScientSourcesProject();
    // A check reads only, whatever the grant: it never starts the move or creates the Library.
    const store = yield* resolveScientSourcesStoreFor(project, "read", "agent").pipe(
      Effect.mapError(
        (error) => new ScientSourcesToolError({ code: "operation-failed", message: error.message }),
      ),
    );
    const resolveIdentifiers = yield* keyedBatchLookup(yield* ReferenceIdentifierLookup);
    return yield* attempt(() =>
      checkReferences(
        {
          root: project.root,
          target: input.path ? { kind: "file", path: input.path } : { kind: "library" },
          ...referenceCheckSources(store.kind === "library" ? store : null),
        },
        { resolveIdentifiers },
      ),
    );
  },
);

export const resolveReferencesForInvocation = Effect.fn("ScientReferencesToolkit.resolve")(
  function* (input: {
    readonly apply?: ReadonlyArray<ScientReferenceFix>;
    readonly ignore?: ReadonlyArray<string>;
    readonly restore?: ReadonlyArray<string>;
  }) {
    const store = yield* resolveScientSourcesStore();
    const library = store.kind === "library" && store.access === "write" ? store : null;
    return yield* attempt(() =>
      resolveReferenceFindings({ root: store.root, library, ...input, actor: "agent" }),
    );
  },
);

export const ScientReferencesToolkitHandlersLive = ScientReferencesToolkit.toLayer({
  scient_references_check: checkReferencesForInvocation,
  scient_references_resolve: resolveReferencesForInvocation,
});

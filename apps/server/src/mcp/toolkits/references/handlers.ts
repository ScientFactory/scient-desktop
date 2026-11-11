import type { ScientReferenceFix } from "@scientfactory/scient-sources";
import * as Effect from "effect/Effect";

import {
  checkReferences,
  isReferenceCheckError,
  ReferenceIdentifierLookup,
} from "../../../scient/references/ReferenceCheck.ts";
import { resolveReferenceFindings } from "../../../scient/references/ReferenceResolution.ts";
import { keyedBatchLookup } from "../../../scient/sources/researchKeys.ts";
import { resolveScientSourcesProject } from "../sources/handlers.ts";
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
    const { root } = yield* resolveScientSourcesProject();
    const resolveIdentifiers = yield* keyedBatchLookup(yield* ReferenceIdentifierLookup);
    return yield* attempt(() =>
      checkReferences(
        {
          root,
          target: input.path ? { kind: "file", path: input.path } : { kind: "library" },
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
    const { root } = yield* resolveScientSourcesProject();
    return yield* attempt(() => resolveReferenceFindings({ root, ...input, actor: "agent" }));
  },
);

export const ScientReferencesToolkitHandlersLive = ScientReferencesToolkit.toLayer({
  scient_references_check: checkReferencesForInvocation,
  scient_references_resolve: resolveReferencesForInvocation,
});

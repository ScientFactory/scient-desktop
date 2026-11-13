import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ScientReferenceCheckError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import {
  checkReferences,
  isReferenceCheckError,
  listReferenceDocuments,
  ReferenceIdentifierLookup,
} from "./ReferenceCheck.ts";
import { resolveScientLibraryStoreAt } from "../sources/SourcesBackend.ts";
import { resolveReferenceFindings } from "./ReferenceResolution.ts";
import { referenceCheckSources } from "./ReferenceStores.ts";

class ScientReferencesOperationError extends Schema.TaggedError<ScientReferencesOperationError>()(
  "ScientReferencesOperationError",
  { cause: Schema.Defect() },
) {}

const handle = Effect.fn("ScientReferencesHttp.handle")(function* <A>(
  endpointName: string,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  run: () => Promise<A>,
) {
  yield* annotateEnvironmentRequest(endpointName);
  yield* requireEnvironmentScope(scope);
  return yield* Effect.tryPromise({
    try: run,
    catch: (cause) =>
      isReferenceCheckError(cause)
        ? new ScientReferenceCheckError({ message: cause.message })
        : new ScientReferencesOperationError({ cause }),
  }).pipe(
    Effect.catchTags({
      ScientReferencesOperationError: (error) =>
        failEnvironmentInternal("scient_references_operation_failed", error.cause),
    }),
  );
});

/**
 * The Library a moved project's check reads and its fixes change; null keeps the project's own
 * store (project backend, a project not moved, or a folder that is not a Scient project).
 */
const libraryAt = (root: string, access: "read" | "write") =>
  resolveScientLibraryStoreAt(root, access).pipe(
    Effect.catchTags({
      ScientLibraryProjectError: () => Effect.succeed(null),
      ScientLibraryMoveBusyError: (cause) =>
        failEnvironmentInternal("scient_references_operation_failed", cause),
    }),
  );

export const scientReferencesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientReferences",
  Effect.fnUntraced(function* (handlers) {
    const resolveIdentifiers = yield* ReferenceIdentifierLookup;
    return yield* Effect.succeed(
      handlers
        .handle("documents", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listReferenceDocuments(args.payload.root),
          ),
        )
        .handle("check", (args) =>
          Effect.gen(function* () {
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const library = yield* libraryAt(args.payload.root, "read");
            return yield* handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
              checkReferences(
                { ...args.payload, ...referenceCheckSources(library) },
                { resolveIdentifiers },
              ),
            );
          }),
        )
        .handle("resolve", (args) =>
          Effect.gen(function* () {
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            const library = yield* libraryAt(args.payload.root, "write");
            return yield* handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
              resolveReferenceFindings({ ...args.payload, library, actor: "user" }),
            );
          }),
        ),
    );
  }),
);

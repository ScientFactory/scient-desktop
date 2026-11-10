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
import { SourceIdentifierLookup } from "../sources/SourceIdentifierResolver.ts";
import {
  checkReferences,
  isReferenceCheckError,
  listReferenceDocuments,
} from "./ReferenceCheck.ts";
import { resolveReferenceFindings } from "./ReferenceResolution.ts";

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

export const scientReferencesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientReferences",
  Effect.fnUntraced(function* (handlers) {
    return yield* Effect.succeed(
      handlers
        .handle("documents", (args) =>
          handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
            listReferenceDocuments(args.payload.root),
          ),
        )
        .handle("check", (args) =>
          Effect.gen(function* () {
            const resolveIdentifier = yield* SourceIdentifierLookup;
            return yield* handle(args.endpoint.name, AuthOrchestrationReadScope, () =>
              checkReferences(args.payload, { resolveIdentifier }),
            );
          }),
        )
        .handle("resolve", (args) =>
          handle(args.endpoint.name, AuthOrchestrationOperateScope, () =>
            resolveReferenceFindings({ ...args.payload, actor: "user" }),
          ),
        ),
    );
  }),
);

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import {
  layer as ScientAnnotationsLive,
  ScientAnnotations,
} from "../annotations/ScientAnnotations.ts";
import { savePdfFileEdit } from "./PdfFileEdits.ts";

export const scientPdfHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientPdf",
  Effect.fnUntraced(function* (handlers) {
    const annotations = yield* ScientAnnotations;
    const annotationsFailed = Effect.catch((cause: unknown) =>
      failEnvironmentInternal("scient_annotations_operation_failed", cause),
    );
    return handlers
      .handle("save", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* savePdfFileEdit({
            source: args.payload.source,
            expectedRevision: args.payload.expectedRevision,
            operationId: args.payload.operationId,
            temporaryPath: args.payload.file.path,
          });
        }),
      )
      .handle("annotationsForDocument", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* annotations.forDocument(args.payload);
        }),
      )
      .handle("annotationsForSource", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* annotations.forSource(args.payload).pipe(annotationsFailed);
        }),
      )
      .handle("annotationsMutate", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* annotations.mutate(args.payload, "user").pipe(annotationsFailed);
        }),
      );
  }),
).pipe(Layer.provide(ScientAnnotationsLive));

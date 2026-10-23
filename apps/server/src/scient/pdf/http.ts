import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../auth/http.ts";
import { savePdfFileEdit } from "./PdfFileEdits.ts";

export const scientPdfHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientPdf",
  (handlers) =>
    Effect.succeed(
      handlers.handle("save", (args) =>
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
      ),
    ),
);

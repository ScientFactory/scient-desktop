import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../../auth/http.ts";
import { uploadWorkspaceMarkdownImage } from "./WorkspaceMarkdownFiles.ts";

export const scientMarkdownHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientMarkdown",
  Effect.fnUntraced(function* (handlers) {
    return yield* Effect.succeed(
      handlers.handle("imageUpload", (args) =>
        Effect.gen(function* () {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* uploadWorkspaceMarkdownImage({
            cwd: args.payload.cwd,
            documentRelativePath: args.payload.documentRelativePath,
            temporaryPath: args.payload.file.path,
            fileName: args.payload.file.name,
            ...(args.payload.assetDirectory === undefined
              ? {}
              : { assetDirectory: args.payload.assetDirectory }),
          }).pipe(
            Effect.catchTag("WorkspaceMarkdownImageOperationError", (cause) =>
              failEnvironmentInternal("scient_markdown_operation_failed", cause.cause),
            ),
          );
        }),
      ),
    );
  }),
);

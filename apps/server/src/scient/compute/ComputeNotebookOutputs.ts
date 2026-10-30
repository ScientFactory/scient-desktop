import {
  ComputeGatewayError,
  projectComputeOutputs,
  type ComputeNotebookOutputsInput,
  type ComputeNotebookOutputsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type { ComputeRpcGateway } from "./ComputeRpcGateway.ts";
import type { ComputeSessionService } from "./ComputeSessionService.ts";

const notebookError = (message: string, cause?: unknown) =>
  new ComputeGatewayError({
    operation: "outputs",
    reason: "operation-failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

type NotebookOutput = Record<string, unknown>;
const isTextual = (mediaType: string) =>
  mediaType.startsWith("text/") || /[+/](?:xml|json)$/.test(mediaType);
/** The bridge's private name for submitted code; a notebook calls it the cell. */
const SUBMITTED_SOURCE = /<scient-compute-source:[0-9a-f]+(?::[0-9]+)?>/g;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A finished run as Jupyter (nbformat 4) outputs, with stored figures inlined as base64,
 * so a notebook keeps its results in its own file.
 */
export function makeComputeNotebookOutputs(input: {
  readonly gateway: Pick<ComputeRpcGateway, "getSession" | "listOutputs">;
  readonly compute: Pick<
    ComputeSessionService["Service"],
    "resolveOutputImage" | "resolveOutputResource"
  >;
  readonly fileSystem: Pick<FileSystem.FileSystem, "readFile">;
}) {
  return Effect.fn("ComputeNotebookOutputs.read")(function* (request: ComputeNotebookOutputsInput) {
    const session = yield* input.gateway.getSession({
      cwd: request.cwd,
      sessionId: request.sessionId,
    });
    if (session === null)
      return yield* notebookError("This compute session is no longer available.");
    const { outputs } = yield* input.gateway.listOutputs({
      cwd: request.cwd,
      sessionId: request.sessionId,
      executionId: request.executionId,
    });
    const ref = (contentHash: string) => ({
      projectId: session.projectId,
      sessionId: session.sessionId,
      executionId: request.executionId,
      contentHash,
    });
    // nbformat keeps text formats (SVG, HTML, JSON…) as text and binary ones as base64.
    const stored = (path: string, mediaType: string) =>
      input.fileSystem.readFile(path).pipe(
        Effect.map((bytes) =>
          isTextual(mediaType)
            ? new TextDecoder().decode(bytes)
            : Buffer.from(bytes).toString("base64"),
        ),
        Effect.mapError((cause) => notebookError("A stored figure could not be read.", cause)),
      );
    const notebook: NotebookOutput[] = [];
    let executionCount: number | null = null;
    for (const output of projectComputeOutputs(outputs)) {
      switch (output._tag) {
        case "stream": {
          const last = notebook.at(-1);
          if (last?.output_type === "stream" && last.name === output.stream) {
            last.text = `${String(last.text)}${output.text}`;
          } else {
            notebook.push({ output_type: "stream", name: output.stream, text: output.text });
          }
          break;
        }
        case "diagnostic":
          notebook.push({
            output_type: "error",
            ename: output.diagnostic.errorName,
            evalue: output.diagnostic.message,
            traceback: output.diagnostic.traceback.map((line) =>
              line.replace(SUBMITTED_SOURCE, "cell"),
            ),
          });
          break;
        case "image": {
          const resolved = yield* input.compute.resolveOutputImage(ref(output.contentHash));
          if (resolved === null) break;
          notebook.push({
            output_type: "display_data",
            data: { [output.mediaType]: yield* stored(resolved.path, output.mediaType) },
            metadata: {},
          });
          break;
        }
        case "representation": {
          const data: Record<string, unknown> = {};
          for (const representation of output.bundle.representations) {
            const value = representation.data;
            if (value._tag === "text") data[representation.mediaType] = value.text;
            else if (value._tag === "json") data[representation.mediaType] = parseJson(value.json);
            else {
              const resolved = yield* input.compute.resolveOutputResource(ref(value.contentHash));
              if (resolved !== null)
                data[representation.mediaType] = yield* stored(
                  resolved.path,
                  representation.mediaType,
                );
            }
          }
          const metadata =
            output.bundle.metadataJson === null ? {} : parseJson(output.bundle.metadataJson);
          if (output.kind === "execute-result") {
            executionCount = output.executionCount;
            notebook.push({
              output_type: "execute_result",
              execution_count: executionCount,
              data,
              metadata,
            });
          } else {
            notebook.push({ output_type: "display_data", data, metadata });
          }
          break;
        }
        case "system":
          break;
      }
    }
    return { outputs: notebook, executionCount } satisfies ComputeNotebookOutputsResult;
  });
}

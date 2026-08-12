import type { ExecutionOutputChunk } from "./contract.ts";

const OUTPUT_CONTENT_FORMAT = "scient-execution-output-v1\n";

/** Canonical captured-output parts that can be hashed without another full-output copy. */
export function* executionOutputContentParts(
  chunks: ReadonlyArray<ExecutionOutputChunk>,
): Iterable<string> {
  yield OUTPUT_CONTENT_FORMAT;
  for (const chunk of chunks) yield `${JSON.stringify([chunk.stream, chunk.text])}\n`;
}

import type { ComputeOutput, ComputeProjectedOutput } from "@t3tools/contracts";

import { projectComputeFigureOutputs } from "./computeResultPresentation";

type ComputeStreamName = Extract<ComputeOutput, { readonly _tag: "stream" }>["stream"];

export type ComputeOutputBlock =
  | {
      readonly kind: "stream";
      readonly key: string;
      readonly stream: ComputeStreamName;
      readonly text: string;
    }
  | {
      readonly kind: "output";
      readonly key: string;
      readonly output: Exclude<ComputeProjectedOutput, { readonly _tag: "stream" }>;
    };

/**
 * Projects a transcript into visible blocks. Consecutive chunks of one stream form a single block,
 * so carriage-return progress spanning chunks overwrites the line it started on.
 */
export function computeOutputBlocks(
  outputs: ReadonlyArray<ComputeOutput>,
): ReadonlyArray<ComputeOutputBlock> {
  const blocks: ComputeOutputBlock[] = [];
  const occurrences = new Map<string, number>();
  const keyFor = (identity: string) => {
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}:${occurrence}`;
  };
  for (const output of projectComputeFigureOutputs(outputs)) {
    const previous = blocks.at(-1);
    if (output._tag !== "stream") {
      blocks.push({
        kind: "output",
        key: keyFor(`${output._tag}:${output.sequence}`),
        output,
      });
    } else if (previous?.kind === "stream" && previous.stream === output.stream) {
      blocks[blocks.length - 1] = { ...previous, text: previous.text + output.text };
    } else {
      blocks.push({
        kind: "stream",
        key: keyFor(`stream:${output.stream}:${output.sequence}`),
        stream: output.stream,
        text: output.text,
      });
    }
  }
  return blocks;
}

import type { ExecutionOutputChunk, ExecutionProcessOutput } from "@scientfactory/execution";

export const ANALYSIS_OUTPUT_MAXIMUM_BYTES = 4 * 1024 * 1024;
export const ANALYSIS_OUTPUT_MAXIMUM_CHUNK_BYTES = 256 * 1024;

export function completeUtf8PrefixByteLength(bytes: Uint8Array, requested: number): number {
  if (requested >= bytes.byteLength) return bytes.byteLength;
  let boundary = requested;
  while (boundary > 0 && (bytes[boundary]! & 0xc0) === 0x80) boundary -= 1;
  return boundary;
}

function decodeUtf8Chunks(bytes: Uint8Array): ReadonlyArray<string> {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const boundary = completeUtf8PrefixByteLength(
      bytes,
      Math.min(bytes.byteLength, offset + ANALYSIS_OUTPUT_MAXIMUM_CHUNK_BYTES),
    );
    if (boundary <= offset) break;
    chunks.push(new TextDecoder().decode(bytes.subarray(offset, boundary)));
    offset = boundary;
  }
  return chunks;
}

function coalesceProcessOutput(
  outputs: ReadonlyArray<ExecutionProcessOutput>,
): ReadonlyArray<ExecutionProcessOutput> {
  const coalesced: Array<ExecutionProcessOutput> = [];
  for (const output of outputs) {
    if (output.text.length === 0) continue;
    const previous = coalesced.at(-1);
    if (previous?.stream === output.stream) {
      coalesced[coalesced.length - 1] = {
        stream: previous.stream,
        text: previous.text + output.text,
      };
    } else {
      coalesced.push(output);
    }
  }
  return coalesced;
}

export function appendBoundedAnalysisOutput(input: {
  readonly outputs: ReadonlyArray<ExecutionProcessOutput>;
  readonly outputByteLength: number;
  readonly outputTruncated: boolean;
  readonly nextSequence: number;
  readonly observedAt: string;
}): {
  readonly chunks: ReadonlyArray<ExecutionOutputChunk>;
  readonly outputByteLength: number;
  readonly outputTruncated: boolean;
} {
  const chunks: ExecutionOutputChunk[] = [];
  let outputByteLength = input.outputByteLength;
  let outputTruncated = input.outputTruncated;

  for (const output of coalesceProcessOutput(input.outputs)) {
    if (outputTruncated) break;
    const remainingBytes = Math.max(0, ANALYSIS_OUTPUT_MAXIMUM_BYTES - outputByteLength);
    const encoded = new TextEncoder().encode(output.text);
    const acceptedByteLength = completeUtf8PrefixByteLength(
      encoded,
      Math.min(encoded.byteLength, remainingBytes),
    );
    for (const acceptedText of decodeUtf8Chunks(encoded.subarray(0, acceptedByteLength))) {
      chunks.push({
        sequence: input.nextSequence + chunks.length,
        stream: output.stream,
        text: acceptedText,
        observedAt: input.observedAt,
      });
    }
    outputByteLength += acceptedByteLength;
    if (acceptedByteLength < encoded.byteLength) {
      outputTruncated = true;
      chunks.push({
        sequence: input.nextSequence + chunks.length,
        stream: "system",
        text: `Output was truncated at the ${ANALYSIS_OUTPUT_MAXIMUM_BYTES}-byte limit.\n`,
        observedAt: input.observedAt,
      });
    }
  }

  return { chunks, outputByteLength, outputTruncated };
}

// @effect-diagnostics nodeBuiltinImport:off -- Node HTTP response completion and byte limits belong at the transport boundary.
import type * as NodeHttp from "node:http";

export type NodeHttpRequest = (
  url: URL,
  options: NodeHttp.RequestOptions,
  onResponse: (response: NodeHttp.IncomingMessage) => void,
) => NodeHttp.ClientRequest;

export async function readBoundedNodeResponse(
  response: NodeHttp.IncomingMessage,
  options: {
    readonly maxBytes: number;
    readonly tooLargeMessage: string;
    readonly discardBody?: boolean;
  },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Node's iterator rejects response errors, aborts and premature closes, and destroys on exit.
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > options.maxBytes) throw new Error(options.tooLargeMessage);
    if (!options.discardBody) chunks.push(buffer);
  }
  if (!response.complete) throw new Error("The HTTP response ended before it was complete.");
  return Buffer.concat(chunks, options.discardBody ? 0 : bytes);
}

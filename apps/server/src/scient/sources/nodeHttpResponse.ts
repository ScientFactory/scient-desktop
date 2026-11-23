// @effect-diagnostics nodeBuiltinImport:off -- Node HTTP response completion and byte limits belong at the transport boundary.
// @effect-diagnostics globalTimers:off -- Promise-based HTTP boundaries abort native requests at their deadline.
import type * as NodeHttp from "node:http";
import * as NodeTimers from "node:timers";

export type NodeHttpRequest = (
  url: URL,
  options: NodeHttp.RequestOptions,
  onResponse: (response: NodeHttp.IncomingMessage) => void,
) => NodeHttp.ClientRequest;

/**
 * One wall-clock budget for a whole request, from before it connects through each redirect to
 * its last byte: a socket's idle timer lets a slow trickle or a connect that never answers run
 * on. `run` passes the signal to every request and stream; past the budget it rejects with
 * `message`.
 */
export async function withRequestDeadline<A>(
  ms: number,
  message: string,
  run: (signal: AbortSignal) => Promise<A>,
): Promise<A> {
  const controller = new AbortController();
  const timer = NodeTimers.setTimeout(() => controller.abort(new Error(message)), ms);
  timer.unref();
  try {
    return await run(controller.signal);
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    NodeTimers.clearTimeout(timer);
  }
}

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

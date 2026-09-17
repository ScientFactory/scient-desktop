// @effect-diagnostics nodeBuiltinImport:off -- Native Pi tests use isolated loopback fixtures.
import type * as NodeHttp from "node:http";

/** Keep Pi's endpoint probe separate from the model requests under test. */
export function rejectNonPostRequest(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
): boolean {
  if (request.method === "POST") return false;
  response.writeHead(404).end();
  return true;
}

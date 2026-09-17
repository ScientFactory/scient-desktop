// @effect-diagnostics nodeBuiltinImport:off -- Native Pi tests use isolated loopback fixtures.
import type { IncomingMessage, ServerResponse } from "node:http";

/** Keep Pi's endpoint probe separate from the model requests under test. */
export function rejectNonPostRequest(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "POST") return false;
  response.writeHead(404).end();
  return true;
}

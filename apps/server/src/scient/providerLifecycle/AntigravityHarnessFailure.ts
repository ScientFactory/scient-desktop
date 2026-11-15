import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import { redactFailureDetail } from "./providerFailureText.ts";

// The trajectory's error step: field 1 is this headline, field 2 the harness's error chain
// without the Go stack trace that field 3 repeats it with.
const HEADLINE = Buffer.from("Agent execution terminated due to error.");
const ERROR_CHAIN_FIELD = 0x12;
const MAX_DETAIL_CHARACTERS = 600;
const EXECUTOR_PREFIX = /^(?:failed to construct executor|agent executor error):\s*/u;
const MCP_LOAD_FAILED = /^MCP load failed for (.+?): (?:calling "[^"]*": )?(.+)$/u;
const GENERIC_MESSAGE = "Antigravity stopped this turn because of an error.";

function errorChain(payload: Uint8Array): string | undefined {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const headline = bytes.indexOf(HEADLINE);
  if (headline < 0) return undefined;
  let offset = headline + HEADLINE.length;
  if (bytes[offset++] !== ERROR_CHAIN_FIELD) return undefined;
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = bytes[offset++];
    if (byte === undefined || shift > 21) return undefined;
    length += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) break;
  }
  const line = bytes
    .subarray(offset, offset + length)
    .toString("utf8")
    .split(/\r?\n/u, 1)[0]
    ?.replace(EXECUTOR_PREFIX, "")
    .trim();
  return line ? redactFailureDetail(line) : undefined;
}

const bounded = (text: string) => {
  const characters = [...text];
  return characters.length <= MAX_DETAIL_CHARACTERS
    ? text
    : `${characters.slice(0, MAX_DETAIL_CHARACTERS - 1).join("")}…`;
};

/**
 * The failure for an Antigravity error step that is not a Google API error. A tool server that
 * fails to start aborts the whole turn, so the message names it.
 */
export function antigravityHarnessFailure(
  payload: Uint8Array | null,
): OrchestrationV2ProviderFailure {
  const chain = payload === null ? undefined : errorChain(payload);
  const mcp = chain === undefined ? null : MCP_LOAD_FAILED.exec(chain);
  if (mcp !== null) {
    return makeProviderFailure({
      class: "provider_error",
      message: bounded(
        `Antigravity could not start the tool server "${mcp[1]}", so it stopped this turn: ${mcp[2]}`,
      ),
      code: "mcp_load_failed",
      retryable: false,
    });
  }
  return makeProviderFailure({
    class: "provider_error",
    message:
      chain === undefined
        ? GENERIC_MESSAGE
        : bounded(`Antigravity stopped this turn because of an error: ${chain}`),
    code: "harness_error",
  });
}

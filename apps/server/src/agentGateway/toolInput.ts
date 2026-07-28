/**
 * Argument decoding helpers for agent gateway MCP tools (read surface).
 *
 * Tool handlers receive an untyped JSON-RPC `arguments` record; these helpers
 * validate individual fields and decode the schema-backed wait request. The
 * creation-plan decoders live in a later, separately-reviewed slice.
 *
 * @module agentGateway/toolInput
 */
import { type ProviderKind } from "@synara/contracts";
import { Schema } from "effect";

import { SynaraWaitForThreadsInput } from "./contract.ts";

export const PROVIDER_KINDS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
];

export class ToolInputError extends Error {}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function readStringArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean },
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (options?.required) throw new ToolInputError(`Missing required argument "${name}".`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`Argument "${name}" must be a non-empty string.`);
  }
  return value.trim();
}

export function readNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`Argument "${name}" must be a number.`);
  }
  return value;
}

export function readBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolInputError(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

export function decodeWaitForThreadsInput(value: unknown) {
  try {
    return Schema.decodeUnknownSync(SynaraWaitForThreadsInput)(value);
  } catch (error) {
    throw new ToolInputError(`Invalid Synara wait request: ${errorText(error)}`);
  }
}

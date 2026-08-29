import type {
  ProviderConnectionActions,
  ProviderConnectionActionFailure,
} from "../../provider/ProviderDriver.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const MAX_TERMINAL_OUTPUT_LENGTH = 128 * 1024;
const MAX_AUTHORIZATION_URL_LENGTH = 8_192;
const ANSI_ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_BELL_CHARACTER = String.fromCharCode(7);
const ANSI_OSC_HYPERLINK = new RegExp(
  `${ANSI_ESCAPE_CHARACTER}\\]8;[^;]*;(https:\\/\\/[^${ANSI_BELL_CHARACTER}${ANSI_ESCAPE_CHARACTER}]*)` +
    `(?:${ANSI_BELL_CHARACTER}|${ANSI_ESCAPE_CHARACTER}\\\\)`,
  "gu",
);
const ANSI_OSC_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE_CHARACTER}\\][^${ANSI_BELL_CHARACTER}${ANSI_ESCAPE_CHARACTER}]*(?:${ANSI_BELL_CHARACTER}|${ANSI_ESCAPE_CHARACTER}\\\\)`,
  "gu",
);
const ANSI_INCOMPLETE_OSC_SEQUENCE = new RegExp(
  `${ANSI_ESCAPE_CHARACTER}\\][^${ANSI_BELL_CHARACTER}]*(?:${ANSI_BELL_CHARACTER}|$)`,
  "gu",
);
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${ANSI_ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, "gu");
const URL_CANDIDATE = /https:\/\/[^\s<>"']+/gu;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Preserve OSC 8 link targets while removing terminal presentation controls. */
export function normalizeTerminalOutput(output: string): string {
  return output
    .replace(ANSI_OSC_HYPERLINK, "$1 ")
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_INCOMPLETE_OSC_SEQUENCE, "")
    .replace(ANSI_ESCAPE_SEQUENCE, "");
}

/**
 * Extract the first bounded HTTPS URL accepted by provider-owned policy.
 * The retained output bound matches the supervised login-process buffers.
 */
export function findTerminalAuthorizationUrl(
  output: string,
  accepts: (url: URL) => boolean,
): string | undefined {
  const retainedOutput =
    output.length > MAX_TERMINAL_OUTPUT_LENGTH ? output.slice(-MAX_TERMINAL_OUTPUT_LENGTH) : output;
  const normalized = normalizeTerminalOutput(retainedOutput);
  for (const match of normalized.matchAll(URL_CANDIDATE)) {
    const candidate = match[0]?.replace(/[),.;]+$/u, "");
    if (
      !candidate ||
      candidate.length > MAX_AUTHORIZATION_URL_LENGTH ||
      hasControlCharacter(candidate)
    ) {
      continue;
    }
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && accepts(url)) return url.toString();
    } catch {
      // Provider-controlled terminal output may contain incomplete URLs.
    }
  }
  return undefined;
}

/** Select values mechanically; providers remain responsible for the complete allowlist. */
export function pickProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  allowedKeys: ReadonlyArray<string>,
): NodeJS.ProcessEnv {
  const allowedKeyNames = new Set(allowedKeys.map((key) => key.toLowerCase()));
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => value !== undefined && allowedKeyNames.has(key.toLowerCase()),
    ),
  );
}

/** Stop active sessions before delegating credential revocation to the provider. */
export function withProviderSessionShutdown<E>(
  actions: ProviderConnectionActions,
  stopAll: Effect.Effect<void, E>,
  mapShutdownError: (cause: E) => ProviderConnectionActionFailure,
): ProviderConnectionActions {
  return {
    ...actions,
    disconnect: stopAll.pipe(Effect.mapError(mapShutdownError), Effect.andThen(actions.disconnect)),
  };
}

export class ProviderConnectionActionError extends Data.TaggedError(
  "ProviderConnectionActionError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

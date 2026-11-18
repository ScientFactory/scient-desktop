import type { ServerProviderAuth, ServerProviderState } from "@t3tools/contracts";

export function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

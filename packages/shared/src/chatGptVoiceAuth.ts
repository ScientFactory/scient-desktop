// FILE: chatGptVoiceAuth.ts
// Purpose: Reads the account context carried by a ChatGPT OAuth access token.
// Layer: Shared Node runtime utility used only by trusted desktop/server processes.
// Exports: extractChatGptAccountIdFromToken.

import { Buffer } from "node:buffer";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
    return asRecord(payload);
  } catch {
    return null;
  }
}

/**
 * Extract the workspace/account id bound to this exact ChatGPT OAuth token.
 *
 * Codex currently reads the nested `https://api.openai.com/auth` claim. The
 * two flat variants are retained for older token issuers. We deliberately do
 * not guess from organization arrays because that could select the wrong
 * workspace when a user belongs to more than one.
 */
export function extractChatGptAccountIdFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token.trim());
  if (!payload) return null;

  const authClaims = asRecord(payload["https://api.openai.com/auth"]);
  return (
    nonEmptyString(authClaims?.chatgpt_account_id) ??
    nonEmptyString(payload.chatgpt_account_id) ??
    nonEmptyString(payload["https://api.openai.com/auth.chatgpt_account_id"])
  );
}

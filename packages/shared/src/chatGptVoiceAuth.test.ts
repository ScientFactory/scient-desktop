import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { extractChatGptAccountIdFromToken } from "./chatGptVoiceAuth";

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

describe("extractChatGptAccountIdFromToken", () => {
  it("reads the account id from the current Codex auth claim", () => {
    const token = unsignedJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: " account-123 ",
        chatgpt_user_id: "user-456",
      },
    });

    expect(extractChatGptAccountIdFromToken(token)).toBe("account-123");
  });

  it.each([
    { chatgpt_account_id: "account-flat" },
    { "https://api.openai.com/auth.chatgpt_account_id": "account-namespaced" },
  ])("supports legacy flat account claims", (payload) => {
    expect(extractChatGptAccountIdFromToken(unsignedJwt(payload))).toMatch(/^account-/u);
  });

  it("does not guess an account from an organizations list", () => {
    const token = unsignedJwt({ organizations: [{ id: "wrong-workspace" }] });
    expect(extractChatGptAccountIdFromToken(token)).toBeNull();
  });

  it.each(["", "not-a-jwt", "a.invalid-json.c"])("returns null for invalid input", (token) => {
    expect(extractChatGptAccountIdFromToken(token)).toBeNull();
  });
});

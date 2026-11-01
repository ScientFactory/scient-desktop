import { describe, expect, it } from "vite-plus/test";

import { secretRequestDisplay, secretRequestPrivacyNote } from "./secretRequest.ts";

describe("Accounts secret cards", () => {
  it("say the key is kept in Accounts, and only for the Accounts tool's cards", () => {
    const account = "turn-item:secret-request:thread-1:scient-account%3Aabc";
    const ordinary = "turn-item:secret-request:thread-1:scient-accountabc";
    expect(secretRequestPrivacyNote({ id: account })).toContain(
      "Saved to Settings ▸ Accounts & secrets",
    );
    expect(secretRequestDisplay({ id: account, secretStatus: "saved" }, "local")).toMatchObject({
      label: "Saved to Accounts",
    });
    expect(secretRequestPrivacyNote({ id: ordinary })).toBe(
      "Stored securely, never shown to the agent",
    );
    expect(secretRequestDisplay({ id: ordinary, secretStatus: "saved" }, "local")).toMatchObject({
      label: "Saved securely and kept private",
    });
  });
});

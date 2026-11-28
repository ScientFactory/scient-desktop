import { describe, expect, it } from "vite-plus/test";

import {
  accountCardLabel,
  accountCardOutcome,
  secretRequestDisplay,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

describe("Accounts secret cards", () => {
  it("say the key is kept in Accounts only for the Accounts tool's cards, and not kept otherwise", () => {
    const account = "turn-item:secret-request:thread-1:scient-account%3Aabc";
    const ordinary = "turn-item:secret-request:thread-1:scient-accountabc";
    expect(secretRequestPrivacyNote({ id: account })).toBe("Saved to Accounts");
    // A password card never says agents can read it: they use it, unseen. Real ids carry the
    // run before the request, encoded with it.
    const password = "turn-item:secret-request:thread-1:run-1%3Ascient-account%3Apassword%3Aabc";
    expect(secretRequestPrivacyNote({ id: password })).toBe("Saved · agents can use it");
    expect(secretRequestPrivacyNote({ id: "turn-item:secret-request:t:run-1%3Aother" })).toBe(
      "Stored securely, never shown to the agent",
    );
    expect(secretRequestDisplay({ id: account, secretStatus: "saved" }, "local")).toMatchObject({
      label: "Saved to Accounts",
    });
    expect(secretRequestPrivacyNote({ id: ordinary })).toBe(
      "Stored securely, never shown to the agent",
    );
    expect(secretRequestDisplay({ id: ordinary, secretStatus: "saved" }, "local")).toMatchObject({
      label: "Sent to this agent only, not kept in Accounts",
    });
  });
});

describe("an Accounts card's end", () => {
  it("says Saved only once Accounts kept it, and tells a timeout from a cancel", () => {
    const id = "turn-item:secret-request:thread-1:run-1%3Ascient-account%3Akey%3Aabc";
    const cards = [{ requestId: "scient-account:key:abc", outcome: "timed_out" as const }];
    expect(accountCardLabel({ id, secretStatus: "saved" }, undefined)).toBe("Saving…");
    expect(
      accountCardLabel({ id, secretStatus: "cancelled" }, accountCardOutcome({ cards }, id)),
    ).toBe("Timed out");
    // Saving… only while Accounts is keeping it; an outcome no longer kept reads as ended.
    const saved = (snapshot: Parameters<typeof accountCardOutcome>[0]) =>
      accountCardLabel({ id, secretStatus: "saved" }, accountCardOutcome(snapshot, id));
    expect(saved({ cards: [], cardsSettling: ["scient-account:key:abc"] })).toBe("Saving…");
    expect(saved({ cards: [], cardsSettling: [] })).toBe("Ended");
    // A server that doesn't say which cards are settling: as before.
    expect(saved({ cards: [] })).toBe("Saving…");
    expect(
      accountCardLabel({ id: "turn-item:secret-request:t:x", secretStatus: "saved" }, "saved"),
    ).toBeUndefined();
  });
});

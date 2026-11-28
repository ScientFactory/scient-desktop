import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { SecretProviderId } from "../secretReference.ts";
import {
  AccountId,
  AccountsSnapshot,
  accountKeyReference,
  keyServesOrigin,
  keyServesUse,
  referencedAccountId,
} from "./accounts.ts";

describe("keyServesOrigin", () => {
  it("lets a key saved by host serve that host over https only", () => {
    const sites = ["api.openai.com"];
    expect(keyServesOrigin(sites, "https://api.openai.com")).toBe(true);
    expect(keyServesOrigin(sites, "http://api.openai.com")).toBe(false);
    expect(keyServesOrigin(sites, "https://api.openai.com:8443")).toBe(false);
    expect(keyServesOrigin(sites, "https://eu.api.openai.com")).toBe(false);
    expect(keyServesOrigin(["http://127.0.0.1:1234"], "http://127.0.0.1:1234")).toBe(true);
  });
});

describe("referencedAccountId", () => {
  it("leaves a secret provider the person named scient-accounts to that provider", () => {
    const accountId = AccountId.make("acc_synthetic1");
    expect(referencedAccountId(accountKeyReference(accountId))).toBe(accountId);
    expect(
      referencedAccountId({
        provider: SecretProviderId.make("scient-accounts"),
        reference: "op://Work/OpenAI/credential",
      }),
    ).toBeUndefined();
  });
});

describe("keyServesUse", () => {
  const key = (extra: object) =>
    ({
      details: { kind: "api-key", sites: ["openrouter.ai"], auth: { type: "bearer" }, ...extra },
    }) as never;
  it("lets a key kept for one use serve only it, and a legacy Voice key only Voice and agents", () => {
    const kept = key({ privateTo: { kind: "text-generator", id: "titles", name: "Titles" } });
    expect(keyServesUse(kept, { kind: "text-generator", id: "titles" })).toBe(true);
    for (const use of [
      { kind: "text-generator", id: "other" },
      { kind: "voice", id: "" },
      { kind: "library", id: "zotero" },
      { kind: "variable", id: "" },
      { kind: "request", id: "" },
    ] as const)
      expect(keyServesUse(kept, use)).toBe(false);
    const speech = key({ speechOnly: true });
    expect(keyServesUse(speech, { kind: "voice", id: "" })).toBe(true);
    expect(keyServesUse(speech, { kind: "request", id: "" })).toBe(true);
    expect(keyServesUse(speech, { kind: "library", id: "zotero" })).toBe(false);
    expect(keyServesUse(key({}), { kind: "library", id: "zotero" })).toBe(true);
  });
});

describe("AccountsSnapshot", () => {
  it("decodes for a client older than agents' changes, with or without them", () => {
    const snapshot = {
      agentAccess: true,
      accounts: [],
      profiles: [],
      approvals: [],
      recentActivity: [],
      customModelKeys: [],
      stores: {
        scient: { protection: "file" },
        keychain: { available: false, platform: "linux" },
        onePassword: { state: "not-connected" },
      },
    };
    const changes = [
      {
        at: "2026-11-26T10:00:00.000Z",
        target: { type: "profile", profileId: "work" },
        change: "controls",
      },
    ];
    // An older client's snapshot has no `changes`: the field is passed over, never refused.
    const { changes: _, ...olderFields } = AccountsSnapshot.fields;
    const older = Schema.decodeUnknownSync(Schema.Struct(olderFields));
    expect(older({ ...snapshot, changes })).not.toHaveProperty("changes");
    const current = Schema.decodeUnknownSync(AccountsSnapshot);
    expect(current({ ...snapshot, changes }).changes).toHaveLength(1);
    expect(current(snapshot).changes).toBeUndefined();
  });
});

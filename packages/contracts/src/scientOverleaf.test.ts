import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ScientOverleafAccountRequest,
  ScientOverleafContinueRequest,
  ScientOverleafReviewConfirmationRequest,
  ScientOverleafSaveAccountRequest,
} from "./scientOverleaf.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const commit = "0123456789abcdef0123456789abcdef01234567";

describe("Scient Overleaf contracts", () => {
  it("rejects traversal and non-UUID opaque IDs at the HTTP boundary", () => {
    const decode = Schema.decodeUnknownSync(ScientOverleafAccountRequest);
    expect(() => decode({ accountId: "../connections/victim" })).toThrow();
    expect(() => decode({ accountId: "not-an-id" })).toThrow();
    expect(decode({ accountId: id })).toEqual({ accountId: id });
  });

  it("rejects invalid generations and forged candidate object IDs", () => {
    const decode = Schema.decodeUnknownSync(ScientOverleafReviewConfirmationRequest);
    expect(() =>
      decode({
        operationId: id,
        generation: 0,
        candidateCommit: commit,
        acknowledgeWarnings: true,
        suppressFutureRenameWarnings: false,
      }),
    ).toThrow();
    expect(() =>
      decode({
        operationId: id,
        generation: 1,
        candidateCommit: "../../HEAD",
        acknowledgeWarnings: true,
        suppressFutureRenameWarnings: false,
      }),
    ).toThrow();
  });

  it("rejects control characters in identity and commit metadata", () => {
    const decodeAccount = Schema.decodeUnknownSync(ScientOverleafSaveAccountRequest);
    expect(() =>
      decodeAccount({
        label: "Overleaf",
        kind: "cloud",
        host: "git.overleaf.com",
        authorName: "Human\nInjected <attacker@example.com>",
        authorEmail: "human@example.com",
        token: "token",
      }),
    ).toThrow();

    const decodeContinue = Schema.decodeUnknownSync(ScientOverleafContinueRequest);
    expect(() => decodeContinue({ operationId: id, commitMessage: "Update\nInjected" })).toThrow();
  });
});

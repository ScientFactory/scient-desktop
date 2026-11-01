import { expect, it } from "@effect/vitest";
import {
  parseMacKeychain,
  parseWindowsKeychain,
  selectKeychainCandidates,
} from "./KeychainCandidates.ts";

it("lists only generic-password metadata from macOS security output", () => {
  const text =
    'keychain: "/synthetic/keychain"\nclass: "genp"\nattributes:\n    "acct"<blob>="user\\"name"\n    "svce"<blob>="Example service"\nkeychain: "/synthetic/keychain"\nclass: "inet"\n    "acct"<blob>="ignored"\n    "svce"<blob>="ignored"\nkeychain: "/synthetic/keychain"\nclass: "genp"\n    "svce"<blob>="missing-account"';
  expect(parseMacKeychain(text)).toEqual([{ service: "Example service", account: 'user"name' }]);
});
it("parses Windows targets and users without credential material", () => {
  expect(
    parseWindowsKeychain(
      "Currently stored credentials:\n Target: LegacyGeneric:target=example\n Type: Generic\n User: synthetic-user\n Target: missing-user\n Type: Generic\n",
    ),
  ).toEqual([{ service: "example", account: "synthetic-user" }]);
});
it("filters metadata, deduplicates, sorts and caps candidates", () => {
  const candidates = Array.from({ length: 220 }, (_, index) => ({
    service: `service-${String(219 - index).padStart(3, "0")}`,
    account: "user",
  }));
  const result = selectKeychainCandidates([...candidates, candidates[0]!], " USER ");
  expect(result.length).toBe(200);
  expect(result[0]?.service).toBe("service-000");
  expect(result[199]?.service).toBe("service-199");
  expect(selectKeychainCandidates(candidates, "absent")).toEqual([]);
});

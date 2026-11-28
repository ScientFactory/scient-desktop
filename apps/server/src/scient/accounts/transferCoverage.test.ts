import { describe, expect, it } from "@effect/vitest";
import { BrowserProfileId } from "@t3tools/contracts";
import { Effect } from "effect";
import { makeHarness, website } from "./Accounts.testkit.ts";
import type { ProfileStore } from "./AccountsService.ts";

const lab = BrowserProfileId.make("profile-lab");
const home = BrowserProfileId.make("profile-home");

/** This server's browser holds none of the profile's sign-ins: only the desktop has them. */
const emptyHere: ProfileStore = {
  desktop: true,
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: () => Effect.succeed({ cookies: [] }),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: (_from, _into, _sites, keep) =>
    keep({ before: [], copied: [] }).pipe(Effect.as({ copied: 0, uncovered: [], sites: [] })),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
};

describe("a merge keeps every sign-in, wherever it is (round 6c, finding 4)", () => {
  it.effect("refuses a private window as the destination: it keeps nothing", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const merged = yield* service.operateProfile(
        {
          operationId: "op-merge",
          kind: "merge",
          profileId: lab,
          into: BrowserProfileId.make("incognito"),
        },
        undefined,
        [],
      );
      expect(merged.refused?.reason).toBe("not-allowed");
    }),
  );

  it.effect(
    "copies the logins chosen and keeps the desktop's site list, whatever this server held",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        yield* service.attachProfileStore(emptyHere);
        yield* service.save({ ...website(), details: { ...website().details, profileId: lab } });
        const merged = (yield* service.operateProfile(
          { operationId: "op-merge", kind: "merge", profileId: lab, into: home },
          undefined,
          [],
        )).operation!;
        // This server's browser had nothing, but the login still comes, and the desktop copies
        // every site of its own, not the server's empty list.
        expect(merged.rowsAdded).toHaveLength(1);
        expect(merged.sites).toBeUndefined();
        expect(merged.desktop).toEqual({ state: "pending" });
        // Its source is kept until the desktop's part is done too.
        expect(merged.retiredSource).toBeUndefined();
      }),
  );
});

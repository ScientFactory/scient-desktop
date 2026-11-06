import { describe, expect, it } from "@effect/vitest";
import { AccountsError, BrowserProfileId, DEFAULT_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { Effect, Fiber, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeHarness, memoryStore, website } from "./Accounts.testkit.ts";

describe("Main's record", () => {
  const MAIN = BrowserProfileId.make("default");
  const row = (profileId: string, sites: string[], username?: string) => ({
    name: sites[0]!,
    details: {
      kind: "website" as const,
      sites,
      profileId: BrowserProfileId.make(profileId),
      ...(username === undefined ? {} : { username }),
    },
    secrets: {},
  });

  it.effect("updates Main's row for a copied sign-in, or makes one, and never duplicates it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const work = yield* service.save(row("profile-work", ["overleaf.com"], "person@example.com"));
      // Main already keeps a saved password for the same person.
      const saved = yield* service.save({
        ...website(),
        details: {
          ...website().details,
          sites: ["overleaf.com"],
          username: "person@example.com",
          profileId: MAIN,
        },
      });
      yield* service.mainFilled({ accountId: work.accountId, profileName: "Work" });
      yield* service.mainFilled({ accountId: work.accountId, profileName: "Work" });
      const github = yield* service.save(row("profile-work", ["github.com"]));
      yield* service.mainFilled({ accountId: github.accountId, profileName: "Work" });
      const university = yield* service.save({
        ...row("profile-work", ["university.example"]),
        details: {
          ...row("profile-work", ["university.example"]).details,
          institution: {
            name: "Synthetic University",
            entityId: "https://idp.university.example/entity",
            domain: "university.example",
          },
        },
      });
      yield* service.mainFilled({ accountId: university.accountId, profileName: "Work" });
      const main = (yield* service.snapshot).accounts.filter(
        ({ details }) => details.kind === "website" && details.profileId === MAIN,
      );
      expect(
        main.map(({ accountId, details, signIn, secrets }) => [
          accountId === saved.accountId,
          details.kind === "website" ? details.sites : [],
          signIn?.state,
          signIn?.from,
          Object.keys(secrets),
          details.kind === "website" ? details.origin : undefined,
        ]),
      ).toEqual([
        // A saved password stays fillable; a copy with nothing to type is the session.
        [true, ["overleaf.com"], "unknown", "copy", ["password"], undefined],
        [false, ["github.com"], "unknown", "copy", [], "browser-session"],
      ]);
    }),
  );

  it.effect("reads Main's sign-outs and back-fill stored on its record as its `main`", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      yield* service.mainBackfilled([BrowserProfileId.make("profile-work")]);
      yield* service.profileSignedOut(MAIN, "github.com");
      const name = "accounts-state";
      const stored = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      ) as { profiles: Array<Record<string, unknown>> };
      // The earlier shape: the two lists straight on Main's record.
      stored.profiles = stored.profiles.map(({ main, ...profile }) => ({
        ...profile,
        ...(main as object),
      }));
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      const restarted = yield* makeHarness({ storage });
      const main = (yield* restarted.service.snapshot).profiles.find(
        (profile) => profile.profileId === MAIN,
      );
      expect(main?.main).toEqual({ signedOutSites: ["github.com"], backfilled: ["profile-work"] });
    }),
  );

  it.effect("records the back-fill once per profile, and an empty one as done", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const backfilled = Effect.map(
        service.snapshot,
        ({ profiles }) => profiles.find((profile) => profile.profileId === MAIN)?.main?.backfilled,
      );
      yield* service.mainBackfilled([]);
      expect(yield* backfilled).toEqual([]);
      yield* service.mainBackfilled([BrowserProfileId.make("profile-work")]);
      yield* service.mainBackfilled([BrowserProfileId.make("profile-work")]);
      expect(yield* backfilled).toEqual(["profile-work"]);
    }),
  );

  it.effect("keeps Accounts' sign-outs on Main until a sign-in action there", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const signedOut = Effect.map(
        service.snapshot,
        ({ profiles }) =>
          profiles.find((profile) => profile.profileId === MAIN)?.main?.signedOutSites,
      );
      const cleared = (run: Effect.Effect<void, AccountsError>, site = "github.com") =>
        Effect.gen(function* () {
          yield* service.profileSignedOut(DEFAULT_BROWSER_PROFILE_ID, site);
          expect(yield* signedOut).toEqual([site]);
          yield* run;
          expect(yield* signedOut).toBeUndefined();
        });
      yield* service.profileSignedOut(DEFAULT_BROWSER_PROFILE_ID, "github.com");
      // Looks never clear it: a row appearing, a Check, a copy.
      yield* service.save(row("default", ["github.com"]));
      const main = (yield* service.save(row("default", ["github.com"], "person"))).accountId;
      yield* service.recordCheck(main, { state: "signed-in" });
      expect(yield* signedOut).toEqual(["github.com"]);
      yield* TestClock.adjust("1 minute");
      const settled = yield* service.changes.pipe(
        Stream.filter(({ profiles }) => profiles.every((profile) => !profile.main?.signedOutSites)),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* service.recordUse({
        target: { type: "account", accountId: main },
        action: "sign-in",
        outcome: "ok",
        signInOutcome: "signed-in",
      });
      yield* Fiber.join(settled);
      yield* cleared(
        Effect.asVoid(
          service.googleSessionsSeen({
            profileId: MAIN,
            sessions: [{ email: "person@example.com", valid: true }],
          }),
        ),
        "google.com",
      );
      yield* service.profileSignedOut(DEFAULT_BROWSER_PROFILE_ID, "github.com");
      // A sign-in in another profile leaves Main's record alone.
      const other = (yield* service.save(row("profile-work", ["github.com"], "other"))).accountId;
      yield* service.recordUse({
        target: { type: "account", accountId: other },
        action: "sign-in",
        outcome: "ok",
        signInOutcome: "signed-in",
      });
      yield* TestClock.adjust("1 second");
      expect(yield* signedOut).toEqual(["github.com"]);
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import {
  AccountsError,
  AccountsSnapshot,
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  ProjectId,
  defaultBrowserProfileRecord,
  ThreadId,
  defaultAccountControls,
} from "@t3tools/contracts";
import { Clock, Deferred, Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { TOTP } from "otpauth";
import { issueUnit, withShared } from "./sendLog.ts";
import {
  makeHarness,
  memoryStore,
  secretEquals,
  syntheticValue,
  website,
} from "./Accounts.testkit.ts";

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(AccountsSnapshot));
const scope = {
  threadId: ThreadId.make("synthetic-thread"),
  projectId: ProjectId.make("synthetic-project"),
  unattended: false,
};
const waitingApproval = (service: import("./AccountsService.ts").AccountsServiceShape) =>
  service.changes.pipe(
    Stream.filter((snapshot) => snapshot.approvals.length > 0),
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([snapshot]) => snapshot!.approvals[0]!),
  );

describe("AccountsService persistence", () => {
  it.effect("keeps one row per Google address in a profile, following what Google reports", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ storage: memoryStore() });
      const profileId = BrowserProfileId.make("profile-work");
      const saved = yield* service.save(website(syntheticValue()));
      const rows = Effect.map(service.snapshot, ({ accounts }) =>
        accounts.filter(({ accountId }) => accountId !== saved.accountId),
      );
      yield* service.googleSessionsSeen({
        profileId,
        sessions: [
          { email: "a@example.com", valid: true },
          { email: "b@example.com", valid: false },
        ],
      });
      expect(
        (yield* rows).map(({ details, signIn }) => [
          details.kind === "website" ? details.username : undefined,
          details.kind === "website" ? details.origin : undefined,
          signIn?.state,
        ]),
      ).toEqual([
        ["a@example.com", "browser-session", "signed-in"],
        ["b@example.com", "browser-session", "signed-out"],
      ]);
      // Seen again, with the first signed out and the second gone from Google's list.
      yield* service.googleSessionsSeen({
        profileId,
        sessions: [{ email: "a@example.com", valid: false }],
      });
      const after = yield* rows;
      expect(after.map(({ signIn }) => signIn?.state)).toEqual(["signed-out", "signed-out"]);
      expect(after).toHaveLength(2);
      // Another profile keeps its own row; the saved password is never touched.
      yield* service.googleSessionsSeen({
        profileId: BrowserProfileId.make("profile-home"),
        sessions: [{ email: "a@example.com", valid: true }],
      });
      expect(yield* rows).toHaveLength(3);
      expect(
        (yield* service.snapshot).accounts.find(({ accountId }) => accountId === saved.accountId)
          ?.signIn,
      ).toBeUndefined();
    }),
  );

  it.effect("keeps a Google username saved by hand unmarked across a restart", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      for (const profileId of [undefined, BrowserProfileId.make("profile-work")])
        yield* service.save({
          name: "Google",
          details: {
            kind: "website",
            sites: ["google.com"],
            username: "a@example.com",
            ...(profileId ? { profileId } : {}),
          },
          secrets: {},
        });
      const restarted = yield* makeHarness({ storage });
      expect(
        (yield* restarted.service.snapshot).accounts.map(({ details }) =>
          details.kind === "website" ? [details.profileId, details.origin] : [],
        ),
      ).toEqual([
        [undefined, undefined],
        ["profile-work", undefined],
      ]);
    }),
  );

  it.effect(
    "writes encrypted values before metadata, retains old values on failure, and survives restart",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service } = yield* makeHarness({ storage });
        const value = syntheticValue();
        const input = website(value);
        const { accountId } = yield* service.save(input);
        const valueWrite = storage.operations.findIndex((operation) =>
          operation.startsWith("set:accounts-value-"),
        );
        expect(valueWrite).toBeGreaterThan(-1);
        expect(storage.operations.indexOf("set:accounts-state")).toBeGreaterThan(valueWrite);
        expect([...storage.blobs.values()].some((blob) => Buffer.from(blob).includes(value))).toBe(
          false,
        );
        const snapshot = yield* service.snapshot;
        const json = yield* encodeSnapshot(snapshot);
        expect(json.includes(value)).toBe(false);
        const oldValues = [...storage.blobs.keys()].filter((name) =>
          name.startsWith("accounts-value-"),
        );
        storage.failWritesTo("accounts-state");
        expect(
          (yield* service
            .save({
              ...input,
              accountId,
              secrets: { password: { type: "scient", value: syntheticValue() } },
            })
            .pipe(Effect.flip)).reason,
        ).toBe("unavailable");
        expect(oldValues.every((name) => storage.blobs.has(name))).toBe(true);
        storage.failWritesTo(undefined);
        const restarted = yield* makeHarness({ storage });
        expect(
          secretEquals(
            (yield* restarted.service.resolveSecrets(accountId, ["password"])).password,
            value,
          ),
        ).toBe(true);
        yield* restarted.service.save({
          ...input,
          accountId,
          secrets: { password: { type: "scient", value: syntheticValue() } },
        });
        expect(oldValues.some((name) => storage.blobs.has(name))).toBe(false);
        yield* restarted.service.remove(accountId);
        expect((yield* restarted.service.snapshot).accounts).toEqual([]);
        expect(
          (yield* restarted.service.resolveSecrets(accountId, ["password"]).pipe(Effect.flip))
            .reason,
        ).toBe("not-found");
      }),
  );
  it.effect("preserves unreadable state rather than replacing it", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      yield* first.service.save(website());
      const blob = storage.blobs.get("accounts-state")!;
      blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
      const before = Buffer.from(blob);
      const restarted = yield* makeHarness({ storage });
      expect((yield* restarted.service.save(website()).pipe(Effect.flip)).reason).toBe(
        "unavailable",
      );
      expect(before.equals(Buffer.from(storage.blobs.get("accounts-state")!))).toBe(true);
    }),
  );
  it.effect(
    "rejects foreign secret fields, removes fields on kind changes, and limits hints to API tokens",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        expect(
          (yield* service
            .save({ ...website(), secrets: { token: { type: "scient", value: syntheticValue() } } })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-input");
        const { accountId } = yield* service.save(website());
        expect((yield* service.snapshot).accounts[0]?.secrets.password?.hint).toBeUndefined();
        const value = syntheticValue();
        yield* service.save({
          accountId,
          name: "Synthetic API",
          details: { kind: "api-key", sites: ["example.com"], auth: { type: "bearer" } },
          secrets: { token: { type: "scient", value } },
        });
        const account = (yield* service.snapshot).accounts[0]!;
        expect(Object.keys(account.secrets)).toEqual(["token"]);
        expect(account.secrets.token?.hint === value.slice(-4)).toBe(true);
        yield* service.save({
          accountId,
          name: account.name,
          details: account.details,
          secrets: { token: { type: "clear" } },
        });
        expect(Object.keys((yield* service.snapshot).accounts[0]!.secrets)).toEqual([]);
      }),
  );
  it.effect("stores CLI secrets whose variable names also name object prototype properties", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      const value = syntheticValue();
      const field = "__proto__";
      const { accountId } = yield* service.save({
        name: "Synthetic CLI",
        details: { kind: "cli-login", tool: "other", variables: [{ name: field, secret: true }] },
        secrets: { [field]: { type: "scient", value } },
      });
      expect(secretEquals((yield* service.resolveSecrets(accountId, [field]))[field], value)).toBe(
        true,
      );
      yield* service.save({
        accountId,
        name: "Synthetic CLI",
        details: { kind: "cli-login", tool: "other", variables: [{ name: field, secret: true }] },
        secrets: {},
      });
      expect(secretEquals((yield* service.resolveSecrets(accountId, [field]))[field], value)).toBe(
        true,
      );
      const restarted = yield* makeHarness({ storage });
      expect(
        secretEquals((yield* restarted.service.resolveSecrets(accountId, [field]))[field], value),
      ).toBe(true);
      const empty = yield* service.save({
        name: "Synthetic empty CLI",
        details: {
          kind: "cli-login",
          tool: "other",
          variables: [{ name: "constructor", secret: true }],
        },
        secrets: {},
      });
      expect(Object.keys(yield* service.resolveSecrets(empty.accountId, ["constructor"]))).toEqual(
        [],
      );
    }),
  );
  it.effect(
    "updates and skips imported accounts by site and username, keeping the user's name",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const value = syntheticValue();
        const content = `name,url,username,password,note\nSynthetic,https://login.example.com/path,user,${value},\nSynthetic,https://login.example.com/path,user,${value},`;
        expect(
          yield* service.importPasswords({ format: "auto", content, profileId: "imported" }),
        ).toEqual({ created: 1, updated: 0, skipped: 1 });
        const next = syntheticValue();
        expect(
          yield* service.importPasswords({
            format: "auto",
            content: content.replaceAll(value, next),
          }),
        ).toEqual({ created: 0, updated: 1, skipped: 1 });
        const account = (yield* service.snapshot).accounts[0]!;
        expect(
          secretEquals(
            (yield* service.resolveSecrets(account.accountId, ["password"])).password,
            next,
          ),
        ).toBe(true);
        expect(
          yield* service.importPasswords({
            format: "auto",
            content: content.replaceAll(value, next).replaceAll("Synthetic,", "Renamed,"),
          }),
        ).toEqual({ created: 0, updated: 0, skipped: 2 });
        const changed = (yield* service.snapshot).accounts[0]!;
        expect(changed.name).toBe("Synthetic");
        expect(changed.details.kind === "website" && changed.details.profileId).toBe("imported");
      }),
  );
});

describe("AccountsService profiles and evidence", () => {
  it.effect("keeps the same login imported into two profiles as two rows", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const content = `name,url,username,password,note\nSynthetic,https://login.example.com/,user,${syntheticValue()},\n`;
      yield* service.importPasswords({ format: "auto", content, profileId: "profile-a" });
      yield* service.importPasswords({ format: "auto", content, profileId: "profile-b" });
      expect(
        (yield* service.snapshot).accounts.map(({ details }) =>
          details.kind === "website" ? details.profileId : undefined,
        ),
      ).toEqual(["profile-a", "profile-b"]);
    }),
  );

  it.effect("ends a removed profile's sign-ins and keeps its saved passwords", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("profile-gone");
      yield* service.googleSessionsSeen({
        profileId,
        sessions: [{ email: "a@example.com", valid: true }],
      });
      yield* service.importPasswords({
        format: "auto",
        content: `name,url,username,password,note\nSynthetic,https://login.example.com/,user,${syntheticValue()},\n`,
        profileId,
      });
      yield* service.removeProfile(profileId);
      const { accounts } = yield* service.snapshot;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.name).toBe("Synthetic");
      expect(accounts[0]?.details.kind === "website" && accounts[0].details.profileId).toBe(
        undefined,
      );
    }),
  );
});

describe("AccountsService and Main", () => {
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
          signIn?.detail,
          Object.keys(secrets),
          details.kind === "website" ? details.origin : undefined,
        ]),
      ).toEqual([
        // A saved password stays fillable; a copy with nothing to type is the session.
        [true, ["overleaf.com"], "unknown", "Copied from Work", ["password"], undefined],
        [false, ["github.com"], "unknown", "Copied from Work", [], "browser-session"],
      ]);
    }),
  );

  it.effect("records the back-fill once per profile, and an empty one as done", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const backfilled = Effect.map(
        service.snapshot,
        ({ profiles }) => profiles.find((profile) => profile.profileId === MAIN)?.backfilled,
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
        ({ profiles }) => profiles.find((profile) => profile.profileId === MAIN)?.signedOutSites,
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
        Stream.filter(({ profiles }) => profiles.every((profile) => !profile.signedOutSites)),
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

  it.effect("writes every action with a new date, and a repeated look once an hour", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(row("profile-work", ["github.com"]));
      const signIn = Effect.map(
        service.snapshot,
        ({ accounts }) => accounts.find((account) => account.accountId === accountId)?.signIn,
      );
      const used = Effect.gen(function* () {
        const before = (yield* signIn)?.at;
        const written = yield* service.changes.pipe(
          Stream.filter(({ accounts }) =>
            accounts.some(
              (account) => account.accountId === accountId && account.signIn?.at !== before,
            ),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* service.recordUse({
          target: { type: "account", accountId },
          action: "sign-in",
          outcome: "ok",
          signInOutcome: "signed-in",
        });
        yield* Fiber.join(written);
      });
      yield* service.recordCheck(accountId, { state: "signed-in" });
      const look = yield* signIn;
      expect(look?.by).toBe("look");
      yield* TestClock.adjust("10 minutes");
      yield* service.recordCheck(accountId, { state: "signed-in" });
      expect(yield* signIn).toEqual(look);
      yield* used;
      const action = yield* signIn;
      expect(action).toMatchObject({ state: "signed-in", by: "action" });
      yield* TestClock.adjust("1 minute");
      yield* used;
      expect((yield* signIn)?.at).not.toBe(action?.at);
      // A changed state is always written; the same one again after the hour.
      yield* TestClock.adjust("20 minutes");
      yield* service.recordCheck(accountId, { state: "signed-out" });
      expect(yield* signIn).toMatchObject({ state: "signed-out", by: "look" });
      yield* TestClock.adjust("61 minutes");
      const dated = (yield* signIn)?.at;
      yield* service.recordCheck(accountId, { state: "signed-out" });
      expect((yield* signIn)?.at).not.toBe(dated);
    }),
  );

  it.effect("keeps one session row per site in a profile, from imports and sign-ins seen", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const work = BrowserProfileId.make("profile-work");
      // A saved password and a university on the same sites never take a session.
      yield* service.save({
        ...website(),
        details: { ...website().details, sites: ["github.com"], profileId: work },
      });
      yield* service.save({
        ...row("profile-work", ["huji.ac.il"]),
        details: {
          ...row("profile-work", ["huji.ac.il"]).details,
          institution: { name: "HUJI", entityId: "https://idp.huji.ac.il", domain: "huji.ac.il" },
        },
      });
      const sessions = Effect.map(service.snapshot, ({ accounts }) =>
        accounts
          .filter(
            (account) =>
              account.details.kind === "website" && account.details.origin === "browser-session",
          )
          .map((account) => [
            account.details.kind === "website" ? account.details.sites : [],
            account.signIn?.state,
            account.signIn?.by,
            account.signIn?.detail,
          ]),
      );
      const imported = yield* service.sessionsSeen({
        profileId: work,
        sessions: [
          { site: "github.com", how: "imported", from: "Chrome · Person" },
          { site: "huji.ac.il", how: "imported", from: "Chrome · Person" },
          { site: "google.com", how: "imported", from: "Chrome · Person" },
        ],
      });
      expect(imported.created).toHaveLength(2);
      const again = yield* service.sessionsSeen({
        profileId: work,
        sessions: [{ site: "github.com", how: "imported", from: "Chrome · Other" }],
      });
      expect(again.created).toEqual([]);
      expect(yield* sessions).toEqual([
        [["github.com"], "unknown", "look", "Imported from Chrome · Person"],
        [["huji.ac.il"], "unknown", "look", "Imported from Chrome · Person"],
      ]);
      // A sign-in seen there confirms the row; a later import never takes it back to unknown.
      yield* service.sessionsSeen({
        profileId: work,
        sessions: [{ site: "github.com", how: "signed-in" }],
      });
      yield* service.sessionsSeen({
        profileId: work,
        sessions: [{ site: "github.com", how: "imported", from: "Chrome · Person" }],
      });
      expect(yield* sessions).toContainEqual([["github.com"], "signed-in", "action", undefined]);
      // In another profile, a sign-in seen makes its own row.
      const home = yield* service.sessionsSeen({
        profileId: BrowserProfileId.make("profile-home"),
        sessions: [{ site: "github.com", how: "signed-in" }],
      });
      expect(home.created).toHaveLength(1);
      expect(yield* sessions).toHaveLength(3);
    }),
  );

  it.effect("keeps a typed password once, never on a removed, Off or linked row", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const typed = { username: "person", password: Redacted.make("typed-password") };
      const session = (yield* service.save(row("profile-work", ["example.com"]))).accountId;
      yield* service.recordUse({
        target: { type: "account", accountId: session },
        action: "sign-in",
        outcome: "ok",
        signInOutcome: "signed-in",
      });
      yield* TestClock.adjust("1 second");
      expect(yield* service.keepTyped(session, typed)).toBe("kept");
      const kept = (yield* service.snapshot).accounts.find((row) => row.accountId === session)!;
      expect(kept.details).toMatchObject({ username: "person" });
      // The sign-in it came from stands; nothing yet shows the kept password is the one that worked.
      expect(kept.signIn).toMatchObject({ state: "signed-in", by: "action" });
      expect(kept.secrets.password?.verifiedAt).toBeUndefined();
      expect(
        secretEquals(
          (yield* service.resolveSecrets(session, ["password"])).password,
          "typed-password",
        ),
      ).toBe(true);
      expect((yield* service.activity({}))[0]).toMatchObject({ keptTyped: "kept" });
      // Linked: left in its store, with a line saying so.
      const linked = (yield* service.save({
        ...website(),
        secrets: { password: { type: "keychain", service: "synthetic", account: "synthetic" } },
      })).accountId;
      expect(yield* service.keepTyped(linked, typed)).toBe("linked");
      expect(
        (yield* service.snapshot).accounts.find((row) => row.accountId === linked)?.secrets.password
          ?.source,
      ).toMatchObject({ type: "keychain" });
      // Off, or removed meanwhile: nothing written, nothing made.
      yield* service.setControls({
        target: { type: "account", accountId: session },
        access: "off",
      });
      expect(
        yield* service.keepTyped(session, { ...typed, password: Redacted.make("other") }),
      ).toBe("dropped");
      yield* service.remove(session);
      expect(yield* service.keepTyped(session, typed)).toBe("dropped");
      expect((yield* service.snapshot).accounts.map((row) => row.accountId)).toEqual([linked]);
    }),
  );

  it.effect("verifies a kept password only when Scient signs in with it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const kept = (outcome: "signed-in" | "password-rejected") =>
        Effect.gen(function* () {
          const { accountId } = yield* service.save(row("profile-work", [`${outcome}.example`]));
          // What a silent sign-in elsewhere after a wrong password can leave: kept, unverified.
          yield* service.keepTyped(accountId, {
            username: "person",
            password: Redacted.make("typed-password"),
          });
          const read = Effect.map(service.snapshot, ({ accounts }) =>
            accounts.find((account) => account.accountId === accountId)!,
          );
          expect((yield* read).secrets.password?.verifiedAt).toBeUndefined();
          // The next sign-in, where Scient's engine typed it.
          const settled = yield* service.changes.pipe(
            Stream.filter(({ accounts }) =>
              accounts.some(
                (account) => account.accountId === accountId && account.signIn?.state === outcome,
              ),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* service.recordUse({
            target: { type: "account", accountId },
            action: "sign-in",
            outcome: outcome === "signed-in" ? "ok" : "error",
            signInOutcome: outcome,
            savedPasswordUsed: true,
          });
          yield* Fiber.join(settled);
          return yield* read;
        });
      expect((yield* kept("signed-in")).secrets.password?.verifiedAt).toBeDefined();
      // A wrong one is refused once: the row says so, holds, and the password stays unverified.
      const refused = yield* kept("password-rejected");
      expect(refused.signIn?.state).toBe("password-rejected");
      expect(refused.secrets.password?.verifiedAt).toBeUndefined();
    }),
  );

  it.effect("names a session row from the page, and never a row with a password", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const session = (yield* service.save(row("profile-work", ["github.com"]))).accountId;
      const saved = (yield* service.save(website())).accountId;
      for (const accountId of [session, saved])
        yield* service.recordCheck(accountId, { state: "signed-in", username: "octo" });
      const details = Effect.map(service.snapshot, ({ accounts }) =>
        accounts.map((account) =>
          account.details.kind === "website"
            ? [account.details.username, account.details.origin]
            : [],
        ),
      );
      expect(yield* details).toEqual([
        ["octo", "browser-session"],
        ["synthetic-user", undefined],
      ]);
    }),
  );
});

describe("AccountsService source resolution", () => {
  it.effect(
    "resolves links, caches 1Password per account for five minutes, and clears it on disconnect",
    () =>
      Effect.gen(function* () {
        const linked = syntheticValue();
        let reads = 0;
        const { service } = yield* makeHarness({
          sourceOverrides: {
            keychain: () => Effect.succeed(Redacted.make(linked)),
            customModel: () => Effect.succeed(Redacted.make(linked)),
            onePassword: () =>
              Effect.succeed({
                label: "Synthetic vault",
                resolve: () =>
                  Effect.sync(() => {
                    reads++;
                    return Redacted.make(linked);
                  }),
              }),
          },
        });
        yield* service.connectOnePassword({ mode: "service-account", token: syntheticValue() });
        const { accountId } = yield* service.save({
          ...website(),
          secrets: {
            password: { type: "1password", reference: "op://synthetic/item/password" },
            totp: { type: "keychain", service: "synthetic", account: "user" },
          },
        });
        expect(
          secretEquals(
            (yield* service.resolveSecrets(accountId, ["password", "totp"])).password,
            linked,
          ),
        ).toBe(true);
        yield* service.resolveSecrets(accountId, ["password"]);
        expect(reads).toBe(1);
        yield* TestClock.adjust("5 minutes");
        yield* service.resolveSecrets(accountId, ["password"]);
        expect(reads).toBe(2);
        const other = yield* service.save({
          name: "Synthetic API",
          details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
          secrets: { token: { type: "custom-model", connectionId: "synthetic" } },
        });
        expect(
          secretEquals((yield* service.resolveSecrets(other.accountId, ["token"])).token, linked),
        ).toBe(true);
        yield* service.disconnectOnePassword;
        expect(
          (yield* service.resolveSecrets(accountId, ["password"]).pipe(Effect.flip)).reason,
        ).toBe("unavailable");
      }),
  );
  it.effect("reports safe source failures and tests without returning values", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      expect(
        (yield* service.connectOnePassword({ mode: "desktop", accountName: "synthetic" }))
          .onePassword,
      ).toMatchObject({ state: "error", message: "Synthetic source unavailable." });
      const { accountId } = yield* service.save({
        ...website(),
        secrets: { password: { type: "keychain", service: "synthetic", account: "user" } },
      });
      expect((yield* service.test(accountId).pipe(Effect.flip)).message).toBe(
        "Synthetic source unavailable.",
      );
      expect((yield* service.snapshot).accounts[0]?.status).toBe("needs-attention");
      yield* service.save({ ...website(), accountId });
      yield* service.test(accountId);
      expect((yield* service.snapshot).accounts[0]?.status).toBe("ready");
      expect((yield* service.snapshot).accounts[0]?.statusMessage).toBeUndefined();
    }),
  );
  it.effect("refuses mismatched fill origins and generates TOTP using the controlled clock", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const password = syntheticValue();
      const generator = new TOTP();
      const totp = generator.toString();
      const { accountId } = yield* service.save({
        ...website(password),
        secrets: {
          password: { type: "scient", value: password },
          totp: { type: "scient", value: totp },
        },
      });
      expect(
        (yield* service
          .fillValues(accountId, "https://example.com.attacker.test")
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      const fill = yield* service.fillValues(accountId, "https://login.example.com");
      expect(fill.password === password).toBe(true);
      expect(fill.otp === generator.generate({ timestamp: yield* Clock.currentTimeMillis })).toBe(
        true,
      );
      const raw = generator.secret.base32;
      yield* service.save({
        ...website(),
        accountId,
        secrets: { totp: { type: "scient", value: raw } },
      });
      const code = yield* service.fillValues(accountId, "https://example.com");
      expect(code.otp === generator.generate({ timestamp: yield* Clock.currentTimeMillis })).toBe(
        true,
      );
    }),
  );
});

describe("AccountsService grants and approvals", () => {
  it.effect(
    "hides out-of-scope inventory, lists off entries as off, and honors the global switch",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const { accountId } = yield* service.save(website());
        const target = { type: "account" as const, accountId };
        yield* service.setControls({ target, scope: { type: "projects", projectIds: [] } });
        yield* service.updateProfile({ profileId: "imported", color: "#aabbcc" });
        yield* service.setControls({
          target: { type: "profile", profileId: "imported" },
          access: "off",
        });
        const inventory = yield* service.forSession(scope, ["old-profile"]);
        expect(inventory.accounts).toEqual([]);
        expect(inventory.profiles.find((profile) => profile.profileId === "imported")?.access).toBe(
          "off",
        );
        expect(
          inventory.profiles.find((profile) => profile.profileId === "old-profile")?.access,
        ).toBe("allowed");
        yield* service.setAgentAccess(false);
        expect(yield* service.forSession(scope)).toEqual({
          agentAccess: false,
          accounts: [],
          profiles: [],
        });
        expect(yield* service.authorize(scope, target, "credentials")).toEqual({
          decision: "denied",
          reason: "off",
        });
        yield* service.setAgentAccess(true);
        expect(yield* service.authorize(scope, target, "credentials")).toEqual({
          decision: "denied",
          reason: "out-of-scope",
        });
        yield* service.updateProfile({ profileId: "imported", color: null });
        expect((yield* service.snapshot).profiles[0]?.color).toBeUndefined();
        yield* service.removeProfile("imported");
        expect(
          (yield* service.forSession(scope, ["imported"])).profiles.find(
            (profile) => profile.profileId === "imported",
          )?.access,
        ).toBe("allowed");
      }),
  );
  it.effect(
    "grants conversation access without changing controls, and stores project and always decisions",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const { accountId } = yield* service.save({
          ...website(),
          controls: { ...defaultAccountControls("website"), access: "ask" },
        });
        const target = { type: "account" as const, accountId };
        for (const decision of ["once", "project", "always"] as const) {
          const approvalScope = { ...scope, threadId: ThreadId.make(`approval-${decision}`) };
          if (decision === "always") yield* service.setControls({ target, access: "ask" });
          const authorization = yield* service
            .authorize(approvalScope, target, "sign-in")
            .pipe(Effect.forkChild);
          const approval = yield* waitingApproval(service);
          yield* service.respondApproval(approval.approvalId, decision);
          expect(yield* Fiber.join(authorization)).toEqual({ decision: "allowed" });
          if (decision === "once") {
            expect(yield* service.authorize(approvalScope, target, "credentials")).toEqual({
              decision: "allowed",
            });
            yield* service.setAgentAccess(false);
            expect(yield* service.authorize(approvalScope, target, "request")).toEqual({
              decision: "denied",
              reason: "off",
            });
            yield* service.setAgentAccess(true);
            yield* service.setControls({ target, access: "off" });
            expect(yield* service.authorize(approvalScope, target, "request")).toEqual({
              decision: "denied",
              reason: "off",
            });
            yield* service.setControls({ target, access: "ask" });
          }
          const controls = (yield* service.snapshot).accounts[0]!.controls;
          expect(controls.access).toBe(decision === "always" ? "allowed" : "ask");
          if (decision === "project")
            expect(
              yield* service.authorize({ ...scope, unattended: true }, target, "sign-in"),
            ).toEqual({ decision: "allowed" });
        }
        expect((yield* service.snapshot).approvals).toEqual([]);
      }),
  );
  it.effect(
    "denies unattended Ask immediately and expires pending approvals after ten minutes",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const { accountId } = yield* service.save({
          ...website(),
          controls: { ...defaultAccountControls("website"), access: "ask" },
        });
        const target = { type: "account" as const, accountId };
        expect(yield* service.authorize({ ...scope, unattended: true }, target, "sign-in")).toEqual(
          { decision: "denied", reason: "declined" },
        );
        const authorization = yield* service
          .authorize(scope, target, "sign-in")
          .pipe(Effect.forkChild);
        const approval = yield* waitingApproval(service);
        yield* TestClock.adjust("9 minutes");
        expect((yield* service.snapshot).approvals.map((entry) => entry.approvalId)).toContain(
          approval.approvalId,
        );
        yield* TestClock.adjust("1 minute");
        expect(yield* Fiber.join(authorization)).toEqual({
          decision: "denied",
          reason: "timed-out",
        });
        expect((yield* service.snapshot).approvals).toEqual([]);
        expect(
          (yield* service.respondApproval(approval.approvalId, "once").pipe(Effect.flip)).reason,
        ).toBe("not-found");
      }),
  );
  it.effect(
    "isolates conversation approval by thread and account, rechecks scope, and forgets it after restart",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service } = yield* makeHarness({ storage });
        const input = {
          ...website(),
          controls: { ...defaultAccountControls("website"), access: "ask" as const },
        };
        const { accountId } = yield* service.save(input);
        const target = { type: "account" as const, accountId };
        const authorization = yield* service
          .authorize(scope, target, "sign-in")
          .pipe(Effect.forkChild);
        const approval = yield* waitingApproval(service);
        yield* service.respondApproval(approval.approvalId, "once");
        yield* Fiber.join(authorization);
        expect(yield* service.authorize(scope, target, "credentials")).toEqual({
          decision: "allowed",
        });
        expect(
          yield* service.authorize(
            { ...scope, threadId: ThreadId.make("another-thread"), unattended: true },
            target,
            "request",
          ),
        ).toEqual({ decision: "denied", reason: "declined" });
        const other = yield* service.save(input);
        expect(
          yield* service.authorize(
            { ...scope, unattended: true },
            { type: "account", accountId: other.accountId },
            "request",
          ),
        ).toEqual({ decision: "denied", reason: "declined" });
        yield* service.setControls({
          target,
          scope: { type: "projects", projectIds: [ProjectId.make("other-project")] },
        });
        expect(yield* service.authorize(scope, target, "request")).toEqual({
          decision: "denied",
          reason: "out-of-scope",
        });
        yield* service.setControls({ target, scope: { type: "all-projects" } });
        const restarted = yield* makeHarness({ storage });
        expect(
          yield* restarted.service.authorize({ ...scope, unattended: true }, target, "request"),
        ).toEqual({ decision: "denied", reason: "declined" });
      }),
  );
  it.effect("revokes pending approvals and cleans up cancelled requests", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save({
        ...website(),
        controls: { ...defaultAccountControls("website"), access: "ask" },
      });
      const target = { type: "account" as const, accountId };
      const authorization = yield* service
        .authorize(scope, target, "sign-in")
        .pipe(Effect.forkChild);
      yield* waitingApproval(service);
      yield* service.setAgentAccess(false);
      expect(yield* Fiber.join(authorization)).toEqual({ decision: "denied", reason: "off" });
      yield* service.setAgentAccess(true);
      const cancelled = yield* service.authorize(scope, target, "sign-in").pipe(Effect.forkChild);
      yield* waitingApproval(service);
      yield* Fiber.interrupt(cancelled);
      expect((yield* service.snapshot).approvals).toEqual([]);
    }),
  );
  it.effect(
    "records exact sign-in outcomes and clears rejection after success or password edit",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const input = website();
        const { accountId } = yield* service.save(input);
        const target = { type: "account" as const, accountId };
        for (const signInOutcome of ["password-rejected", "signed-in", "code-rejected"] as const) {
          const recorded = yield* service.changes.pipe(
            Stream.filter((snapshot) => snapshot.accounts[0]?.signIn?.state === signInOutcome),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* service.recordUse({
            target,
            action: "sign-in",
            outcome: signInOutcome === "signed-in" ? "ok" : "error",
            signInOutcome,
            ...(signInOutcome === "signed-in" ? { savedPasswordUsed: true } : {}),
          });
          yield* Fiber.join(recorded);
          expect((yield* service.activity({ target }))[0]?.signInOutcome).toBe(signInOutcome);
        }
        const password = Effect.map(
          service.snapshot,
          ({ accounts }) => accounts[0]?.secrets.password?.verifiedAt,
        );
        // Signed in with the saved password typed by Scient: that password has worked.
        expect(yield* password).toBeDefined();
        yield* service.save({ ...input, accountId, secrets: {} });
        expect((yield* service.snapshot).accounts[0]?.signIn?.state).toBe("code-rejected");
        yield* service.save({ ...input, accountId });
        // The user's reset of a held sign-in: an action newer than the refusal.
        expect((yield* service.snapshot).accounts[0]?.signIn).toMatchObject({
          state: "unknown",
          detail: "Password changed",
          by: "action",
        });
        // A sign-in Scient didn't type the password for says nothing about the new one.
        const seen = yield* service.changes.pipe(
          Stream.filter((snapshot) => snapshot.accounts[0]?.signIn?.state === "signed-in"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* service.recordUse({
          target,
          action: "sign-in",
          outcome: "ok",
          signInOutcome: "signed-in",
        });
        yield* Fiber.join(seen);
        expect(yield* password).toBeUndefined();
      }),
  );
  it.effect("keeps denial local to the pending request and audits bounded, safe activity", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save({
        ...website(),
        controls: { ...defaultAccountControls("website"), access: "ask" },
      });
      const target = { type: "account" as const, accountId };
      const authorization = yield* service
        .authorize(scope, target, "sign-in")
        .pipe(Effect.forkChild);
      const approval = yield* waitingApproval(service);
      yield* service.respondApproval(approval.approvalId, "deny");
      expect(yield* Fiber.join(authorization)).toEqual({ decision: "denied", reason: "declined" });
      yield* service.setControls({ target, access: "allowed" });
      for (let index = 0; index < 501; index++)
        yield* service.authorize(scope, target, "request", {
          detail: `https://example.com/private?token=${syntheticValue()}`,
        });
      const activity = yield* service.activity({ target });
      expect(activity.length).toBe(500);
      expect(activity.every((entry) => entry.detail === "https://example.com")).toBe(true);
      const recorded = yield* Deferred.make<void>();
      const listener = yield* service.changes.pipe(
        Stream.filter((snapshot) => snapshot.accounts[0]?.lastUsedAt !== undefined),
        Stream.take(1),
        Stream.runForEach(() => Deferred.succeed(recorded, undefined)),
        Effect.forkChild,
      );
      yield* service.recordUse({ target, action: "request", outcome: "ok" });
      yield* Deferred.await(recorded);
      yield* Fiber.join(listener);
      expect((yield* service.snapshot).accounts[0]?.lastUsedAt).toBeDefined();
    }),
  );
});

it.effect("keeps the old password when an import's single write fails", () =>
  Effect.gen(function* () {
    const storage = memoryStore();
    const { service } = yield* makeHarness({ storage });
    const value = syntheticValue();
    const { accountId } = yield* service.save(website(value));
    storage.failWritesTo("accounts-state");
    const content = `name,url,username,password,note\nSite,https://example.com/login,synthetic-user,${syntheticValue()},`;
    yield* service.importPasswords({ format: "auto", content }).pipe(Effect.flip);
    storage.failWritesTo(undefined);
    const restarted = yield* makeHarness({ storage });
    expect(
      secretEquals(
        (yield* restarted.service.resolveSecrets(accountId, ["password"])).password,
        value,
      ),
    ).toBe(true);
  }),
);

it.effect(
  "imports sibling subdomains separately and updates only the exact site and username",
  () =>
    Effect.gen(function* () {
      const { service, operations } = yield* makeHarness();
      const parentValue = syntheticValue();
      const parent = yield* service.save({
        ...website(parentValue),
        details: { kind: "website", sites: ["example.com"], username: "user" },
      });
      yield* service.setControls({
        target: { type: "account", accountId: parent.accountId },
        access: "ask",
      });
      const mailValue = syntheticValue();
      const wikiValue = syntheticValue();
      const content = `name,url,username,password,note\nMail,https://mail.example.com/login,user,${mailValue},\nWiki,https://wiki.example.com/login,user,${wikiValue},`;
      const stateWrites = () =>
        operations.filter((operation) => operation.includes("accounts-state")).length;
      const before = stateWrites();
      expect(yield* service.importPasswords({ format: "auto", content })).toEqual({
        created: 2,
        updated: 0,
        skipped: 0,
      });
      // The whole import is one write: per-entry writes and publishes froze large imports.
      expect(stateWrites() - before).toBe(1);
      const accounts = (yield* service.snapshot).accounts;
      const mail = accounts.find(
        (account) =>
          account.details.kind === "website" && account.details.sites.includes("mail.example.com"),
      )!;
      const wiki = accounts.find(
        (account) =>
          account.details.kind === "website" && account.details.sites.includes("wiki.example.com"),
      )!;
      expect(mail.accountId).not.toBe(wiki.accountId);
      expect([mail.controls.access, wiki.controls.access]).toEqual(["ask", "ask"]);
      const next = syntheticValue();
      expect(
        yield* service.importPasswords({
          format: "auto",
          content: `name,url,username,password,note\nMail,https://mail.example.com/other,user,${next},`,
        }),
      ).toEqual({ created: 0, updated: 1, skipped: 0 });
      for (const [accountId, expected] of [
        [parent.accountId, parentValue],
        [mail.accountId, next],
        [wiki.accountId, wikiValue],
      ] as const) {
        expect(
          secretEquals((yield* service.resolveSecrets(accountId, ["password"])).password, expected),
        ).toBe(true);
      }
    }),
);

it.effect(
  "refreshes 1Password OTP references and TOTP fields instead of returning cached values",
  () =>
    Effect.gen(function* () {
      let current = syntheticValue();
      const { service } = yield* makeHarness({
        sourceOverrides: {
          onePassword: () =>
            Effect.succeed({
              label: "Synthetic vault",
              resolve: () => Effect.sync(() => Redacted.make(current)),
            }),
        },
      });
      yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
      const { accountId } = yield* service.save({
        ...website(),
        secrets: {
          password: { type: "1password", reference: "op://vault/item/password?attribute=otp" },
          totp: { type: "1password", reference: "op://vault/item/totp" },
        },
      });
      const first = yield* service.resolveSecrets(accountId, ["password", "totp"]);
      expect(secretEquals(first.password, current) && secretEquals(first.totp, current)).toBe(true);
      yield* TestClock.adjust("30 seconds");
      current = syntheticValue();
      const next = yield* service.resolveSecrets(accountId, ["password", "totp"]);
      expect(secretEquals(next.password, current)).toBe(true);
      expect(secretEquals(next.totp, current)).toBe(true);
    }),
);

it.effect(
  "publishes ephemeral hand-offs, reveals their tab, and prevents cancelled waits reappearing",
  () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      const { accountId } = yield* service.save(website());
      let revealed = 0;
      const entry = {
        handoffId: "synthetic-handoff",
        threadId: scope.threadId,
        accountId,
        accountName: "Synthetic",
        site: "example.com",
        kind: "push" as const,
        number: "42",
        startedAt: "2026-10-27T00:00:00Z",
        expiresAt: "2026-10-27T00:03:00Z",
      };
      yield* service.setHandoff(
        entry,
        Effect.sync(() => {
          revealed++;
        }),
      );
      expect((yield* service.snapshot).handoffs).toEqual([entry]);
      yield* service.showHandoff(entry.handoffId);
      expect(revealed).toBe(1);
      const restarted = yield* makeHarness({ storage });
      expect((yield* restarted.service.snapshot).handoffs).toEqual([]);
      yield* service.cancelHandoff(entry.handoffId);
      expect(yield* service.handoffCancelled(entry.handoffId)).toBe(true);
      yield* service.setHandoff({ ...entry, kind: "code" });
      expect((yield* service.snapshot).handoffs).toEqual([]);
      expect((yield* service.showHandoff(entry.handoffId).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
      yield* service.removeHandoff(entry.handoffId);
      expect(yield* service.handoffCancelled(entry.handoffId)).toBe(false);
    }),
);

describe("the send log other computers follow", () => {
  const WORK = BrowserProfileId.make("profile-work");
  const row = (sites: string[], profileId = WORK) => ({
    name: sites[0]!,
    details: { kind: "website" as const, sites, profileId },
    secrets: {},
  });
  const shared = (environmentId: string, applied: number) => ({
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    applied,
    waiting: 0,
    needsYou: [],
  });

  it.effect("writes each action's revision in its own commit, and none for a look", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const log = (profileId = WORK) => service.profileSendLog(profileId);
      const github = (yield* service.save(row(["github.com"]))).accountId;
      expect((yield* log()).head).toBe(0);
      // A look that sees the session working is not an action.
      yield* service.recordCheck(github, { state: "signed-in" });
      expect((yield* log()).head).toBe(0);
      yield* TestClock.adjust("1 minute");
      yield* service.recordUse({
        target: { type: "account", accountId: github },
        action: "sign-in",
        outcome: "ok",
        signInOutcome: "signed-in",
      });
      yield* Effect.yieldNow;
      yield* service.snapshot;
      expect(yield* log()).toEqual({
        head: 1,
        units: [{ sites: ["github.com"], revision: 1, kind: "copy" }],
      });
      expect(yield* service.profileSignedOut(WORK, "github.com")).toBe(2);
      expect(yield* service.profileResend(WORK)).toBe(3);
      expect(yield* log()).toEqual({
        head: 3,
        jar: 3,
        units: [{ sites: ["github.com"], revision: 2, kind: "delete" }],
      });
      yield* service.mainFilled({ accountId: github, profileName: "Work" });
      expect((yield* log(DEFAULT_BROWSER_PROFILE_ID)).units).toEqual([
        { sites: ["github.com"], revision: 1, kind: "copy" },
      ]);
      // Clients see only the head.
      const record = (yield* service.snapshot).profiles.find((p) => p.profileId === WORK);
      expect(record?.send).toEqual({ head: 3, units: [] });
    }),
  );

  it.effect("takes a revision for a sign-in action seen in a profile, none for an import", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.sessionsSeen({
        profileId: WORK,
        sessions: [{ site: "overleaf.com", how: "imported", from: "Chrome · Person" }],
      });
      expect((yield* service.profileSendLog(WORK)).head).toBe(0);
      yield* TestClock.adjust("1 minute");
      yield* service.sessionsSeen({
        profileId: WORK,
        sessions: [{ site: "overleaf.com", how: "signed-in" }],
      });
      expect((yield* service.profileSendLog(WORK)).units).toEqual([
        { sites: ["overleaf.com"], revision: 1, kind: "copy" },
      ]);
    }),
  );

  it.effect("keeps a revision when its row is deleted, and across restarts", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      const github = (yield* first.service.save(row(["github.com"]))).accountId;
      yield* first.service.profileSignedOut(WORK, "github.com");
      yield* first.service.remove(github);
      expect((yield* first.service.profileSendLog(WORK)).units).toHaveLength(1);
      const again = yield* makeHarness({ storage });
      expect(yield* again.service.profileResend(WORK)).toBe(2);
    }),
  );

  it.effect("keeps a deletion until every computer it goes to applied it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.profileShared(WORK, shared("laptop", 0));
      yield* service.profileSignedOut(WORK, "github.com");
      yield* service.profileShared(WORK, shared("lab", 1));
      expect((yield* service.profileSendLog(WORK)).units).toHaveLength(1);
      yield* service.profileShared(WORK, shared("laptop", 1));
      expect((yield* service.profileSendLog(WORK)).units).toEqual([]);
    }),
  );

  it.effect(
    "withdraws a profile that turns restricted, and resends its jar when shared again",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const target = { type: "profile" as const, profileId: WORK };
        yield* service.setControls({ target, access: "off" });
        expect(yield* service.profileSendLog(WORK)).toEqual({ head: 1, withdrawn: 1, units: [] });
        yield* service.setControls({ target, access: "ask" });
        expect(yield* service.profileSendLog(WORK)).toEqual({
          head: 2,
          withdrawn: 1,
          jar: 2,
          units: [],
        });
      }),
  );
});

describe("deletions an offline computer still needs", () => {
  it("keeps every deletion past the copy bound, and forgets a computer only when unlinked", () => {
    const shared = (environmentId: string, applied: number) => ({
      environmentId: EnvironmentId.make(environmentId),
      label: environmentId,
      applied,
      waiting: 0,
      needsYou: [],
    });
    let log = issueUnit(undefined, ["signed-out.test"], "delete");
    for (let index = 0; index < 5_001; index += 1)
      log = issueUnit(log, [`site${index}.test`], "copy");
    // Past the bound, copies fall back to the whole jar; the deletion stays.
    expect(log.jar).toBe(log.head);
    expect(log.units).toEqual([{ sites: ["signed-out.test"], revision: 1, kind: "delete" }]);
    const record = { ...defaultBrowserProfileRecord(BrowserProfileId.make("work")), send: log };
    const offline = withShared(record, EnvironmentId.make("lab"), shared("lab", 0));
    const online = withShared(offline, EnvironmentId.make("laptop"), shared("laptop", log.head));
    expect(online.send?.units).toHaveLength(1);
    expect(withShared(online, EnvironmentId.make("lab"), undefined).send?.units).toEqual([]);
  });
});

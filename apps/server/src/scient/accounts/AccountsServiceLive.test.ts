import { describe, expect, it } from "@effect/vitest";
import {
  type AccountSummary,
  AccountId,
  AccountsError,
  AccountsSnapshot,
  BrowserProfileId,
  ProjectId,
  ThreadId,
  defaultAccountControls,
} from "@t3tools/contracts";
import { Clock, Deferred, Effect, Fiber, Redacted, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { TOTP } from "otpauth";
import {
  makeHarness,
  memoryStore,
  secretEquals,
  syntheticValue,
  website,
} from "./Accounts.testkit.ts";
import { UNKNOWN_RUN, UNKNOWN_RUN_REFUSAL } from "./taskPinRules.ts";
import { usedCodeDigest } from "./backupCodes.ts";

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
type Service = import("./AccountsService.ts").AccountsServiceShape;
/** A new password Scient made for `accountId`, sent and saved on the site's answer. */
const acceptedOn =
  (service: Service, accountId: AccountId, origin: string, username: string) => (made: string) =>
    Effect.gen(function* () {
      const { pendingId } = yield* service.pending({
        type: "reserve",
        origin,
        password: made,
        accountId,
      });
      yield* service.pending({
        type: "rotate",
        pendingId: pendingId!,
        origin,
        username,
        password: made,
        accountId,
      });
      yield* service.pending({ type: "settle", pendingId: pendingId!, outcome: "accepted" });
    });
/** How the person's own sign-in ended, naming the password filled by its fill's `attempt`. */
const personSaw =
  (service: Service, accountId: AccountId) =>
  (outcome: "signed-in" | "password-rejected", attempt?: string) =>
    service.recordUse(
      {
        target: { type: "account", accountId },
        action: "sign-in",
        signInOutcome: outcome,
        outcome: outcome === "signed-in" ? "ok" : "error",
        byPerson: true,
        ...(attempt === undefined ? {} : { attempt }),
      },
      undefined,
      true,
    );
/** The login's earlier passwords as its details list them, newest first, each shown. */
const earlierPasswords = (service: Service, accountId: AccountId) =>
  Effect.gen(function* () {
    const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === accountId);
    const values: string[] = [];
    for (const { version } of row?.secrets.password?.history ?? [])
      values.push((yield* service.reveal(accountId, "version", version)).value);
    return values;
  });

describe("AccountsService persistence", () => {
  it.effect("keeps one row per Google address in a profile, following what Google reports", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ storage: memoryStore() });
      const profileId = BrowserProfileId.make("profile-work");
      const saved = yield* service.save(website(syntheticValue()));
      const nameOf = ({ details }: AccountSummary) =>
        (details.kind === "website" ? details.username : undefined) ?? "";
      // By address: the snapshot's own order follows sign-in state.
      const rows = Effect.map(service.snapshot, ({ accounts }) =>
        accounts
          .filter(({ accountId }) => accountId !== saved.accountId)
          .toSorted((a, b) => nameOf(a).localeCompare(nameOf(b))),
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
        // regression: a first not-valid answer wrote a row with no state yet signed out.
        ["b@example.com", "browser-session", undefined],
      ]);
      // Seen again, with the first signed out and the second gone from Google's list.
      const out = { profileId, sessions: [{ email: "a@example.com", valid: false }] };
      yield* service.googleSessionsSeen(out);
      // regression: one bad answer wrote a working Google sign-in signed out.
      expect((yield* rows).map(({ signIn }) => signIn?.state)).toEqual(["signed-in", undefined]);
      yield* TestClock.adjust("61 seconds");
      yield* service.googleSessionsSeen(out);
      const after = yield* rows;
      expect(after.map(({ signIn }) => signIn?.state)).toEqual(["signed-out", "signed-out"]);
      expect(after).toHaveLength(2);
      // A look at Google's pages from elsewhere never writes its rows: Google's answer does.
      yield* service.recordCheck(after[0]!.accountId, { state: "signed-in" });
      expect((yield* rows)[0]?.signIn?.state).toBe("signed-out");
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
        // Journaled before it (`stageValue`), the metadata naming it lands after it.
        expect(storage.operations.lastIndexOf("set:accounts-state")).toBeGreaterThan(valueWrite);
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
        // The replaced password is kept for recovery until the row goes, Undo's hour included.
        expect(oldValues.every((name) => storage.blobs.has(name))).toBe(true);
        yield* restarted.service.remove(accountId);
        expect(oldValues.every((name) => storage.blobs.has(name))).toBe(true);
        yield* TestClock.adjust("61 minutes");
        expect(oldValues.some((name) => storage.blobs.has(name))).toBe(false);
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
        const content = `name,url,username,password,password_changed\nSynthetic,https://login.example.com/path,user,${value},2024-01-01T00:00:00.000Z\nSynthetic,https://login.example.com/path,user,${value},2024-01-01T00:00:00.000Z`;
        expect(
          yield* service.importPasswords({ format: "auto", content, profileId: "imported" }),
        ).toEqual({ created: 1, updated: 0, skipped: 1 });
        const next = syntheticValue();
        expect(
          yield* service.importPasswords({
            format: "auto",
            content: content.replaceAll(value, next).replaceAll("2024-", "2025-"),
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
            content: content
              .replaceAll(value, next)
              .replaceAll("2024-", "2025-")
              .replaceAll("Synthetic,", "Renamed,"),
          }),
        ).toEqual({ created: 0, updated: 0, skipped: 2 });
        const changed = (yield* service.snapshot).accounts[0]!;
        expect(changed.name).toBe("Synthetic");
        expect(changed.details.kind === "website" && changed.details.profileId).toBe("imported");
      }),
  );
});

describe("AccountsService profile record", () => {
  it.effect(
    "names each profile a client reports, keeps it after a restart, and serves older clients as before",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service } = yield* makeHarness({ storage });
        const lab = BrowserProfileId.make("profile-lab");
        // An older client never reports: its profiles have no record and work as ever.
        expect((yield* service.snapshot).profiles.some(({ profileId }) => profileId === lab)).toBe(
          false,
        );
        expect(
          (yield* service.forSession(scope, [lab])).profiles.find(
            ({ profileId }) => profileId === lab,
          ),
        ).toMatchObject({ access: "allowed", scriptSignIn: true });
        // A protocol-2 client's report: the record names it, for agents and other clients.
        yield* service.reportProfiles([
          { profileId: lab, name: "Lab" },
          { profileId: BrowserProfileId.make("default"), name: "Main" },
        ]);
        const record = () =>
          Effect.map(service.snapshot, ({ profiles }) =>
            profiles.find(({ profileId }) => profileId === lab),
          );
        expect(yield* record()).toMatchObject({ name: "Lab", access: "allowed" });
        expect(
          (yield* service.snapshot).profiles.some(({ profileId }) => profileId === "default"),
        ).toBe(false);
        // The same report again changes nothing; a rename is kept.
        const version = (yield* record())!.updatedAt;
        yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
        expect((yield* record())!.updatedAt).toBe(version);
        yield* service.reportProfiles([{ profileId: lab, name: "Lab work" }]);
        const restarted = yield* makeHarness({ storage });
        expect(
          (yield* restarted.service.snapshot).profiles.find(({ profileId }) => profileId === lab),
        ).toMatchObject({ name: "Lab work" });
        // A profile merged into Main keeps its record as it was.
        yield* restarted.service.retireProfile(lab, { name: "Lab work" });
        yield* restarted.service.reportProfiles([{ profileId: lab, name: "Other" }]);
        expect(
          (yield* restarted.service.snapshot).profiles.find(({ profileId }) => profileId === lab)
            ?.name,
        ).toBe("Lab work");
      }),
  );
});

describe("AccountsService Undo of Remove", () => {
  it.effect("brings a removed row back with its id and value for an hour, then lets it go", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      const value = syntheticValue();
      const { accountId } = yield* service.save(website(value));
      const valueNames = () =>
        [...storage.blobs.keys()].filter((name) => name.startsWith("accounts-value-"));
      const stored = valueNames();
      // A version edited since the person looked isn't removed.
      expect(
        (yield* service.remove(accountId, "2000-01-01T00:00:00.000Z").pipe(Effect.flip)).reason,
      ).toBe("conflict");
      const first = yield* service.remove(accountId);
      yield* service.restore(accountId, first.removalId);
      expect(
        secretEquals((yield* service.resolveSecrets(accountId, ["password"])).password, value),
      ).toBe(true);
      // An Undo left from the first removal never undoes a later one.
      const { removalId } = yield* service.remove(accountId, undefined, "synthetic-press");
      // Listed with its receipt and its press for the hour, so Accounts can offer Undo after its
      // notice goes, one for the rows one press removed.
      expect((yield* service.snapshot).removed).toEqual([
        expect.objectContaining({ accountId, removalId, operationId: "synthetic-press" }),
      ]);
      expect((yield* service.restore(accountId, first.removalId).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
      // The hour ends on its own: the value goes with nobody using Accounts.
      yield* TestClock.adjust("61 minutes");
      expect(valueNames().filter((name) => stored.includes(name))).toEqual([]);
      expect((yield* service.snapshot).removed).toBeUndefined();
      expect((yield* service.restore(accountId, removalId).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
      // A deletion that fails is tried again, even after a restart.
      const other = yield* service.save(website());
      const otherValues = valueNames();
      yield* service.remove(other.accountId);
      storage.failRemovalOf(otherValues[0]);
      yield* TestClock.adjust("61 minutes");
      expect(valueNames()).toEqual(otherValues);
      storage.failRemovalOf(undefined);
      yield* makeHarness({ storage }).pipe(Effect.flatMap(({ service }) => service.snapshot));
      yield* TestClock.adjust("1 minute");
      expect(valueNames()).toEqual([]);
    }),
  );
});

describe("AccountsService use gate", () => {
  it.effect("publishes under the fence only while the grant still stands", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const target = { type: "account" as const, accountId };
      yield* service.setControls({ target, access: "allowed" });
      const row = (yield* service.snapshot).accounts[0]!;
      const grant = {
        scope: { projectId: undefined, unattended: true },
        target,
        use: { linked: true },
      };
      let published = 0;
      const publish = Effect.sync(() => void (published += 1));
      const sequence = yield* service.signOutSequence;
      expect(yield* service.unlessSignedOutSince(row, sequence, publish, grant)).toBe(true);
      yield* service.setControls({ target, access: "off" });
      expect(
        (yield* service.unlessSignedOutSince(row, sequence, publish, grant).pipe(Effect.flip))
          .reason,
      ).toBe("denied");
      expect(published).toBe(1);
    }),
  );

  it.effect("a pinned task's run uses its pinned sign-in and profile only", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const alice = yield* service.save(website());
      const bob = yield* service.save({
        ...website(),
        details: { kind: "website", sites: ["example.com"], username: "bob" },
      });
      for (const { accountId } of [alice, bob])
        yield* service.setControls({ target: { type: "account", accountId }, access: "allowed" });
      yield* service.updateTaskPin("task:hours", () => ({
        scheduledTaskId: "task:hours",
        accountId: alice.accountId,
        profileId: BrowserProfileId.make("default"),
        environmentId: "env-here",
        username: "synthetic-user",
        projectId: scope.projectId,
      }));
      const run = { ...scope, unattended: true, scheduledTaskId: "task:hours" };
      yield* service.authorizeUse(run, { type: "account", accountId: alice.accountId });
      // regression: a run that passed the gate went on to sign in as Bob.
      expect(
        (yield* service
          .authorizeUse(run, { type: "account", accountId: bob.accountId })
          .pipe(Effect.flip)).message,
      ).toContain("pinned sign-in");
      expect(
        yield* service.authorize(run, { type: "account", accountId: bob.accountId }, "sign-in"),
      ).toEqual({ decision: "denied", reason: "pinned" });
      expect(
        (yield* service
          .authorizeUse(run, { type: "profile", profileId: BrowserProfileId.make("home") })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      // Its tabs, existing ones included, are only those of its pinned profile.
      expect(
        (yield* service.forSession(run, [BrowserProfileId.make("home")])).profiles.map(
          (profile) => profile.profileId,
        ),
      ).toEqual(["default"]);
      // The pin outlives its row's removal, and still refuses a stand-in.
      yield* service.remove(alice.accountId);
      expect((yield* service.taskPins).map((pin) => pin.scheduledTaskId)).toEqual(["task:hours"]);
      // Other runs aren't bound.
      yield* service.authorizeUse(scope, { type: "account", accountId: bob.accountId });
    }),
  );

  it.effect("a run whose scheduled task is unknown uses no website sign-in or profile", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      yield* service.setControls({ target: { type: "account", accountId }, access: "allowed" });
      const unknown = { ...scope, unattended: true, scheduledTaskId: UNKNOWN_RUN };
      // regression: a run whose records couldn't be read counted as no task, so no pin bound it.
      expect(
        (yield* service
          .authorizeUse(unknown, { type: "account", accountId }, { linked: true })
          .pipe(Effect.flip)).message,
      ).toBe(UNKNOWN_RUN_REFUSAL);
      expect(
        (yield* service
          .authorizeUse(unknown, { type: "profile", profileId: BrowserProfileId.make("default") })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      yield* service.authorizeUse(scope, { type: "account", accountId }, { linked: true });
    }),
  );

  it.effect("a stored pin list that isn't one binds every scheduled run until it is pinned", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      const alice = yield* service.save(website());
      const bob = yield* service.save({
        ...website(),
        details: { kind: "website", sites: ["example.com"], username: "bob" },
      });
      for (const { accountId } of [alice, bob])
        yield* service.setControls({ target: { type: "account", accountId }, access: "allowed" });
      const pin = {
        scheduledTaskId: "task:hours",
        accountId: alice.accountId,
        profileId: BrowserProfileId.make("default"),
        environmentId: "env-here",
        username: "synthetic-user",
        projectId: scope.projectId,
      };
      yield* service.updateTaskPin(pin.scheduledTaskId, () => pin);
      // The pin, kept in a container that isn't a list.
      const name = "accounts-state";
      const stored: Record<string, unknown> = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      );
      stored["taskPins"] = { hours: pin };
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      const { service: reopened } = yield* makeHarness({ storage });
      expect((yield* reopened.snapshot).accounts).toHaveLength(2);
      const run = { ...scope, unattended: true, scheduledTaskId: "task:hours" };
      // regression: the list read as absent, so the run signed in as Bob.
      expect(
        (yield* reopened
          .authorizeUse(run, { type: "account", accountId: bob.accountId })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      expect(
        (yield* reopened
          .authorizeUse(run, { type: "profile", profileId: BrowserProfileId.make("default") })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      // Pinned again, the task's own pin governs it; runs of no task aren't bound.
      yield* reopened.updateTaskPin(pin.scheduledTaskId, () => pin);
      yield* reopened.authorizeUse(run, { type: "account", accountId: alice.accountId });
      yield* reopened.authorizeUse(scope, { type: "account", accountId: bob.accountId });
    }),
  );

  it.effect("lets a use act only on the row as it was authorized, on its current sites", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const target = { type: "account" as const, accountId };
      const read = (yield* service.snapshot).accounts[0]!;
      yield* service.authorizeUse(scope, target, { since: read, origin: "https://example.com" });
      // Another site than the account's.
      expect(
        (yield* service
          .authorizeUse(scope, target, { origin: "https://other.test" })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      // Turned to Ask meanwhile, with no approval in this conversation: not what was granted.
      yield* service.setControls({ target, access: "ask" });
      expect((yield* service.authorizeUse(scope, target).pipe(Effect.flip)).reason).toBe("denied");
      // Approved while the agent waited, once or always: the use it approved goes ahead.
      for (const decision of ["once", "always"] as const) {
        yield* service.setControls({ target, access: "ask" });
        const asking = (yield* service.snapshot).accounts[0]!;
        const authorization = yield* service
          .authorize({ ...scope, threadId: ThreadId.make(decision) }, target, "sign-in")
          .pipe(Effect.forkChild);
        yield* service.respondApproval((yield* waitingApproval(service)).approvalId, decision);
        yield* Fiber.join(authorization);
        yield* service.authorizeUse({ ...scope, threadId: ThreadId.make(decision) }, target, {
          since: asking,
        });
      }
      // A connector the person linked it to: the link approves Ask, and Off still refuses.
      const connector = { projectId: undefined, unattended: true };
      yield* service.setControls({ target, access: "ask" });
      yield* service.authorizeUse(connector, target, { linked: true });
      yield* service.setControls({ target, access: "off" });
      expect(
        (yield* service.authorizeUse(connector, target, { linked: true }).pipe(Effect.flip)).reason,
      ).toBe("denied");
      yield* service.setControls({ target, access: "allowed" });
      // A use with no project serves every project: a row narrowed to some no longer fits it,
      // while a project it still covers goes on.
      yield* service.setControls({
        target,
        scope: { type: "projects", projectIds: [scope.projectId] },
      });
      expect(
        (yield* service.authorizeUse(connector, target, { linked: true }).pipe(Effect.flip)).reason,
      ).toBe("denied");
      yield* service.authorizeUse(scope, target, { linked: true });
      yield* service.setControls({ target, scope: { type: "all-projects" } });
      // The row's version as read before its value: a new value saved since refuses.
      const version = yield* service.rowVersion(accountId);
      yield* service.authorizeUse(connector, target, { linked: true, since: version });
      yield* service.save({ ...website(syntheticValue()), accountId });
      expect(
        (yield* service
          .authorizeUse(connector, target, { linked: true, since: version })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      // Edited while the agent waited: permission, sites, auth or key may differ now.
      yield* service.setControls({ target, permission: "read-only" });
      expect(
        (yield* service.authorizeUse(scope, target, { since: read }).pipe(Effect.flip)).reason,
      ).toBe("denied");
    }),
  );
});

describe("AccountsService key copies", () => {
  it.effect("takes followed copies back before an Off, a Remove or agent access off commits", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const key = () =>
        service.save({
          name: "Synthetic key",
          details: { kind: "api-key", sites: [], auth: { type: "bearer" } },
          secrets: { token: { type: "scient", value: syntheticValue() } },
        });
      const [first, second] = [yield* key(), yield* key()];
      for (const [index, { accountId }] of [first, second].entries())
        yield* service.setKeyLink({ instanceId: "codex", variable: `KEY_${index}` }, accountId);
      const taken: Array<ReadonlyArray<string>> = [];
      yield* service.onAccessTaken!((links) =>
        Effect.sync(() => void taken.push(links.map(({ variable }) => variable))),
      );
      yield* service.setControls({
        target: { type: "account", accountId: first.accountId },
        access: "off",
      });
      yield* service.remove(second.accountId);
      yield* service.setAgentAccess(false);
      expect(taken).toEqual([["KEY_0"], ["KEY_1"], ["KEY_0", "KEY_1"]]);
    }),
  );
});

describe("AccountsService sign-in factors", () => {
  it.effect("an older build's code record counts only where it proves something", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const first = yield* makeHarness({ storage });
      const plain = yield* first.service.save(website());
      const keyed = yield* first.service.save({
        ...website(),
        details: { kind: "website", sites: ["example.com"], username: "keyed" },
        secrets: {
          ...website().secrets,
          totp: { type: "scient" as const, value: "JBSWY3DPEHPK3PXP" },
        },
      });
      const texted = yield* first.service.save({
        ...website(),
        details: { kind: "website", sites: ["example.com"], username: "texted" },
      });
      // What an earlier build wrote: a yes/no per row.
      const sealed = storage.blobs.get("accounts-state")!;
      const stored = JSON.parse(
        new TextDecoder().decode(
          Redacted.value(yield* first.vault.decrypt("accounts-state", sealed)),
        ),
      ) as Record<string, unknown>;
      stored.signInCodes = {
        [plain.accountId]: false,
        [keyed.accountId]: false,
        [texted.accountId]: true,
      };
      storage.blobs.set(
        "accounts-state",
        yield* first.vault.encrypt(
          "accounts-state",
          Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
        ),
      );
      const { service } = yield* makeHarness({ storage });
      // regression: a "no code" written while a saved key could have hidden a texted one counted.
      expect(yield* service.signInFactors).toEqual({
        [plain.accountId]: "none",
        [texted.accountId]: "code",
      });
      yield* service.noteSignInFactor(keyed.accountId, "totp");
      const restarted = yield* makeHarness({ storage });
      expect((yield* restarted.service.signInFactors)[keyed.accountId]).toBe("totp");
    }),
  );
});

describe("AccountsService code notices", () => {
  it.effect(
    "keeps a notice through its outcome, until the relay clears it, and a day at most",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-26T12:00:00.000Z"));
        const { service } = yield* makeHarness({ storage: memoryStore() });
        const { accountId } = yield* service.save(website());
        const first = yield* service.addCodeNotice({ accountId, text: "Site: a code is coming" });
        yield* service.settleCodeNotice(first, "signed-in");
        // regression: a quick sign-in cleared the notice; it stays, with its outcome.
        expect((yield* service.snapshot).codeNotices).toMatchObject([
          { noticeId: first, settled: "signed-in", settledAt: "2026-11-26T12:00:00.000Z" },
        ]);
        // An acknowledgement from a relay link since replaced writes nothing.
        yield* service.codeNoticeDelivered(first, () => false);
        yield* service.codeNoticeCleared(first, "notice", () => false);
        expect((yield* service.snapshot).codeNotices?.[0]).not.toHaveProperty("delivered");
        expect((yield* service.snapshot).codeNotices?.[0]).not.toHaveProperty("cleared");
        yield* service.codeNoticeDelivered(first, () => true);
        expect((yield* service.snapshot).codeNotices?.[0]?.delivered).toBe(true);
        // regression: the notice went with its first row, so a restart lost its outcome row.
        yield* service.codeNoticeCleared(first, "notice");
        expect((yield* service.snapshot).codeNotices?.[0]?.cleared).toEqual(["notice"]);
        yield* service.codeNoticeCleared(first, "settled");
        // Its tombstones are kept through their expiry: a day, whatever the relay acknowledged.
        expect((yield* service.snapshot).codeNotices).toMatchObject([
          { noticeId: first, cleared: ["notice", "settled"] },
        ]);
        // regression: past fifty, the oldest went before the relay took its rows off.
        for (let index = 0; index < 51; index++)
          yield* service.addCodeNotice({ accountId, text: "Site: a code is coming" });
        expect((yield* service.snapshot).codeNotices).toHaveLength(52);
        // One left uncleared goes after a day, whatever the relay did.
        yield* service.addCodeNotice({ accountId, text: "Site: a code is coming" });
        yield* TestClock.adjust("25 hours");
        const later = yield* service.addCodeNotice({ accountId, text: "Site: a code is coming" });
        expect((yield* service.snapshot).codeNotices?.map((notice) => notice.noticeId)).toEqual([
          later,
        ]);
      }),
  );
});

it.effect("keeps a notice's tombstones through their expiry, whatever link clears it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-26T12:00:00.000Z"));
    const storage = memoryStore();
    const { service } = yield* makeHarness({ storage });
    const { accountId } = yield* service.save(website());
    const noticeId = yield* service.addCodeNotice({ accountId, text: "Site: a code is coming" });
    // The link is current at every check, and replaced as each write lands; then a restart.
    let link = 1;
    const current = (mine: number) => () => link === mine;
    yield* service.codeNoticeCleared(noticeId, "notice", current(1));
    link = 2;
    const restarted = yield* makeHarness({ storage });
    // regression: the second write deleted the notice as the link changed, and a restart lost it.
    expect((yield* restarted.service.snapshot).codeNotices).toMatchObject([
      { noticeId, cleared: ["notice"] },
    ]);
    // The new link's own clear keeps it too; only its age lets it go.
    yield* restarted.service.codeNoticeCleared(noticeId, "notice", current(2));
    expect((yield* restarted.service.snapshot).codeNotices).toHaveLength(1);
    yield* TestClock.adjust("25 hours");
    const later = yield* restarted.service.addCodeNotice({ accountId, text: "Site: again" });
    expect(
      (yield* restarted.service.snapshot).codeNotices?.map((notice) => notice.noticeId),
    ).toEqual([later]);
  }),
);

describe("AccountsService renewal setting", () => {
  it.effect(
    "Renew sign-ins automatically is on until turned off, and stays off across a restart",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service } = yield* makeHarness({ storage });
        expect((yield* service.snapshot).renewAutomatically).toBe(true);
        yield* service.setRenewAutomatically(false);
        const restarted = yield* makeHarness({ storage });
        expect(yield* restarted.service.renewAutomatically).toBe(false);
        expect((yield* restarted.service.snapshot).renewAutomatically).toBe(false);
        yield* restarted.service.setRenewAutomatically(true);
        expect(yield* restarted.service.renewAutomatically).toBe(true);
      }),
  );
});

describe("AccountsService code sources", () => {
  it.effect("saving the switch as it is changes nothing, so no code wait stops", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        sourceOverrides: { codesHost: Effect.succeed({ computer: "Lab Mac", readable: true }) },
      });
      const before = yield* service.codeSourcesVersion;
      // The Sign-in codes row saves it again to look at Full Disk Access afresh.
      yield* service.setCodeSources({ messages: true });
      expect(yield* service.codeSourcesVersion).toBe(before);
      yield* service.setCodeSources({ messages: false });
      expect(yield* service.codeSourcesVersion).toBe(before + 1);
      yield* service.setCodeSources({ messages: false });
      expect(yield* service.codeSourcesVersion).toBe(before + 1);
    }),
  );

  it.effect("shows the code reader's latest answer on the next snapshot", () =>
    Effect.gen(function* () {
      let readable = false;
      const { service } = yield* makeHarness({
        sourceOverrides: {
          codesHost: Effect.sync(() => ({ computer: "Lab Mac", readable })),
        },
      });
      expect((yield* service.snapshot).codeSourcesHost?.readable).toBe(false);
      // regression: the row kept a denial for 30 s after a grant.
      readable = true;
      expect((yield* service.snapshot).codeSourcesHost?.readable).toBe(true);
    }),
  );

  it.effect("checks the readers afresh without writing the switch", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        sourceOverrides: { codesHost: Effect.succeed({ computer: "Lab Mac", readable: false }) },
      });
      yield* service.setCodeSources({ messages: false });
      const before = yield* service.codeSourcesVersion;
      // No reader runs here: the check's answer is whatever the synthetic reader can't open.
      yield* service.checkCodeSources;
      expect(yield* service.codeSourcesVersion).toBe(before);
      expect((yield* service.snapshot).codeSources).toEqual({ messages: false });
      const { service: linux } = yield* makeHarness();
      expect((yield* linux.checkCodeSources.pipe(Effect.flip)).reason).toBe("unavailable");
    }),
  );

  it.effect("sets nothing on a server that isn't a Mac, so no reader starts", () =>
    Effect.gen(function* () {
      // The synthetic sources are Linux: no Messages or Mail.
      const { service } = yield* makeHarness();
      const refused = yield* service.setCodeSources({ messages: true }).pipe(Effect.flip);
      expect(refused.reason).toBe("unavailable");
      expect(yield* service.codeSourcesVersion).toBe(0);
    }),
  );
});

describe("AccountsService saves during a refresh", () => {
  it.effect("keeps a key saved while a browser Refresh reads and writes its logins", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { service } = yield* makeHarness({
        storage,
        sourceOverrides: {
          // The matched login's password is in the Keychain: the Refresh waits on it unlocked.
          keychain: () =>
            Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(Redacted.make(syntheticValue())),
            ),
        },
      });
      const profileId = BrowserProfileId.make("work");
      yield* service.save({
        ...website(),
        details: { kind: "website", sites: ["example.com"], username: "user", profileId },
        secrets: { password: { type: "keychain", service: "synthetic", account: "user" } },
      });
      const content = `name,url,username,password\nSite,https://example.com/login,user,${syntheticValue()}\nOther,https://other.example/login,user,${syntheticValue()}`;
      const refresh = yield* service
        .importPasswords({ format: "auto", content, profileId, origin: "browser", refresh: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      const { accountId } = yield* service.save({
        name: "Test key 2",
        details: { kind: "api-key", sites: ["https://openrouter.ai"], auth: { type: "bearer" } },
        secrets: { token: { type: "scient", value: syntheticValue() } },
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(refresh);
      const names = (yield* service.snapshot).accounts.map(({ name }) => name);
      expect(names).toContain("Test key 2");
      expect(names).toContain("Other");
      // And as a restart reads it back.
      const { service: restarted } = yield* makeHarness({ storage });
      expect(
        (yield* restarted.snapshot).accounts.some((account) => account.accountId === accountId),
      ).toBe(true);
    }),
  );
});

describe("AccountsService removed logins", () => {
  it.effect("treats DOMAIN\\user in another case as the same login, in imports and removals", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("work");
      const line = (username: string) =>
        `name,url,username,password\nTSS,https://tss2.ada.huji.ac.il/login,${username},${syntheticValue()}`;
      yield* service.importPasswords({
        format: "auto",
        content: line("CC\\corcosy"),
        profileId,
        origin: "browser",
      });
      // The same login in another case updates it; no second row.
      yield* service.importPasswords({ format: "auto", content: line("cc\\corcosy"), profileId });
      const rows = (yield* service.snapshot).accounts;
      expect(rows).toHaveLength(1);
      yield* service.remove(rows[0]!.accountId);
      // Removed, it stays removed from a browser in either case.
      expect(
        yield* service.importPasswords({
          format: "auto",
          content: line("cc\\CORCOSY"),
          profileId,
          origin: "browser",
        }),
      ).toEqual({ created: 0, updated: 0, skipped: 1 });
    }),
  );

  it.effect("keeps a removed login out of browser imports until a file import brings it back", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("work");
      const content = `name,url,username,password\nSite,https://example.com/login,user,${syntheticValue()}`;
      yield* service.importPasswords({ format: "auto", content, profileId, origin: "browser" });
      const [login] = (yield* service.snapshot).accounts;
      yield* service.setControls({
        target: { type: "account", accountId: login!.accountId },
        access: "off",
      });
      yield* service.remove(login!.accountId);
      // A refresh brings back neither the login nor, Allowed, a copy of it.
      expect(
        yield* service.importPasswords({ format: "auto", content, profileId, origin: "browser" }),
      ).toEqual({ created: 0, updated: 0, skipped: 1 });
      expect((yield* service.snapshot).accounts).toEqual([]);
      expect(yield* service.importPasswords({ format: "auto", content, profileId })).toEqual({
        created: 1,
        updated: 0,
        skipped: 0,
      });
      // Saved for an exact origin and removed: a browser's bare host is that login too.
      const exact = yield* service.save({
        ...website(),
        details: {
          kind: "website",
          sites: ["https://exact.example.com"],
          username: "user",
          profileId,
        },
      });
      yield* service.remove(exact.accountId);
      const bare = `name,url,username,password\nSite,https://exact.example.com/login,user,${syntheticValue()}`;
      expect(
        (yield* service.importPasswords({
          format: "auto",
          content: bare,
          profileId,
          origin: "browser",
        })).created,
      ).toBe(0);
      // Nor does Google's refresh bring back a removed Google address.
      yield* service.googleSessionsSeen({
        profileId,
        sessions: [{ email: "a@example.com", valid: true }],
      });
      const google = (yield* service.snapshot).accounts.find(
        ({ details }) => details.kind === "website" && details.username === "a@example.com",
      )!;
      yield* service.remove(google.accountId);
      yield* service.googleSessionsSeen({
        profileId,
        sessions: [{ email: "a@example.com", valid: true }],
      });
      expect(
        (yield* service.snapshot).accounts.some(
          ({ details }) => details.kind === "website" && details.username === "a@example.com",
        ),
      ).toBe(false);
      // A removed session row isn't made again from a browser's imported sessions either.
      const imported = { site: "other.example.com", how: "imported" as const, from: "Chrome" };
      const { created } = yield* service.sessionsSeen({ profileId, sessions: [imported] });
      yield* service.remove(created[0]!);
      expect((yield* service.sessionsSeen({ profileId, sessions: [imported] })).created).toEqual(
        [],
      );
    }),
  );
});

describe("AccountsService imports never erase", () => {
  it.effect("keeps a login's code, sites, university and undated password through imports", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const [value, code] = [syntheticValue(), "JBSWY3DPEHPK3PXP"];
      const institution = {
        name: "Synthetic University",
        entityId: "https://idp.example.com/entity",
        domain: "example.com",
      };
      const { accountId } = yield* service.save({
        ...website(value),
        details: {
          kind: "website",
          sites: ["example.com", "library.example.com"],
          username: "synthetic-user",
          institution,
        },
        secrets: {
          password: { type: "scient", value },
          totp: { type: "scient", value: code },
        },
      });
      const line = (password: string) =>
        `name,url,username,password\nSite,https://example.com/login,synthetic-user,${password}`;
      // A different password with no dates to compare is not known to be newer.
      expect(
        yield* service.importPasswords({ format: "auto", content: line(syntheticValue()) }),
      ).toEqual({ created: 0, updated: 0, skipped: 1 });
      // The same login claimed by a profile is patched, not rebuilt.
      expect(
        yield* service.importPasswords({
          format: "auto",
          content: line(value),
          profileId: "imported",
        }),
      ).toEqual({ created: 0, updated: 1, skipped: 0 });
      const account = (yield* service.snapshot).accounts.find(
        (row) => row.accountId === accountId,
      )!;
      expect(account.details).toEqual({
        kind: "website",
        sites: ["example.com", "library.example.com"],
        username: "synthetic-user",
        institution,
        loginUrl: "https://example.com/login",
        profileId: "imported",
      });
      const values = yield* service.resolveSecrets(accountId, ["password", "totp"]);
      expect([secretEquals(values.password, value), secretEquals(values.totp, code)]).toEqual([
        true,
        true,
      ]);
    }),
  );
});

describe("AccountsService import patches", () => {
  it.effect("never takes an export's code over a saved one, even with a newer password date", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const [value, current, older] = [syntheticValue(), "JBSWY3DPEHPK3PXP", "KRSXG5DSNFXGOIDB"];
      const { accountId } = yield* service.save({
        ...website(value),
        secrets: {
          password: { type: "scient", value, changedAt: "2024-01-01T00:00:00.000Z" },
          totp: { type: "scient", value: current },
        },
      });
      yield* service.importPasswords({
        format: "auto",
        content: `name,url,username,password,totp,password_changed\nSite,https://example.com/login,synthetic-user,${value},${older},2025-01-01T00:00:00.000Z`,
      });
      expect(secretEquals((yield* service.resolveSecrets(accountId, ["totp"])).totp, current)).toBe(
        true,
      );
    }),
  );

  it.effect("updates a login saved for the exact origin instead of adding a wider copy", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.save({
        ...website(),
        details: { kind: "website", sites: ["https://example.com"], username: "synthetic-user" },
      });
      yield* service.importPasswords({
        format: "auto",
        content: `name,url,username,password\nSite,https://example.com/login,synthetic-user,${syntheticValue()}`,
      });
      expect(
        (yield* service.snapshot).accounts.map(
          ({ details }) => "sites" in details && details.sites,
        ),
      ).toEqual([["https://example.com"]]);
    }),
  );
});

describe("AccountsService login identity", () => {
  it.effect("keeps a login's port and tenant: an import never adds it again wider or Allowed", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const ported = yield* service.save({
        ...website(),
        details: {
          kind: "website",
          sites: ["https://example.com:8443"],
          username: "synthetic-user",
        },
      });
      yield* service.setControls({
        target: { type: "account", accountId: ported.accountId },
        access: "off",
      });
      yield* service.save({
        ...website(),
        details: {
          kind: "website",
          sites: ["login.example.com"],
          username: "synthetic-user",
          loginUrl: "https://login.example.com/tenant-a",
        },
      });
      const line = (url: string) =>
        `name,url,username,password\nSite,${url},synthetic-user,${syntheticValue()}`;
      yield* service.importPasswords({
        format: "auto",
        content: line("https://example.com:8443/login"),
      });
      yield* service.importPasswords({
        format: "auto",
        content: line("https://login.example.com/tenant-b"),
      });
      const rows = (yield* service.snapshot).accounts.map(({ details, controls }) => [
        details.kind === "website" ? [details.sites, details.loginUrl] : undefined,
        controls.access,
      ]);
      expect(rows).toEqual([
        [[["https://example.com:8443"], undefined], "off"],
        [[["login.example.com"], "https://login.example.com/tenant-a"], "allowed"],
        [[["login.example.com"], "https://login.example.com/tenant-b"], "allowed"],
      ]);
    }),
  );
});

describe("AccountsService login identity across imports and removals", () => {
  it.effect("adds no wider login next to an exact-origin one, and removes tenants one by one", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("work");
      yield* service.save({
        ...website(),
        details: {
          kind: "website",
          sites: ["https://exact.example.com"],
          username: "user",
          loginUrl: "https://exact.example.com/signin",
        },
      });
      const line = (url: string) =>
        `name,url,username,password\nSite,${url},user,${syntheticValue()}`;
      const browser = (url: string) =>
        service.importPasswords({
          format: "auto",
          content: line(url),
          profileId,
          origin: "browser",
        });
      // Another tenant of an exact-origin login: its own row, and as exact.
      yield* browser("https://exact.example.com/login");
      const sitesOf = Effect.map(service.snapshot, ({ accounts }) =>
        accounts.flatMap(({ details }) => (details.kind === "website" ? [details.sites] : [])),
      );
      expect(yield* sitesOf).toEqual([
        ["https://exact.example.com"],
        ["https://exact.example.com"],
      ]);
      // Tenant A removed: tenant B still imports, and a file of B doesn't bring A back.
      yield* browser("https://tenant.example.com/a");
      const a = (yield* service.snapshot).accounts.find(
        ({ details }) => details.kind === "website" && details.loginUrl?.endsWith("/a"),
      )!;
      yield* service.remove(a.accountId);
      expect((yield* browser("https://tenant.example.com/b")).created).toBe(1);
      yield* service.importPasswords({
        format: "auto",
        content: line("https://tenant.example.com/b"),
        profileId,
      });
      expect((yield* browser("https://tenant.example.com/a")).created).toBe(0);
      // A login removed with no profile stays out of every profile's browser imports.
      const shared = yield* service.save({
        ...website(),
        details: { kind: "website", sites: ["shared.example.com"], username: "user" },
      });
      yield* service.remove(shared.accountId);
      const unprofiled = yield* service.importPasswords({
        format: "auto",
        content: line("https://shared.example.com/login"),
        origin: "browser",
      });
      expect(unprofiled.created).toBe(0);
      expect((yield* browser("https://shared.example.com/login")).created).toBe(0);
      // Controls and reach come from this profile's logins, the most closed first, in any order.
      yield* service.save({
        ...website(),
        details: {
          kind: "website",
          sites: ["closed.example.com"],
          username: "user",
          profileId: BrowserProfileId.make("other"),
        },
      });
      const off = yield* service.save({
        ...website(),
        details: {
          kind: "website",
          sites: ["https://closed.example.com"],
          username: "user",
          loginUrl: "https://closed.example.com/signin",
          profileId,
        },
      });
      yield* service.setControls({
        target: { type: "account", accountId: off.accountId },
        access: "off",
      });
      yield* browser("https://closed.example.com/login");
      const added = (yield* service.snapshot).accounts.find(
        ({ details }) =>
          details.kind === "website" && details.loginUrl === "https://closed.example.com/login",
      )!;
      expect([
        added.details.kind === "website" && added.details.sites,
        added.controls.access,
      ]).toEqual([["https://closed.example.com"], "off"]);
    }),
  );
});

describe("AccountsService import identity", () => {
  it.effect("matches an email login whatever its case, and other usernames exactly", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const line = (username: string) =>
        `name,url,username,password\nSite,https://example.com/login,${username},${syntheticValue()}`;
      yield* service.importPasswords({ format: "auto", content: line("Ada@Example.com") });
      yield* service.importPasswords({ format: "auto", content: line("Grace") });
      expect(
        yield* service.importPasswords({
          format: "auto",
          content: [line("ada@example.com"), line("grace").split("\n")[1]].join("\n"),
        }),
      ).toEqual({ created: 1, updated: 0, skipped: 1 });
    }),
  );
});

describe("AccountsService imported password dates", () => {
  it.effect("keeps the newest password of a sign-in and its date, whatever the order", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const [newer, older] = [syntheticValue(), syntheticValue()];
      const content = `name,url,username,password,password_changed\nSynthetic,https://login.example.com/,user,${newer},2025-01-01T00:00:00.000Z\nSynthetic,https://login.example.com/old,user,${older},2023-01-01T00:00:00.000Z`;
      yield* service.importPasswords({ format: "auto", content });
      const account = (yield* service.snapshot).accounts[0]!;
      expect(account.secrets["password"]?.changedAt).toBe("2025-01-01T00:00:00.000Z");
      expect(
        secretEquals(
          (yield* service.resolveSecrets(account.accountId, ["password"])).password,
          newer,
        ),
      ).toBe(true);
    }),
  );
});

describe("AccountsService imported date only", () => {
  it.effect(
    "adds a newer date to an unchanged password without touching its sign-in evidence",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const value = syntheticValue();
        const row = (date: string) =>
          `name,url,username,password,password_changed\nSynthetic,https://login.example.com/,user,${value},${date}`;
        yield* service.importPasswords({ format: "auto", content: row("") });
        const { accountId } = (yield* service.snapshot).accounts[0]!;
        yield* service.recordCheck(accountId, { state: "password-rejected" });
        expect(
          yield* service.importPasswords({
            format: "auto",
            content: row("2025-01-01T00:00:00.000Z"),
          }),
        ).toEqual({ created: 0, updated: 0, skipped: 1 });
        yield* service.importPasswords({
          format: "auto",
          content: row("2024-01-01T00:00:00.000Z"),
        });
        const account = (yield* service.snapshot).accounts[0]!;
        expect(account.signIn?.state).toBe("password-rejected");
        expect(account.secrets["password"]?.changedAt).toBe("2025-01-01T00:00:00.000Z");
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

  it.effect(
    "writes a new password to every copy of a login, each keeping the one it replaced",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const login = (username: string, site: string, profileId: string, value: string) =>
          service.save({
            name: profileId,
            details: { kind: "website", sites: [site], username, profileId },
            secrets: { password: { type: "scient", value } },
          });
        const [first, second, unrelated] = [syntheticValue(), syntheticValue(), syntheticValue()];
        const lab = yield* login("Ada@Lab.org", "example.com", "profile-a", first);
        const home = yield* login("ada@lab.org", "https://example.com", "profile-b", second);
        const other = yield* login("Ada", "example.com", "profile-a", unrelated);
        yield* service.recordCheck(lab.accountId, { state: "signed-in" });
        const next = syntheticValue();
        yield* service.save({
          accountId: lab.accountId,
          name: "profile-a",
          details: {
            kind: "website",
            sites: ["example.com"],
            username: "Ada@Lab.org",
            profileId: "profile-a",
          },
          // Lab's own store choice and second factor stay Lab's.
          secrets: {
            password: { type: "scient", value: next, saveTo: [{ type: "keychain" }] },
            totp: { type: "scient", value: "JBSWY3DPEHPK3PXP" },
          },
        });
        const password = (accountId: typeof lab.accountId) =>
          Effect.map(service.resolveSecrets(accountId, ["password"]), (values) => values.password);
        expect(secretEquals(yield* password(lab.accountId), next)).toBe(true);
        expect(secretEquals(yield* password(home.accountId), next)).toBe(true);
        expect(secretEquals(yield* password(other.accountId), unrelated)).toBe(true);
        expect((yield* service.reveal(lab.accountId, "previous")).value).toBe(first);
        expect((yield* service.reveal(home.accountId, "previous")).value).toBe(second);
        // Saving the same password again, as a retry would, keeps the one it replaced.
        yield* service.save({
          accountId: lab.accountId,
          name: "profile-a",
          details: {
            kind: "website",
            sites: ["example.com"],
            username: "Ada@Lab.org",
            profileId: "profile-a",
          },
          secrets: { password: { type: "scient", value: next } },
        });
        expect((yield* service.reveal(lab.accountId, "previous")).value).toBe(first);
        const rows = (yield* service.snapshot).accounts;
        const row = (accountId: string) => rows.find((account) => account.accountId === accountId);
        // A live session stays live, and each copy keeps its own profile.
        expect(row(lab.accountId)?.signIn?.state).toBe("signed-in");
        expect(row(home.accountId)?.details).toMatchObject({ profileId: "profile-b" });
        expect(row(home.accountId)?.secrets.password?.previousAt).toBeDefined();
        expect(row(home.accountId)?.secrets.totp).toBeUndefined();
        expect(row(home.accountId)?.status).toBe("ready");
      }),
  );

  it.effect("undoes a new password by giving each copy back its own earlier one", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const details = (profileId: string) => ({
        kind: "website" as const,
        sites: ["example.com"],
        username: "Ada@Lab.org",
        profileId,
      });
      const login = (profileId: string, value: string, accountId?: AccountId) =>
        service.save({
          ...(accountId ? { accountId } : {}),
          name: profileId,
          details: details(profileId),
          secrets: { password: { type: "scient", value } },
        });
      const [first, second, third] = [syntheticValue(), syntheticValue(), syntheticValue()];
      const lab = (yield* login("profile-a", first)).accountId;
      const home = (yield* login("profile-b", second)).accountId;
      const spare = (yield* login("profile-c", third)).accountId;
      const next = syntheticValue();
      yield* login("profile-a", next, lab);
      const [update] = (yield* service.snapshot).passwordUpdates ?? [];
      expect(update).toMatchObject({ accountId: lab, name: "profile-a" });
      expect(yield* service.undoPasswordUpdate(update!.undoId)).toEqual({
        restored: 3,
        changed: 0,
      });
      const password = (accountId: AccountId) =>
        Effect.map(service.resolveSecrets(accountId, ["password"]), (values) => values.password);
      expect(secretEquals(yield* password(lab), first)).toBe(true);
      expect(secretEquals(yield* password(home), second)).toBe(true);
      expect(secretEquals(yield* password(spare), third)).toBe(true);
      expect((yield* service.reveal(home, "previous")).value).toBe(next);
      expect((yield* service.snapshot).passwordUpdates).toBeUndefined();
      expect((yield* service.undoPasswordUpdate(update!.undoId).pipe(Effect.flip)).message).toMatch(
        /no longer/,
      );
      // Changed again since: an older update's Undo leaves the newer password everywhere.
      yield* login("profile-a", syntheticValue(), lab);
      const newest = syntheticValue();
      yield* login("profile-b", newest, home);
      const [older] = (yield* service.snapshot).passwordUpdates ?? [];
      expect(yield* service.undoPasswordUpdate(older!.undoId)).toEqual({ restored: 0, changed: 3 });
      for (const id of [lab, home, spare])
        expect(secretEquals(yield* password(id), newest)).toBe(true);
    }),
  );

  it.effect("keeps found 2FA keys with one Undo: the earlier key back, a made login gone", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const earlier = "otpauth://totp/Lab:ada?secret=JBSWY3DPEHPK3PXP";
      const found = "otpauth://totp/Lab:ada?secret=KRSXG5CTMVRXEZLU";
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: ["example.com"], username: "ada" },
        secrets: { totp: { type: "scient", value: earlier } },
      })).accountId;
      const kept = yield* service.keepFound([
        { field: "totp", value: Redacted.make(found), accountId: lab },
        {
          field: "totp",
          value: Redacted.make(found),
          login: { name: "Other", details: { kind: "website", sites: ["example.org"] } },
        },
      ]);
      const totp = (accountId: AccountId) =>
        Effect.map(service.resolveSecrets(accountId, ["totp"]), (values) => values.totp);
      expect(secretEquals(yield* totp(lab), found)).toBe(true);
      const [update] = (yield* service.snapshot).passwordUpdates ?? [];
      expect(update).toMatchObject({ accountId: lab, field: "totp" });
      expect(yield* service.undoPasswordUpdate(update!.undoId)).toEqual({
        restored: 2,
        changed: 0,
      });
      expect(secretEquals(yield* totp(lab), earlier)).toBe(true);
      expect((yield* service.snapshot).accounts.map((row) => row.accountId)).not.toContain(kept[1]);
    }),
  );

  it.effect("undoes only what it kept: a made login given a password since stays", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const key = "otpauth://totp/Lab:ada?secret=JBSWY3DPEHPK3PXP";
      const [made] = yield* service.keepFound([
        {
          field: "totp",
          value: Redacted.make(key),
          login: {
            name: "Lab",
            details: { kind: "website", sites: ["example.com"], username: "ada" },
          },
        },
      ]);
      const [keyUndo] = (yield* service.snapshot).passwordUpdates ?? [];
      const row = () =>
        Effect.map(service.snapshot, ({ accounts }) =>
          accounts.find((account) => account.accountId === made),
        );
      // The first password saved into the key's login has its own Undo, which takes it out.
      yield* service.save({
        accountId: made!,
        name: "Lab",
        details: (yield* row())!.details,
        secrets: { password: { type: "scient", value: "first-made-password" } },
      });
      const passwordUndo = ((yield* service.snapshot).passwordUpdates ?? []).find(
        (update) => update.undoId !== keyUndo!.undoId,
      );
      expect(passwordUndo).toMatchObject({ accountId: made });
      expect(passwordUndo?.field).toBeUndefined();
      // Undoing the key leaves the login and its password; only the key goes.
      yield* service.undoPasswordUpdate(keyUndo!.undoId);
      expect(Object.keys((yield* row())?.secrets ?? {})).toEqual(["password"]);
      yield* service.undoPasswordUpdate(passwordUndo!.undoId);
      expect((yield* row())?.secrets).toEqual({});
    }),
  );

  it.effect(
    "holds each factor a page shows on its own, on no login, until the person saves it",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const origin = "https://lab.example.org";
        const lab = (yield* service.save({
          name: "Lab",
          details: { kind: "website", sites: [origin], username: "ada" },
          secrets: {
            totp: { type: "scient", value: "otpauth://totp/Lab:ada?secret=AAAAAAAAAAAAAAAA" },
          },
        })).accountId;
        // A bare site's subdomain is another site: not a login these factors could be for.
        yield* service.save({
          name: "Example",
          details: { kind: "website", sites: ["example.org"], username: "bea" },
          secrets: {},
        });
        const first = "otpauth://totp/Lab?secret=JBSWY3DPEHPK3PXP";
        const second = "otpauth://totp/Lab?secret=KRSXG5CTMVRXEZLU";
        const one = yield* service.holdPending({
          kind: "totp",
          value: Redacted.make(first),
          origin,
        });
        const two = yield* service.holdPending({
          kind: "totp",
          value: Redacted.make(second),
          origin,
        });
        // The same key shown again is the same record.
        expect(
          yield* service.holdPending({ kind: "totp", value: Redacted.make(first), origin }),
        ).toBe(one);
        const snapshot = yield* service.snapshot;
        expect(snapshot.pendingSecrets?.map((held) => [held.pendingId, held.candidates])).toEqual([
          [one, [lab]],
          [two, [lab]],
        ]);
        // Nothing reached a login: the saved key stays, and no row was made.
        const totp = (accountId: AccountId) =>
          Effect.map(service.resolveSecrets(accountId, ["totp"]), (values) => values.totp);
        expect(
          secretEquals(yield* totp(lab), "otpauth://totp/Lab:ada?secret=AAAAAAAAAAAAAAAA"),
        ).toBe(true);
        expect(snapshot.accounts).toHaveLength(2);
        // The person saves one to Lab (as they see it) and the other to a new login; each is
        // then gone.
        const seen = snapshot.accounts.find((row) => row.accountId === lab)!.updatedAt;
        expect(
          yield* service.pending({ type: "save", pendingId: two, accountId: lab, updatedAt: seen }),
        ).toEqual({ accountId: lab });
        expect(secretEquals(yield* totp(lab), second)).toBe(true);
        const made = (yield* service.pending({ type: "save", pendingId: one })).accountId!;
        expect(secretEquals(yield* totp(made), first)).toBe(true);
        expect((yield* service.snapshot).pendingSecrets).toBeUndefined();
      }),
  );

  it.effect("keeps a login's working password until the site takes a new one", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const password = Effect.map(
        service.resolveSecrets(shop, ["password"]),
        (values) => values.password,
      );
      const rotate = (value: string) =>
        service.pending({
          type: "rotate",
          origin,
          username: "ada",
          password: value,
          accountId: shop,
        });
      // Two tabs send B and C over A: until a site's answer, A stays, and neither shows.
      const b = (yield* rotate("new-B")).pendingId!;
      const c = (yield* rotate("new-C")).pendingId!;
      expect(secretEquals(yield* password, "working-A")).toBe(true);
      expect((yield* service.snapshot).pendingSecrets).toBeUndefined();
      // The person says B didn't take: forgotten, A still there. C's answer unclear: asked.
      yield* service.pending({ type: "discard", pendingId: b });
      yield* service.pending({ type: "settle", pendingId: c, outcome: "unclear" });
      expect(secretEquals(yield* password, "working-A")).toBe(true);
      expect((yield* service.snapshot).pendingSecrets).toMatchObject([
        { pendingId: c, kind: "password", accountId: shop, unclear: true },
      ]);
      // They say it took: C is saved, with an Undo that brings A back.
      yield* service.pending({ type: "save", pendingId: c });
      expect(secretEquals(yield* password, "new-C")).toBe(true);
      const [update] = (yield* service.snapshot).passwordUpdates ?? [];
      yield* service.undoPasswordUpdate(update!.undoId);
      expect(secretEquals(yield* password, "working-A")).toBe(true);
    }),
  );

  it.effect("a late answer never displaces a newer password: both are kept for the person", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const password = Effect.map(
        service.resolveSecrets(shop, ["password"]),
        (values) => values.password,
      );
      // B is held as it is filled, over A.
      const { pendingId } = yield* service.pending({
        type: "reserve",
        origin,
        password: "late-B",
        accountId: shop,
      });
      // Meanwhile C was saved (another tab, the person); B's form is sent and taken after.
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-C" } },
      });
      yield* service.pending({
        type: "rotate",
        pendingId: pendingId!,
        origin,
        username: "ada",
        password: "late-B",
        accountId: shop,
      });
      expect(
        yield* service.pending({ type: "settle", pendingId: pendingId!, outcome: "accepted" }),
      ).toEqual({ pendingId, conflict: true });
      expect(secretEquals(yield* password, "working-C")).toBe(true);
      expect((yield* service.snapshot).pendingSecrets).toMatchObject([
        { pendingId, kind: "password", conflict: true },
      ]);
      // "It took it" alone keeps both still; "Use this one" is the person's choice, for the
      // login as they see it.
      yield* service.pending({ type: "save", pendingId: pendingId! });
      expect(secretEquals(yield* password, "working-C")).toBe(true);
      const seen = (yield* service.snapshot).accounts.find((row) => row.accountId === shop)!;
      yield* service.pending({
        type: "save",
        pendingId: pendingId!,
        replace: true,
        updatedAt: seen.updatedAt,
      });
      expect(secretEquals(yield* password, "late-B")).toBe(true);
    }),
  );

  it.effect("a username-free login's new password never lands on it once it is someone's", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin] },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      // Fix fills B for the login, which names nobody; then it is edited to be bob's.
      const { pendingId } = yield* service.pending({
        type: "reserve",
        origin,
        password: "new-B",
        accountId: shop,
      });
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "bob" },
        secrets: {},
      });
      // The form sends no username: the site's answer still can't put B on bob's login.
      yield* service.pending({
        type: "rotate",
        pendingId: pendingId!,
        origin,
        username: "",
        password: "new-B",
        accountId: shop,
      });
      expect(
        yield* service.pending({ type: "settle", pendingId: pendingId!, outcome: "accepted" }),
      ).toMatchObject({ conflict: true });
      const seen = (yield* service.snapshot).accounts.find((row) => row.accountId === shop)!;
      const refused = yield* service
        .pending({ type: "save", pendingId: pendingId!, replace: true, updatedAt: seen.updatedAt })
        .pipe(Effect.flip);
      expect(refused.message).toBe("That login changed since. Look at it again.");
      const values = yield* service.resolveSecrets(shop, ["password"]);
      expect(secretEquals(values.password, "working-A")).toBe(true);
    }),
  );

  it.effect("a login the fill didn't know is the person's to answer for, never the site's", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const login = (username: string, password: string) =>
        service.save({
          name: "Shop",
          details: { kind: "website", sites: [origin], username },
          secrets: { password: { type: "scient", value: password } },
        });
      const ada = (yield* login("ada", "ada-A")).accountId;
      const password = (accountId: AccountId) =>
        Effect.map(service.resolveSecrets(accountId, ["password"]), (values) => values.password);
      // Filled from the toolbar, its login not known yet: each of the site's logins is noted.
      const reserve = (made: string) =>
        Effect.map(
          service.pending({ type: "reserve", origin, password: made }),
          ({ pendingId }) => pendingId!,
        );
      const send = (pendingId: string, made: string, accountId: AccountId, username: string) =>
        service.pending({
          type: "rotate",
          pendingId,
          origin,
          username,
          password: made,
          accountId,
        });
      const forAda = yield* reserve("ada-B");
      const forCara = yield* reserve("cara-B");
      // cara's login is saved after the fill: how it was at the fill can't be told.
      const cara = (yield* login("cara", "cara-A")).accountId;
      yield* send(forAda, "ada-B", ada, "ada");
      yield* send(forCara, "cara-B", cara, "cara");
      yield* service.pending({ type: "settle", pendingId: forAda, outcome: "accepted" });
      expect(secretEquals(yield* password(ada), "ada-B")).toBe(true);
      yield* service.pending({ type: "settle", pendingId: forCara, outcome: "accepted" });
      expect(secretEquals(yield* password(cara), "cara-A")).toBe(true);
      expect((yield* service.snapshot).pendingSecrets).toMatchObject([
        { pendingId: forCara, unclear: true },
      ]);
      // The person says it took: saved.
      yield* service.pending({ type: "save", pendingId: forCara });
      expect(secretEquals(yield* password(cara), "cara-B")).toBe(true);
    }),
  );

  it.effect(
    "a new password the site seemed to take but didn't: each refusal tries the next, once",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const origin = "https://shop.example.com";
        const shop = (yield* service.save({
          name: "Shop",
          details: { kind: "website", sites: [origin], username: "ada" },
          secrets: { password: { type: "scient", value: "working-A" } },
        })).accountId;
        const password = Effect.map(
          service.resolveSecrets(shop, ["password"]),
          (values) => values.password,
        );
        // The page posted each new password to an endpoint that answered 200, though the change
        // failed: Scient saved it on the site's answer.
        const accepted = acceptedOn(service, shop, origin, "ada");
        yield* accepted("never-took-B");
        yield* accepted("never-took-C");
        expect(secretEquals(yield* password, "never-took-C")).toBe(true);
        const fill = Effect.map(service.fillValues(shop, origin), (values) => values.attempt!);
        const seen = personSaw(service, shop);
        // A result naming no attempt (an older client) moves nothing.
        yield* seen("password-rejected");
        expect(secretEquals(yield* password, "never-took-C")).toBe(true);
        // Refused with what was filled: the next fill types the next one, newest first.
        const first = yield* fill;
        yield* seen("password-rejected", first);
        expect(secretEquals(yield* password, "never-took-B")).toBe(true);
        // The same attempt's result again (a replay) moves nothing.
        yield* seen("password-rejected", first);
        expect(secretEquals(yield* password, "never-took-B")).toBe(true);
        yield* seen("password-rejected", yield* fill);
        expect(secretEquals(yield* password, "working-A")).toBe(true);
        // Signed in with A: proven, it goes first; B and C stay in its history all the same.
        yield* seen("signed-in", yield* fill);
        expect(secretEquals(yield* password, "working-A")).toBe(true);
        expect(yield* earlierPasswords(service, shop)).toEqual(["never-took-C", "never-took-B"]);
        // A refused too: with every one refused, the newest is held, for the person.
        yield* seen("password-rejected", yield* fill);
        expect(secretEquals(yield* password, "never-took-C")).toBe(true);
        const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
        expect(row.secrets.password?.refusedAt).toBeDefined();
        expect(yield* earlierPasswords(service, shop)).toEqual(["never-took-B", "working-A"]);
      }),
  );

  it.effect("keeps every password a login held; only the person's Remove lets one go", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const saveAs = (value: string) =>
        service.save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: { password: { type: "scient", value } },
        });
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const password = Effect.map(
        service.resolveSecrets(shop, ["password"]),
        (values) => values.password,
      );
      const versionOf = (value: string) =>
        Effect.gen(function* () {
          const listed = yield* earlierPasswords(service, shop);
          const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
          return row.secrets.password!.history![listed.indexOf(value)]!.version;
        });
      // Eleven saved on sites' word, none proven: all kept, none waits for the person.
      const made = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"].map(
        (at) => `never-took-${at}`,
      );
      for (const next of made) yield* acceptedOn(service, shop, origin, "ada")(next);
      expect(secretEquals(yield* password, "never-took-L")).toBe(true);
      expect((yield* service.snapshot).pendingSecrets ?? []).toEqual([]);
      expect(yield* earlierPasswords(service, shop)).toEqual([
        ...made.slice(0, -1).toReversed(),
        "working-A",
      ]);
      // Saved again (a toolbar's repeat, an earlier one typed anew): the kept one, no second copy.
      yield* saveAs("never-took-L");
      yield* saveAs("never-took-C");
      expect(secretEquals(yield* password, "never-took-C")).toBe(true);
      const again = yield* earlierPasswords(service, shop);
      expect(again).toHaveLength(11);
      expect(new Set(again).size).toBe(11);
      // An earlier one typed on the site matches what is kept: nothing to add.
      expect(
        yield* service.matchSignIn({ origin, username: "ada", password: "never-took-E" }),
      ).toEqual({ result: "same", accountId: shop });
      // Use this one reorders only.
      yield* service.usePassword(shop, yield* versionOf("working-A"));
      expect(secretEquals(yield* password, "working-A")).toBe(true);
      expect(yield* earlierPasswords(service, shop)).toHaveLength(11);
      // The person's Remove, with Undo for the hour; then gone.
      const { undoId } = yield* service.removePasswordVersion(
        shop,
        yield* versionOf("never-took-B"),
      );
      expect(yield* earlierPasswords(service, shop)).not.toContain("never-took-B");
      yield* service.restorePasswordVersion(undoId);
      expect(yield* earlierPasswords(service, shop)).toContain("never-took-B");
      const removed = yield* service.removePasswordVersion(shop, yield* versionOf("never-took-B"));
      yield* TestClock.adjust("2 hours");
      expect((yield* service.restorePasswordVersion(removed.undoId).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
      const left = yield* earlierPasswords(service, shop);
      expect(left).toHaveLength(10);
      expect(left).not.toContain("never-took-B");
    }),
  );

  it.effect("a sign-in proves the password it used, even late; nothing leaves for it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const password = Effect.map(
        service.resolveSecrets(shop, ["password"]),
        (values) => values.password,
      );
      yield* acceptedOn(service, shop, origin, "ada")("took-B");
      const seen = personSaw(service, shop);
      const fill = Effect.map(service.fillValues(shop, origin), (values) => values.attempt!);
      const withB = yield* fill;
      const lateB = yield* fill;
      // Refused once (a page that only looked like the form again), then B's own success.
      yield* seen("password-rejected", withB);
      expect(secretEquals(yield* password, "working-A")).toBe(true);
      yield* seen("signed-in", lateB);
      expect(secretEquals(yield* password, "took-B")).toBe(true);
      expect((yield* service.reveal(shop, "previous")).value).toBe("working-A");
      // A proof (even a false one) only puts B first: refused later, A is still there to try.
      yield* seen("password-rejected", yield* fill);
      expect(secretEquals(yield* password, "working-A")).toBe(true);
    }),
  );

  it.effect("keeps a working Previous through an unproven automatic save, past its Undo", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const login = (value: string, accountId?: AccountId) =>
        service.save({
          ...(accountId ? { accountId } : {}),
          name: "Shop",
          details: { kind: "website", sites: [origin], username: "ada" },
          secrets: { password: { type: "scient", value } },
        });
      const shop = (yield* login("working-A")).accountId;
      // The person saves B: A is its Previous. An hour on, an unproven C comes on a site's word.
      yield* login("typed-B", shop);
      yield* TestClock.adjust("2 hours");
      yield* acceptedOn(service, shop, origin, "ada")("never-took-C");
      expect(yield* earlierPasswords(service, shop)).toEqual(["typed-B", "working-A"]);
      // Shown in the login's details, A can be put back by the person.
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      yield* service.usePassword(shop, row.secrets.password!.history!.at(-1)!.version);
      const values = yield* service.resolveSecrets(shop, ["password"]);
      expect(secretEquals(values.password, "working-A")).toBe(true);
      expect(yield* earlierPasswords(service, shop)).toEqual(["never-took-C", "typed-B"]);
    }),
  );

  it.effect("Use this one on a login linked to the Keychain makes it Scient's own again", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        sourceOverrides: { keychain: () => Effect.succeed(Redacted.make("linked-K")) },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details,
        secrets: { password: { type: "keychain", service: "Shop", account: "ada" } },
      });
      expect((yield* service.fillValues(shop, origin)).password).toBe("linked-K");
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      yield* service.usePassword(shop, row.secrets.password!.history![0]!.version);
      const now = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(now.secrets.password?.source).toEqual({ type: "scient" });
      expect((yield* service.fillValues(shop, origin)).password).toBe("working-A");
    }),
  );

  it.effect("Remove takes a login's Previous with it, and its Undo brings both back", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "first-A" } },
      })).accountId;
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "second-B" } },
      });
      expect((yield* service.reveal(shop, "previous")).value).toBe("first-A");
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      const { undoId } = yield* service.removePasswordVersion(
        shop,
        row.secrets.password!.history![0]!.version,
      );
      expect((yield* service.reveal(shop, "previous").pipe(Effect.flip)).reason).toBe("not-found");
      expect(yield* earlierPasswords(service, shop)).toEqual([]);
      yield* service.restorePasswordVersion(undoId);
      expect((yield* service.reveal(shop, "previous")).value).toBe("first-A");
      expect(yield* earlierPasswords(service, shop)).toEqual(["first-A"]);
    }),
  );

  it.effect("a copy written later lays no password, nor a stale Previous, over the login", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { service } = yield* makeHarness({
        sourceOverrides: {
          writeKeychain: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const saveAs = (secrets: Parameters<typeof service.save>[0]["secrets"]) =>
        service.save({ accountId: shop, name: "Shop", details, secrets });
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "first-A" } },
      })).accountId;
      // A 2FA key whose Keychain copy is still being written…
      const factor = yield* saveAs({
        totp: {
          type: "scient",
          value: "JBSWY3DPEHPK3PXP",
          saveTo: [{ type: "scient" }, { type: "keychain" }],
        },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // …while the password changes twice.
      yield* saveAs({ password: { type: "scient", value: "second-B" } });
      yield* saveAs({ password: { type: "scient", value: "third-C" } });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(factor);
      expect((yield* service.reveal(shop, "previous")).value).toBe("second-B");
      expect((yield* service.reveal(shop, "password")).value).toBe("third-C");
      expect(yield* earlierPasswords(service, shop)).toEqual(["second-B", "first-A"]);
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(row.secrets.totp?.copies).toEqual([expect.objectContaining({ type: "keychain" })]);
    }),
  );

  it.effect("deletes a value staged for a write that never landed: it was journaled first", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, blobs } = yield* makeHarness({ storage });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "first-A" } },
      })).accountId;
      const values = () => [...blobs.keys()].filter((name) => name.startsWith("accounts-value-"));
      const before = values();
      // The value is written; the metadata naming it isn't.
      storage.failWritesTo("accounts-state", "accounts-value-");
      yield* service
        .save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: { password: { type: "scient", value: "second-B" } },
        })
        .pipe(Effect.flip);
      expect(values().filter((name) => !before.includes(name))).toHaveLength(1);
      storage.failWritesTo(undefined);
      yield* (yield* makeHarness({ storage })).service.snapshot;
      yield* TestClock.adjust("1 minute");
      expect(values()).toEqual(before);
    }),
  );

  it.effect("never deletes a value a record that didn't read named; its login's removal does", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      yield* acceptedOn(service, shop, origin, "ada")("new-B");
      yield* acceptedOn(service, shop, origin, "ada")("new-C");
      const name = "accounts-state";
      // What this service wrote, read back: the stored state's own history shape.
      const stored: { passwordHistory: Array<{ versions: Array<Record<string, unknown>> }> } =
        JSON.parse(
          new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
        );
      // A's version, in the history only, gets a timestamp no build reads.
      const version = stored.passwordHistory[0]!.versions[0]!;
      const ref = String(version["ref"]);
      stored.passwordHistory[0]!.versions[0] = { ...version, savedAt: 123 };
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      const { service: reopened } = yield* makeHarness({ storage });
      expect(yield* earlierPasswords(reopened, shop)).toEqual(["new-B"]);
      yield* TestClock.adjust("2 hours");
      expect(blobs.has(ref)).toBe(true);
      // Read again later, it is still kept.
      const { service: again } = yield* makeHarness({ storage });
      yield* again.snapshot;
      yield* TestClock.adjust("2 hours");
      expect(blobs.has(ref)).toBe(true);
      // The person removes the login: past its Undo, the value goes with it.
      yield* again.remove(shop);
      yield* TestClock.adjust("2 hours");
      expect(blobs.has(ref)).toBe(false);
    }),
  );

  it.effect("a held value survives a start whose Activity can't be written", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { blobs } = storage;
      const origin = "https://shop.example.com";
      // Each start ends before the next: no earlier service writes over the next one's state.
      const { shop, vault } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, vault } = yield* makeHarness({ storage });
          const shop = (yield* service.save({
            name: "Shop",
            details: { kind: "website", sites: [origin], username: "ada" },
            secrets: { password: { type: "scient", value: "working-A" } },
          })).accountId;
          yield* acceptedOn(service, shop, origin, "ada")("new-B");
          yield* acceptedOn(service, shop, origin, "ada")("new-C");
          return { shop, vault };
        }),
      );
      const name = "accounts-state";
      const stored: {
        passwordHistory: Array<{ versions: Array<Record<string, unknown>> }>;
        unreferenced?: Array<string>;
        taskPins?: Array<unknown>;
      } = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      );
      // A version no build reads still names a journaled value: its hold keeps it. A pin no build
      // reads is named in Activity.
      const version = stored.passwordHistory[0]!.versions[0]!;
      const ref = String(version["ref"]);
      stored.passwordHistory[0]!.versions[0] = { ...version, savedAt: 123 };
      stored.unreferenced = [...(stored.unreferenced ?? []), ref];
      stored.taskPins = [{ scheduledTaskId: "task:old", accountId: shop }];
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      // A start that can't write Activity; the next change is the person's.
      yield* Effect.scoped(
        Effect.gen(function* () {
          storage.failWritesTo("accounts-activity");
          const { service } = yield* makeHarness({ storage });
          yield* service.snapshot.pipe(Effect.ignore);
          storage.failWritesTo(undefined);
          yield* service.setAgentAccess(false);
        }),
      );
      // regression: the change wrote the state without the hold, and the restart swept the value.
      const { service: again } = yield* makeHarness({ storage });
      yield* again.snapshot;
      yield* TestClock.adjust("2 hours");
      expect(blobs.has(ref)).toBe(true);
      expect(yield* again.unreadableTaskPins).toEqual(["task:old"]);
    }),
  );

  it.effect("an identity edit takes its Previous and proof off the edited login", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://login.example.com";
      const shop = (yield* service.save({
        name: "Portal",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "tenant-a-A" } },
      })).accountId;
      yield* acceptedOn(service, shop, origin, "ada")("tenant-a-B");
      yield* service.recordUse(
        {
          target: { type: "account", accountId: shop },
          action: "sign-in",
          signInOutcome: "signed-in",
          outcome: "ok",
          savedPasswordUsed: true,
        },
        undefined,
        true,
      );
      const listed = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      const filled = yield* service.fillValues(shop, origin);
      yield* service.save({
        accountId: shop,
        name: listed.name,
        details: { ...listed.details, loginUrl: `${origin}/tenant-b` } as typeof listed.details,
        secrets: {},
      });
      const edited = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(edited.secrets.password?.verifiedAt).toBeUndefined();
      expect(edited.secrets.password?.previousAt).toBeUndefined();
      expect((yield* service.reveal(shop, "previous").pipe(Effect.flip)).reason).toBe("not-found");
      // Not proven for the edited login: no submit by itself.
      expect((yield* service.fillValues(shop, origin, undefined, undefined, true)).submit).toBe(
        undefined,
      );
      // The earlier fill's refusal, late, still closes the site it was typed on.
      yield* personSaw(service, shop)("password-rejected", filled.attempt);
      const other = (yield* service.save({
        name: "Mail",
        details: { kind: "website", sites: ["https://mail.example.com"], username: "ada" },
        secrets: { password: { type: "scient", value: "mail-A" } },
      })).accountId;
      yield* service.recordUse(
        {
          target: { type: "account", accountId: other },
          action: "sign-in",
          signInOutcome: "signed-in",
          outcome: "ok",
          savedPasswordUsed: true,
        },
        undefined,
        true,
      );
      expect(
        (yield* service.fillValues(other, "https://mail.example.com", undefined, undefined, true))
          .submit,
      ).toBeUndefined();
    }),
  );

  it.effect("Use this one keeps when the version last worked through its Keychain copy", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        sourceOverrides: { writeKeychain: () => Effect.void },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: {
          password: {
            type: "scient",
            value: "working-A",
            saveTo: [{ type: "scient" }, { type: "keychain" }],
          },
        },
      })).accountId;
      yield* service.recordUse(
        {
          target: { type: "account", accountId: shop },
          action: "sign-in",
          signInOutcome: "signed-in",
          outcome: "ok",
          savedPasswordUsed: true,
        },
        undefined,
        true,
      );
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "typed-B" } },
      });
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(row.secrets.password?.copies).toEqual([expect.objectContaining({ type: "keychain" })]);
      yield* service.usePassword(shop, row.secrets.password!.history![0]!.version);
      const now = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(now.secrets.password?.verifiedAt).toBeDefined();
      expect(now.secrets.password?.copies).toEqual([expect.objectContaining({ type: "keychain" })]);
    }),
  );

  it.effect("a password Undo puts back the kept value, and only on the login it was made for", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({
        storage,
        sourceOverrides: { writeKeychain: () => Effect.void },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: {
          password: {
            type: "scient",
            value: "first-A",
            saveTo: [{ type: "scient" }, { type: "keychain" }],
          },
        },
      })).accountId;
      const versions = () =>
        Effect.map(vault.decrypt("accounts-state", blobs.get("accounts-state")!), (bytes) => {
          // What this service wrote, read back: the stored state's own history shape.
          const saved: { passwordHistory?: Array<{ versions: Array<{ ref: string }> }> } =
            JSON.parse(new TextDecoder().decode(Redacted.value(bytes)));
          return (saved.passwordHistory ?? []).flatMap((history) =>
            history.versions.map((entry) => entry.ref),
          );
        });
      const changed = (value: string) =>
        service.save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: { password: { type: "scient", value } },
        });
      // Undo on a login mirrored to the Keychain: A again, under its own ref.
      const update = yield* changed("second-B");
      yield* service.undoPasswordUpdate(update.undoId!);
      expect((yield* service.reveal(shop, "password")).value).toBe("first-A");
      expect(new Set(yield* versions()).size).toBe(2);
      expect(yield* versions()).toHaveLength(2);
      // The login edited into another tenant: the earlier login's Undo leaves it as it is.
      const later = yield* changed("third-C");
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details: { ...details, loginUrl: `${origin}/tenant-b` },
        secrets: {},
      });
      expect(yield* service.undoPasswordUpdate(later.undoId!)).toEqual({ restored: 0, changed: 1 });
      expect((yield* service.reveal(shop, "password")).value).toBe("third-C");
    }),
  );

  it.effect("an Undo whose password was written since leaves it, the same value again too", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({ name: "Shop", details, secrets: {} })).accountId;
      const saveAs = (value: string) =>
        service.save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: { password: { type: "scient", value } },
        });
      // A, B, then A again (its kept value, its own ref): the first save's Undo is obsolete.
      const first = yield* saveAs("first-A");
      yield* saveAs("second-B");
      yield* saveAs("first-A");
      expect(yield* service.undoPasswordUpdate(first.undoId!)).toEqual({ restored: 0, changed: 1 });
      expect((yield* service.reveal(shop, "password")).value).toBe("first-A");
      expect(yield* earlierPasswords(service, shop)).toEqual(["second-B"]);
    }),
  );

  it.effect("a Keychain copy settled after a newer save of the same value leaves that save", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let writes = 0;
      const { service } = yield* makeHarness({
        sourceOverrides: {
          writeKeychain: () =>
            writes++ === 0
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      // A login whose password lives in the Keychain only.
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "keychain", service: "Shop", account: "ada" } },
      })).accountId;
      const saveTo = (saveTo: Array<{ type: "scient" } | { type: "keychain" }>) =>
        service.save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: { password: { type: "scient", value: "same-A", saveTo } },
        });
      // Kept only in the Keychain, its write still under way…
      const keychainOnly = yield* saveTo([{ type: "keychain" }]).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // …when the same value is saved to Scient: its own write lands (its copy waits behind the
      // first one's) before the first one ends.
      const before = (yield* service.snapshot).accounts.find(
        (entry) => entry.accountId === shop,
      )!.updatedAt;
      const landed = yield* service.changes.pipe(
        Stream.filter(({ accounts }) =>
          accounts.some((entry) => entry.accountId === shop && entry.updatedAt !== before),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      const scient = yield* saveTo([{ type: "scient" }]).pipe(Effect.forkChild);
      yield* Fiber.join(landed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(keychainOnly);
      yield* Fiber.join(scient);
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(row.secrets.password?.source).toEqual({ type: "scient" });
      expect((yield* service.reveal(shop, "password")).value).toBe("same-A");
    }),
  );

  it.effect("settles a field's Keychain copy though another field was saved since", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let writes = 0;
      const { service } = yield* makeHarness({
        sourceOverrides: {
          writeKeychain: () =>
            writes++ === 0
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "first-A" } },
      })).accountId;
      // One save of a 2FA key (to the Keychain only) and a password, its Keychain write slow…
      const both = yield* service
        .save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: {
            totp: { type: "scient", value: "JBSWY3DPEHPK3PXP", saveTo: [{ type: "keychain" }] },
            password: { type: "scient", value: "second-B" },
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // …while the password alone is saved again.
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "third-C" } },
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(both);
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(row.secrets.totp?.source.type).toBe("keychain");
      expect((yield* service.reveal(shop, "password")).value).toBe("third-C");
    }),
  );

  it.effect("takes a site's word on a new password only over the same write it was made on", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      yield* service.snapshot;
      const { pendingId } = yield* service.pending({
        type: "reserve",
        origin,
        password: "new-B",
        accountId: shop,
      });
      yield* service.pending({
        type: "rotate",
        pendingId: pendingId!,
        origin,
        username: "ada",
        password: "new-B",
        accountId: shop,
      });
      // The person saves the same password again meanwhile: a write of their own.
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "working-A" } },
      });
      yield* service.pending({ type: "settle", pendingId: pendingId!, outcome: "accepted" });
      expect((yield* service.reveal(shop, "password")).value).toBe("working-A");
      expect((yield* service.snapshot).pendingSecrets).toMatchObject([{ conflict: true }]);
    }),
  );

  it.effect("ends a removed password's Undo when the login's password is cleared", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const login = (password: { type: "scient"; value: string } | { type: "clear" }) =>
        service.save({ accountId: shop, name: "Shop", details, secrets: { password } });
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "first-A" } },
      })).accountId;
      yield* login({ type: "scient", value: "second-B" });
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      const { undoId } = yield* service.removePasswordVersion(
        shop,
        row.secrets.password!.history![0]!.version,
      );
      yield* login({ type: "clear" });
      expect((yield* service.restorePasswordVersion(undoId).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
    }),
  );

  it.effect("never deletes, past a removal's hour, a value a record that didn't read named", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const blobs = storage.blobs;
      const name = "accounts-state";
      // What this service wrote, read back: the stored state's own shape.
      type Stored = { accounts: Array<{ values: Record<string, string> }> } & Record<
        string,
        unknown
      >;
      // A run that saves a login and removes it, then stops.
      const ref = yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, vault } = yield* makeHarness({ storage });
          const shop = (yield* service.save(website(syntheticValue()))).accountId;
          const read = () =>
            Effect.map(vault.decrypt(name, blobs.get(name)!), (bytes): Stored =>
              JSON.parse(new TextDecoder().decode(Redacted.value(bytes))),
            );
          const ref = (yield* read()).accounts[0]!.values["password"]!;
          yield* service.remove(shop);
          // A held record naming the value that no build reads.
          const stored = yield* read();
          stored["pending"] = [{ valueRef: ref, kind: "password" }];
          blobs.set(
            name,
            yield* vault.encrypt(
              name,
              Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
            ),
          );
          return ref;
        }),
      );
      yield* (yield* makeHarness({ storage })).service.snapshot;
      yield* TestClock.adjust("2 hours");
      yield* (yield* makeHarness({ storage })).service.snapshot;
      yield* TestClock.adjust("2 hours");
      expect(blobs.has(ref)).toBe(true);
    }),
  );

  it.effect(
    "holds a value a row that didn't read shares with one that did, once it is cleared",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const blobs = storage.blobs;
        const name = "accounts-state";
        // What this service wrote, read back: the stored state's own shape.
        type Stored = { accounts: Array<Record<string, unknown>> } & Record<string, unknown>;
        const details = { kind: "website" as const, sites: ["https://shop.example.com"] };
        // A run that saves a login, then stops; its stored state gains a row no build reads,
        // naming the same value.
        const { shop, ref } = yield* Effect.scoped(
          Effect.gen(function* () {
            const { service, vault } = yield* makeHarness({ storage });
            const shop = (yield* service.save({
              name: "Shop",
              details: { ...details, username: "ada" },
              secrets: { password: { type: "scient", value: "shared-A" } },
            })).accountId;
            const stored: Stored = JSON.parse(
              new TextDecoder().decode(
                Redacted.value(yield* vault.decrypt(name, blobs.get(name)!)),
              ),
            );
            const row = stored.accounts[0]!;
            const values = row["values"];
            const ref =
              typeof values === "object" && values !== null && "password" in values
                ? String(values.password)
                : "";
            stored.accounts.push({
              ...row,
              summary: { accountId: "acc_unreadable", createdAt: 7 },
            });
            blobs.set(
              name,
              yield* vault.encrypt(
                name,
                Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
              ),
            );
            return { shop, ref };
          }),
        );
        // The readable row lets the value go; the row that didn't read still names it.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { service } = yield* makeHarness({ storage });
            yield* service.save({
              accountId: shop,
              name: "Shop",
              details: { ...details, username: "ada" },
              secrets: { password: { type: "clear" } },
            });
          }),
        );
        yield* (yield* makeHarness({ storage })).service.snapshot;
        yield* TestClock.adjust("2 hours");
        expect(blobs.has(ref)).toBe(true);
      }),
  );

  it.effect("keeps a value held for one login held for another after the first is removed", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const blobs = storage.blobs;
      const name = "accounts-state";
      type Stored = {
        passwordHistory?: Array<Record<string, unknown>>;
        unreadable?: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
      const ref = "accounts-value-0a0a0a0a-1111-4222-8333-444455556666";
      // A run saves two logins, A and B, then stops. Its stored state then holds a value for A
      // (a record that didn't read) that a history entry for B, which no build reads, also names.
      const { ada } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, vault } = yield* makeHarness({ storage });
          const login = (username: string) =>
            service.save({
              name: username,
              details: { kind: "website", sites: ["https://shop.example.com"], username },
              secrets: { password: { type: "scient", value: `${username}-1` } },
            });
          const ada = (yield* login("ada")).accountId;
          const grace = (yield* login("grace")).accountId;
          blobs.set(ref, new Uint8Array([1]));
          const stored: Stored = JSON.parse(
            new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
          );
          stored.unreadable = [{ list: "accounts", accountId: ada, refs: [ref] }];
          stored.passwordHistory = [
            ...(stored.passwordHistory ?? []),
            { accountId: grace, versions: [{ ref, identity: "grace", savedAt: 123 }] },
          ];
          blobs.set(
            name,
            yield* vault.encrypt(
              name,
              Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
            ),
          );
          return { ada };
        }),
      );
      // Read again: B's own hold is kept beside A's. Then A is removed, its hour passes.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* makeHarness({ storage });
          yield* service.remove(ada);
          yield* TestClock.adjust("2 hours");
        }),
      );
      yield* (yield* makeHarness({ storage })).service.snapshot;
      yield* TestClock.adjust("2 hours");
      expect(blobs.has(ref)).toBe(true);
    }),
  );

  it.effect("an Undo's hour ending never drops a removal made while its timer waited", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      const login = (username: string) =>
        service.save({
          name: username,
          details: { kind: "website", sites: ["https://shop.example.com"], username },
          secrets: { password: { type: "scient", value: `${username}-A` } },
        });
      const first = yield* login("ada");
      yield* service.remove(first.accountId);
      yield* TestClock.adjust("59 minutes");
      const second = yield* login("grace");
      // The second removal is under way (its list being written) when the first's hour ends.
      const paused = storage.pauseNextWriteTo("accounts-removed");
      const removing = yield* service.remove(second.accountId).pipe(Effect.forkChild);
      yield* Deferred.await(paused.entered);
      yield* TestClock.adjust("2 minutes");
      yield* Deferred.succeed(paused.release, undefined);
      const { removalId } = yield* Fiber.join(removing);
      yield* service.snapshot;
      yield* service.restore(second.accountId, removalId);
      expect(
        (yield* service.snapshot).accounts.some((row) => row.accountId === second.accountId),
      ).toBe(true);
    }),
  );

  it.effect("asks the person about a site's answer an older build pinned without a revision", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const blobs = storage.blobs;
      const origin = "https://shop.example.com";
      const name = "accounts-state";
      type Stored = { pending: Array<Record<string, unknown>> } & Record<string, unknown>;
      const { shop, pendingId } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, vault } = yield* makeHarness({ storage });
          const shop = (yield* service.save({
            name: "Shop",
            details: { kind: "website", sites: [origin], username: "ada" },
            secrets: { password: { type: "scient", value: "working-A" } },
          })).accountId;
          const { pendingId } = yield* service.pending({
            type: "reserve",
            origin,
            password: "new-B",
            accountId: shop,
          });
          yield* service.pending({
            type: "rotate",
            pendingId: pendingId!,
            origin,
            username: "ada",
            password: "new-B",
            accountId: shop,
          });
          // As an older build wrote it: pinned by its password alone.
          const stored: Stored = JSON.parse(
            new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
          );
          stored.pending = stored.pending.map(({ baseRevision: _, ...held }) => held);
          blobs.set(
            name,
            yield* vault.encrypt(
              name,
              Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
            ),
          );
          return { shop, pendingId: pendingId! };
        }),
      );
      const { service } = yield* makeHarness({ storage });
      yield* service.snapshot;
      yield* service.pending({ type: "settle", pendingId, outcome: "accepted" });
      expect((yield* service.reveal(shop, "password")).value).toBe("working-A");
      expect((yield* service.snapshot).pendingSecrets).toMatchObject([{ conflict: true }]);
    }),
  );

  it.effect("a copy settled late never hides a newer save's failure", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let writes = 0;
      const { service } = yield* makeHarness({
        sourceOverrides: {
          writeKeychain: () => {
            const turn = writes++;
            return turn === 1
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : turn === 2
                ? Effect.fail(new AccountsError({ reason: "unavailable", message: "Locked." }))
                : Effect.void;
          },
        },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const saveAs = (secrets: Parameters<typeof service.save>[0]["secrets"]) =>
        service.save({ accountId: shop, name: "Shop", details, secrets });
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: {
          password: {
            type: "scient",
            value: "first-A",
            saveTo: [{ type: "scient" }, { type: "keychain" }],
          },
        },
      })).accountId;
      // A 2FA key's Keychain copy is slow…
      const factor = yield* saveAs({
        totp: {
          type: "scient",
          value: "JBSWY3DPEHPK3PXP",
          saveTo: [{ type: "scient" }, { type: "keychain" }],
        },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // …and a newer password's Keychain copy fails meanwhile.
      yield* saveAs({ password: { type: "scient", value: "second-B" } });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(factor);
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(row.status).toBe("needs-attention");
    }),
  );

  it.effect("a copy of a password cleared since never reports its failure", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let writes = 0;
      const { service } = yield* makeHarness({
        sourceOverrides: {
          writeKeychain: () =>
            writes++ === 0
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.fail(new AccountsError({ reason: "unavailable", message: "Locked." })),
                  ),
                )
              : Effect.void,
        },
      });
      const details = {
        kind: "website" as const,
        sites: ["https://shop.example.com"],
        username: "ada",
      };
      const shop = (yield* service.save({ name: "Shop", details, secrets: {} })).accountId;
      const toBoth = [{ type: "scient" as const }, { type: "keychain" as const }];
      // One save copies a password and a 2FA key to Keychain; the password's copy is slow…
      const both = yield* service
        .save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: {
            password: { type: "scient", value: "first-A", saveTo: toBoth },
            totp: { type: "scient", value: "JBSWY3DPEHPK3PXP", saveTo: toBoth },
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // …the person clears that password, and only then does its copy fail.
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details,
        secrets: { password: { type: "clear" } },
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(both);
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(row.status).toBe("ready");
      expect(row.statusMessage).toBeUndefined();
    }),
  );

  it.effect("Undo never brings back a password the person removed since, nor one twice", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "scient", value: "first-A" } },
      })).accountId;
      const saveAs = (value: string) =>
        service.save({
          accountId: shop,
          name: "Shop",
          details,
          secrets: { password: { type: "scient", value } },
        });
      const versionOf = Effect.map(
        service.snapshot,
        ({ accounts }) =>
          accounts.find((entry) => entry.accountId === shop)!.secrets.password!.history![0]!
            .version,
      );
      // B saved, then A (its Previous) removed: B's Undo would bring A back.
      const update = yield* saveAs("second-B");
      const removal = yield* service.removePasswordVersion(shop, yield* versionOf);
      expect(yield* service.undoPasswordUpdate(update.undoId!)).toEqual({
        restored: 0,
        changed: 1,
      });
      expect((yield* service.reveal(shop, "password")).value).toBe("second-B");
      // A saved again: the removed one is back, under its own ref, and its Undo has nothing to do.
      yield* saveAs("first-A");
      expect(yield* earlierPasswords(service, shop)).toEqual(["second-B"]);
      yield* service.restorePasswordVersion(removal.undoId).pipe(Effect.ignore);
      expect(yield* earlierPasswords(service, shop)).toEqual(["second-B"]);
      // Two removals, each with its own Undo.
      yield* saveAs("third-C");
      yield* service.removePasswordVersion(shop, yield* versionOf);
      yield* service.removePasswordVersion(shop, yield* versionOf);
      const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      expect(row.secrets.password?.removedVersions).toHaveLength(2);
    }),
  );

  it.effect("keeps no Undo for a save that also made the login another one", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        sourceOverrides: { keychain: () => Effect.succeed(Redacted.make("linked-K")) },
      });
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      const shop = (yield* service.save({
        name: "Shop",
        details,
        secrets: { password: { type: "keychain", service: "Shop", account: "ada" } },
      })).accountId;
      // The username changes in the same save as a password of Scient's own.
      const saved = yield* service.save({
        accountId: shop,
        name: "Shop",
        details: { ...details, username: "grace" },
        secrets: { password: { type: "scient", value: "own-B" } },
      });
      expect(saved.undoId).toBeUndefined();
    }),
  );

  it.effect("offers a login's earlier passwords only as saved for it as it is now", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://login.example.com";
      const shop = (yield* service.save({
        name: "Portal",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "tenant-a-A" } },
      })).accountId;
      yield* acceptedOn(service, shop, origin, "ada")("tenant-a-B");
      const listed = (yield* service.snapshot).accounts.find((entry) => entry.accountId === shop)!;
      const older = listed.secrets.password!.history![0]!.version;
      // Moved to another tenant: tenant A's earlier password isn't this login's to offer or take.
      yield* service.save({
        accountId: shop,
        name: listed.name,
        details: { ...listed.details, loginUrl: `${origin}/tenant-b` } as typeof listed.details,
        secrets: {},
      });
      expect(yield* earlierPasswords(service, shop)).toEqual([]);
      const refused = yield* service.usePassword(shop, older).pipe(Effect.flip);
      expect(refused.message).toBe("That password is no longer kept.");
    }),
  );

  it.effect("brings a login's history back with its removal's Undo", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const accepted = acceptedOn(service, shop, origin, "ada");
      yield* accepted("new-B");
      yield* accepted("new-C");
      const { removalId } = yield* service.remove(shop);
      yield* service.restore(shop, removalId!);
      expect(yield* earlierPasswords(service, shop)).toEqual(["new-B", "working-A"]);
    }),
  );

  it.effect("clearing a login's password clears its history; a failed deletion is retried", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      const origin = "https://shop.example.com";
      const login = (
        password: { type: "scient"; value: string } | { type: "clear" },
        accountId?: AccountId,
      ) =>
        service.save({
          ...(accountId ? { accountId } : {}),
          name: "Shop",
          details: { kind: "website", sites: [origin], username: "ada" },
          secrets: { password },
        });
      const shop = (yield* login({ type: "scient", value: "first-A" })).accountId;
      yield* acceptedOn(service, shop, origin, "ada")("new-B");
      const name = "accounts-state";
      const stored = () =>
        Effect.map(
          vault.decrypt(name, blobs.get(name)!),
          (bytes) =>
            JSON.parse(new TextDecoder().decode(Redacted.value(bytes))) as {
              passwordHistory?: Array<{ versions: Array<{ ref: string }> }>;
              unreferenced?: string[];
            },
        );
      const [first, second] = (yield* stored()).passwordHistory![0]!.versions.map(
        (version) => version.ref,
      );
      // Past the hour its Undo could have brought them back in.
      yield* TestClock.adjust("2 hours");
      storage.failRemovalOf(first);
      yield* login({ type: "clear" }, shop);
      expect((yield* stored()).passwordHistory ?? []).toEqual([]);
      // Only the sweep deletes: both were journaled in the write that let them go.
      expect(blobs.has(second!)).toBe(true);
      yield* TestClock.adjust("1 minute");
      expect(blobs.has(second!)).toBe(false);
      expect(blobs.has(first!)).toBe(true);
      // The one whose deletion failed waits, and goes on the next start's sweep.
      expect((yield* stored()).unreferenced).toEqual([first]);
      storage.failRemovalOf(undefined);
      yield* (yield* makeHarness({ storage })).service.snapshot;
      yield* TestClock.adjust("1 minute");
      expect(blobs.has(first!)).toBe(false);
      expect((yield* stored()).unreferenced ?? []).toEqual([]);
    }),
  );

  it.effect("a history whose one version won't read keeps the others", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const accepted = acceptedOn(service, shop, origin, "ada");
      yield* accepted("new-B");
      yield* accepted("new-C");
      const name = "accounts-state";
      const stored = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      ) as { passwordHistory: Array<{ versions: Array<Record<string, unknown>> }> };
      stored.passwordHistory[0]!.versions[1] = { ref: 7 };
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      const { service: reopened } = yield* makeHarness({ storage });
      expect(yield* earlierPasswords(reopened, shop)).toEqual(["working-A"]);
    }),
  );

  it.effect("Undo walks a chain of new passwords back, every copy to a value still kept", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://login.example.com";
      const row = (profileId?: string) =>
        service.save({
          name: "Portal",
          details: {
            kind: "website",
            sites: [origin],
            username: "ada",
            ...(profileId ? { profileId: BrowserProfileId.make(profileId) } : {}),
          },
          secrets: { password: { type: "scient", value: "working-A" } },
        });
      const work = (yield* row()).accountId;
      const copy = (yield* row("work")).accountId;
      const accepted = acceptedOn(service, work, origin, "ada");
      yield* accepted("new-B");
      yield* accepted("new-C");
      const [toA, toB] = (yield* service.snapshot).passwordUpdates ?? [];
      expect(yield* service.undoPasswordUpdate(toB!.undoId)).toEqual({ restored: 2, changed: 0 });
      expect(yield* service.undoPasswordUpdate(toA!.undoId)).toEqual({ restored: 2, changed: 0 });
      for (const accountId of [work, copy]) {
        const values = yield* service.resolveSecrets(accountId, ["password"]);
        expect(secretEquals(values.password, "working-A")).toBe(true);
      }
    }),
  );

  it.effect(
    "each row settles on its own; another login's result or the person's edit settles",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const origin = "https://login.example.com";
        const work = (yield* service.save({
          name: "Portal",
          details: { kind: "website", sites: [origin], username: "ada" },
          secrets: { password: { type: "scient", value: "working-A" } },
        })).accountId;
        // The same login in another profile: a copy, which the new password reaches too.
        const copy = (yield* service.save({
          name: "Portal",
          details: {
            kind: "website",
            sites: [origin],
            username: "ada",
            profileId: BrowserProfileId.make("work"),
          },
          secrets: { password: { type: "scient", value: "working-A" } },
        })).accountId;
        const password = (accountId: AccountId) =>
          Effect.map(service.resolveSecrets(accountId, ["password"]), (values) => values.password);
        yield* acceptedOn(service, work, origin, "ada")("new-B");
        expect(secretEquals(yield* password(copy), "new-B")).toBe(true);
        // The copy refused on its own: only it goes back, by its own record.
        const onCopy = yield* service.fillValues(copy, origin);
        yield* personSaw(service, copy)("password-rejected", onCopy.attempt);
        expect(secretEquals(yield* password(copy), "working-A")).toBe(true);
        expect(secretEquals(yield* password(work), "new-B")).toBe(true);
        // Filled, then moved to another tenant: the result was for the login as it was, so it
        // moves nothing, and the passwords kept for the login it was are never put on this one.
        const filled = (yield* service.fillValues(work, origin)).attempt;
        const row = (yield* service.snapshot).accounts.find((entry) => entry.accountId === work)!;
        yield* service.save({
          accountId: work,
          name: row.name,
          details: { ...row.details, loginUrl: `${origin}/tenant-b` } as typeof row.details,
          secrets: {},
        });
        yield* personSaw(service, work)("password-rejected", filled);
        expect(secretEquals(yield* password(work), "new-B")).toBe(true);
        // Nor marks the login as it is now refused.
        const edited = (yield* service.snapshot).accounts.find(
          (entry) => entry.accountId === work,
        )!;
        expect(edited.secrets.password?.refusedAt).toBeUndefined();
        expect(edited.signIn?.state).not.toBe("password-rejected");
        yield* personSaw(service, work)(
          "password-rejected",
          (yield* service.fillValues(work, origin)).attempt,
        );
        expect(secretEquals(yield* password(work), "new-B")).toBe(true);
        // The person typing the copy's password adds it; what it held before stays to try.
        const copyRow = (yield* service.snapshot).accounts.find(
          (entry) => entry.accountId === copy,
        )!;
        yield* service.save({
          accountId: copy,
          name: copyRow.name,
          details: copyRow.details,
          secrets: { password: { type: "scient", value: "typed-Z" } },
        });
        expect(yield* earlierPasswords(service, copy)).toEqual(["new-B", "working-A"]);
      }),
  );

  it.effect("opens a vault with round 5's held passwords, each the person's to answer", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const named = (yield* service.pending({
        type: "reserve",
        origin,
        password: "held-B",
        accountId: shop,
      })).pendingId!;
      const toolbar = (yield* service.pending({ type: "reserve", origin, password: "held-C" }))
        .pendingId!;
      // As round 5 wrote them: a username pin, and the site's logins by username only. One more
      // record that won't read at all.
      const name = "accounts-state";
      const stored = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      ) as { pending: Array<Record<string, unknown>> };
      stored.pending = [
        ...stored.pending.map(({ pinnedIdentity: _pin, copyRefs: _copies, ...record }) =>
          record["pendingId"] === named
            ? { ...record, pinnedUser: "ada" }
            : {
                ...record,
                targets: (record["targets"] as Array<Record<string, unknown>>).map((target) => ({
                  accountId: target["accountId"],
                  baseRef: target["baseRef"],
                  user: "ada",
                })),
              },
        ),
        { pendingId: "unreadable", kind: "password" },
      ];
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      const { service: upgraded } = yield* makeHarness({ storage });
      for (const [pendingId, made] of [
        [named, "held-B"],
        [toolbar, "held-C"],
      ] as const) {
        yield* upgraded.pending({
          type: "rotate",
          pendingId,
          origin,
          username: "ada",
          password: made,
          accountId: shop,
        });
        yield* upgraded.pending({ type: "settle", pendingId, outcome: "accepted" });
      }
      // Neither saved on the site's answer; both kept for the person, who says one took.
      expect(
        new Map(
          (yield* upgraded.snapshot).pendingSecrets?.map((entry) => [
            entry.pendingId,
            entry.unclear,
          ]),
        ),
      ).toEqual(
        new Map([
          [named, true],
          [toolbar, true],
        ]),
      );
      yield* upgraded.pending({ type: "save", pendingId: named });
      const values = yield* upgraded.resolveSecrets(shop, ["password"]);
      expect(secretEquals(values.password, "held-B")).toBe(true);
    }),
  );

  it.effect("holds the password an older build's held targets named, until its login goes", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const blobs = storage.blobs;
      const name = "accounts-state";
      const origin = "https://shop.example.com";
      const details = { kind: "website" as const, sites: [origin], username: "ada" };
      // Two held passwords: one for the login (pinned to its password), one from the toolbar,
      // its site's logins as round 5 wrote them (a form the fold discards, targets and all).
      const { shop, working, named } = yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, vault } = yield* makeHarness({ storage });
          const shop = (yield* service.save({
            name: "Shop",
            details,
            secrets: { password: { type: "scient", value: "working-A" } },
          })).accountId;
          const named = (yield* service.pending({
            type: "reserve",
            origin,
            password: "held-B",
            accountId: shop,
          })).pendingId!;
          yield* service.pending({ type: "reserve", origin, password: "held-C" });
          const stored = JSON.parse(
            new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
          ) as { pending: Array<Record<string, unknown>> };
          const working = String(
            stored.pending.find((record) => record["pendingId"] === named)!["baseRef"],
          );
          stored.pending = stored.pending.map((record) =>
            record["pendingId"] === named
              ? record
              : {
                  ...record,
                  targets: (record["targets"] as Array<Record<string, unknown>>).map((target) => ({
                    accountId: target["accountId"],
                    baseRef: target["baseRef"],
                    user: "ada",
                  })),
                },
          );
          blobs.set(
            name,
            yield* vault.encrypt(
              name,
              Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
            ),
          );
          return { shop, working, named };
        }),
      );
      // The other held one, naming that password too, is discarded; the login's password cleared.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* makeHarness({ storage });
          yield* service.snapshot;
          yield* service.pending({ type: "discard", pendingId: named });
          yield* service.save({
            accountId: shop,
            name: "Shop",
            details,
            secrets: { password: { type: "clear" } },
          });
        }),
      );
      yield* Effect.scoped(
        makeHarness({ storage }).pipe(
          Effect.andThen(({ service }) => service.snapshot),
          Effect.andThen(TestClock.adjust("2 hours")),
        ),
      );
      expect(blobs.has(working)).toBe(true);
      // The target's own login is removed and its Undo's hour ends: the hold goes with it.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* makeHarness({ storage });
          yield* service.remove(shop);
          yield* TestClock.adjust("61 minutes");
        }),
      );
      yield* (yield* makeHarness({ storage })).service.snapshot;
      yield* TestClock.adjust("2 minutes");
      expect(blobs.has(working)).toBe(false);
    }),
  );

  it.effect("holds a value a removal names in a field this build doesn't know", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const blobs = storage.blobs;
      const ref = "accounts-value-0b0b0b0b-1111-4222-8333-444455556666";
      // A later build's removal names a value in a field this one doesn't know; the value is
      // otherwise journaled (nothing else this build reads names it).
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { service, vault } = yield* makeHarness({ storage });
          const bob = (yield* service.save({
            name: "Shop",
            details: { kind: "website", sites: ["https://shop.example.com"], username: "bob" },
            secrets: { password: { type: "scient", value: "bob-1" } },
          })).accountId;
          yield* service.remove(bob);
          blobs.set(ref, new Uint8Array([1]));
          const rewrite = <T>(name: string, change: (stored: T) => void) =>
            Effect.gen(function* () {
              const stored: T = JSON.parse(
                new TextDecoder().decode(
                  Redacted.value(yield* vault.decrypt(name, blobs.get(name)!)),
                ),
              );
              change(stored);
              blobs.set(
                name,
                yield* vault.encrypt(
                  name,
                  Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
                ),
              );
            });
          yield* rewrite("accounts-removed", (removed: Array<Record<string, unknown>>) => {
            removed[0]!["laterField"] = { ref };
          });
          yield* rewrite("accounts-state", (stored: { unreferenced?: string[] }) => {
            stored.unreferenced = [...(stored.unreferenced ?? []), ref];
          });
        }),
      );
      // Two runs, each with a minute's sweep: the value stays.
      for (let run = 0; run < 2; run++)
        yield* Effect.scoped(
          makeHarness({ storage }).pipe(
            Effect.andThen(({ service }) => service.snapshot),
            Effect.andThen(TestClock.adjust("2 minutes")),
          ),
        );
      expect(blobs.has(ref)).toBe(true);
    }),
  );

  it.effect("opens round 6's kept password into the login's history; a bad record goes alone", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const accepted = acceptedOn(service, shop, origin, "ada");
      yield* accepted("never-took-B");
      yield* accepted("never-took-C");
      // As round 6 wrote it: no history, only the last proven password's pointer (A), beside the
      // row's current (C) and Previous (B). Next to it, records no build can read.
      const name = "accounts-state";
      const stored = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      ) as {
        passwordHistory?: Array<{ versions: Array<{ ref: string }> }>;
        [key: string]: unknown;
      };
      const confirmedRef = stored.passwordHistory![0]!.versions[0]!.ref;
      delete stored.passwordHistory;
      stored["passwordSets"] = [{ accountId: "unreadable", refs: "none" }];
      stored["unconfirmed"] = [
        { accountId: shop, confirmedRef, since: "2026-11-01T00:00:00.000Z" },
        { accountId: 7 },
      ];
      stored["pending"] = [{ pendingId: "unreadable", kind: "password" }];
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      const { service: upgraded } = yield* makeHarness({ storage });
      // Each refusal tries the next, back to A: none of them was lost.
      const typed: string[] = [];
      for (let turn = 0; turn < 3; turn++) {
        const values = yield* upgraded.fillValues(shop, origin);
        typed.push(values.password!);
        yield* personSaw(upgraded, shop)("password-rejected", values.attempt);
      }
      expect(typed).toEqual(["never-took-C", "never-took-B", "working-A"]);
    }),
  );

  it.effect(
    "submits by itself only a first sign-in, none for the hour after any failure on the site",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service } = yield* makeHarness({ storage });
        const login = (origin: string) =>
          Effect.gen(function* () {
            const accountId = (yield* service.save({
              name: "Site",
              details: { kind: "website", sites: [origin], username: "ada" },
              secrets: { password: { type: "scient", value: "working-A" } },
            })).accountId;
            // It worked once (Scient typed it in an agent's sign-in).
            yield* service.recordUse(
              {
                target: { type: "account", accountId },
                action: "sign-in",
                signInOutcome: "signed-in",
                outcome: "ok",
                savedPasswordUsed: true,
              },
              undefined,
              true,
            );
            return accountId;
          });
        const shopOrigin = "https://shop.example.com";
        const shop = yield* login(shopOrigin);
        yield* acceptedOn(service, shop, shopOrigin, "ada")("never-took-B");
        const fill = (on: Service, accountId: AccountId, origin: string) =>
          on.fillValues(accountId, origin, undefined, undefined, true);
        const first = yield* fill(service, shop, shopOrigin);
        expect(first.submit).toBe(true);
        // Another form at once: that submit's result isn't in, so nothing more by itself.
        expect((yield* fill(service, shop, shopOrigin)).submit).toBeUndefined();
        // Refused: the returning form gets the next password, for the person to submit.
        yield* personSaw(service, shop)("password-rejected", first.attempt);
        const next = yield* fill(service, shop, shopOrigin);
        expect(next.password).toBe("working-A");
        expect(next.submit).toBeUndefined();
        // A late "signed in" for that submit (a replay) doesn't reopen it.
        yield* personSaw(service, shop)("signed-in", first.attempt);
        expect((yield* fill(service, shop, shopOrigin)).submit).toBeUndefined();
        // Another login on the same registrable domain shares the hour; another domain doesn't.
        const mailOrigin = "https://mail.example.com";
        const mail = yield* login(mailOrigin);
        expect((yield* fill(service, mail, mailOrigin)).submit).toBeUndefined();
        const newsOrigin = "https://news.example.org";
        expect((yield* fill(service, yield* login(newsOrigin), newsOrigin)).submit).toBe(true);
        // Kept across a restart, and over an hour after the failure was seen.
        const { service: restarted } = yield* makeHarness({ storage });
        expect((yield* fill(restarted, mail, mailOrigin)).submit).toBeUndefined();
        yield* TestClock.adjust("61 minutes");
        expect((yield* fill(restarted, mail, mailOrigin)).submit).toBe(true);
      }),
  );

  it.effect(
    "keeps password Undos across a restart; the first start past their hour ends them",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service, vault, blobs } = yield* makeHarness({ storage });
        const origin = "https://shop.example.com";
        const shop = (yield* service.save({
          name: "Shop",
          details: { kind: "website", sites: [origin], username: "ada" },
          secrets: { password: { type: "scient", value: "working-A" } },
        })).accountId;
        yield* acceptedOn(service, shop, origin, "ada")("took-B");
        const { service: soon } = yield* makeHarness({ storage });
        expect((yield* soon.snapshot).passwordUpdates).toHaveLength(1);
        yield* TestClock.adjust("2 hours");
        const { service: later } = yield* makeHarness({ storage });
        expect((yield* later.snapshot).passwordUpdates).toBeUndefined();
        const name = "accounts-state";
        const stored = JSON.parse(
          new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
        ) as { passwordUndos?: unknown[] };
        expect(stored.passwordUndos ?? []).toEqual([]);
      }),
  );

  it.effect(
    "a copy an older build pinned by its password alone takes a new one only by the person",
    () =>
      Effect.gen(function* () {
        const storage = memoryStore();
        const { service, vault, blobs } = yield* makeHarness({ storage });
        const origin = "https://login.example.com";
        const row = (profileId?: string) =>
          service.save({
            name: "Portal",
            details: {
              kind: "website",
              sites: [origin],
              username: "ada",
              ...(profileId ? { profileId: BrowserProfileId.make(profileId) } : {}),
            },
            secrets: { password: { type: "scient", value: "working-A" } },
          });
        const work = (yield* row()).accountId;
        const copy = (yield* row("work")).accountId;
        const sentAsBefore = (on: Service, made: string) =>
          Effect.gen(function* () {
            const { pendingId } = yield* on.pending({
              type: "reserve",
              origin,
              password: made,
              accountId: work,
            });
            yield* on.pending({
              type: "rotate",
              pendingId: pendingId!,
              origin,
              username: "ada",
              password: made,
              accountId: work,
            });
            // As round 8 wrote it: the copy pinned by its password, not by which login it was.
            const name = "accounts-state";
            const stored = JSON.parse(
              new TextDecoder().decode(
                Redacted.value(yield* vault.decrypt(name, blobs.get(name)!)),
              ),
            ) as { pending: Array<{ copyRefs: Array<Record<string, unknown>> }> };
            for (const held of stored.pending)
              held.copyRefs = held.copyRefs.map(({ identity: _, ...pinned }) => pinned);
            blobs.set(
              name,
              yield* vault.encrypt(
                name,
                Redacted.make(new TextEncoder().encode(JSON.stringify(stored))),
              ),
            );
            const upgraded = (yield* makeHarness({ storage })).service;
            yield* upgraded.snapshot;
            return { pendingId: pendingId!, upgraded };
          });
        const password = (on: Service, accountId: AccountId) =>
          Effect.map(on.resolveSecrets(accountId, ["password"]), (values) => values.password);
        const bySite = yield* sentAsBefore(service, "new-B");
        yield* bySite.upgraded.pending({
          type: "settle",
          pendingId: bySite.pendingId,
          outcome: "accepted",
        });
        expect(secretEquals(yield* password(bySite.upgraded, work), "new-B")).toBe(true);
        expect(secretEquals(yield* password(bySite.upgraded, copy), "working-A")).toBe(true);
        const byPerson = yield* sentAsBefore(bySite.upgraded, "new-C");
        yield* byPerson.upgraded.pending({ type: "save", pendingId: byPerson.pendingId });
        expect(secretEquals(yield* password(byPerson.upgraded, copy), "new-C")).toBe(true);
      }),
  );

  it.effect("an answer saves only onto the login and copies as they were at the fill", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://login.example.com";
      const row = (username: string, loginUrl: string, password: string) =>
        service.save({
          name: "Portal",
          details: { kind: "website", sites: [origin], username, loginUrl },
          secrets: { password: { type: "scient", value: password } },
        });
      const tenantA = `${origin}/tenant-a`;
      const work = (yield* row("ada", tenantA, "working-A")).accountId;
      // Another profile's row of another login (bob's) at the fill.
      const other = (yield* service.save({
        name: "Portal",
        details: {
          kind: "website",
          sites: [origin],
          username: "bob",
          loginUrl: tenantA,
          profileId: BrowserProfileId.make("work"),
        },
        secrets: { password: { type: "scient", value: "bob-own" } },
      })).accountId;
      const password = (accountId: AccountId) =>
        Effect.map(service.resolveSecrets(accountId, ["password"]), (values) => values.password);
      const reserveAndSend = (made: string) =>
        Effect.gen(function* () {
          const { pendingId } = yield* service.pending({
            type: "reserve",
            origin,
            password: made,
            accountId: work,
          });
          yield* service.pending({
            type: "rotate",
            pendingId: pendingId!,
            origin,
            username: "ada",
            password: made,
            accountId: work,
          });
          return pendingId!;
        });
      // After the fill, that row is edited into a copy of ada's login, with its own password:
      // the answer doesn't reach it.
      const first = yield* reserveAndSend("new-B");
      const otherRow = (yield* service.snapshot).accounts.find(
        (entry) => entry.accountId === other,
      )!;
      yield* service.save({
        accountId: other,
        name: otherRow.name,
        details: { ...otherRow.details, username: "ada" } as typeof otherRow.details,
        secrets: {},
      });
      yield* service.pending({ type: "settle", pendingId: first, outcome: "accepted" });
      expect(secretEquals(yield* password(work), "new-B")).toBe(true);
      expect(secretEquals(yield* password(other), "bob-own")).toBe(true);
      // The login is moved to another tenant (same site and username, same password): the
      // answer can't land on what is now another login.
      const second = yield* reserveAndSend("new-D");
      const workRow = (yield* service.snapshot).accounts.find((entry) => entry.accountId === work)!;
      yield* service.save({
        accountId: work,
        name: workRow.name,
        details: { ...workRow.details, loginUrl: `${origin}/tenant-b` } as typeof workRow.details,
        secrets: {},
      });
      expect(
        yield* service.pending({ type: "settle", pendingId: second, outcome: "accepted" }),
      ).toMatchObject({ conflict: true });
      expect(secretEquals(yield* password(work), "new-B")).toBe(true);
    }),
  );

  it.effect("holds a new password before it is filled, and refuses one when too many wait", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const reserve = (index: number) =>
        service.pending({ type: "reserve", origin, password: `made-${index}` });
      for (let index = 0; index < 200; index++) yield* reserve(index);
      const full = yield* reserve(200).pipe(Effect.flip);
      expect(full.message).toBe("Too many new passwords wait. Answer some first.");
      expect((yield* service.snapshot).pendingSecrets).toBeUndefined();
    }),
  );

  it.effect("keeps the factor a full list would evict when the list can't be written", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      const origin = "https://lab.example.org";
      const first = yield* service.holdPending({
        kind: "recovery",
        value: Redacted.make("1111-2222\n"),
        origin,
      });
      for (let index = 0; index < 199; index++)
        yield* service.pending({ type: "reserve", origin, password: `made-${index}` });
      storage.failWritesTo("accounts-state");
      yield* service
        .holdPending({ kind: "recovery", value: Redacted.make("3333-4444\n"), origin })
        .pipe(Effect.flip);
      storage.failWritesTo(undefined);
      // The factor the hold would have evicted is still whole: it saves as a new login.
      const made = (yield* service.pending({ type: "save", pendingId: first })).accountId!;
      expect(
        (yield* service.snapshot).accounts.find((row) => row.accountId === made)?.secrets[
          "recovery"
        ]?.left,
      ).toBe(1);
    }),
  );

  it.effect("never brings back a code used on another login of the site", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://lab.example.org";
      const page = "1111-aaaa\n2222-bbbb\n3333-cccc\n";
      const login = (username: string) =>
        service.save({
          name: "Lab",
          details: { kind: "website", sites: [origin], username },
          secrets: {},
        });
      const ada = (yield* login("ada")).accountId;
      const team = (yield* login("team")).accountId;
      yield* service.keepFound([{ field: "recovery", value: Redacted.make(page), accountId: ada }]);
      yield* service.takeBackupCode(ada);
      // The same list, saved to the site's other login: the code used on ada's stays used.
      const pendingId = yield* service.holdPending({
        kind: "recovery",
        value: Redacted.make(page),
        origin,
      });
      const seen = (yield* service.snapshot).accounts.find((row) => row.accountId === team)!;
      yield* service.pending({
        type: "save",
        pendingId,
        accountId: team,
        updatedAt: seen.updatedAt,
      });
      expect(
        (yield* service.snapshot).accounts.find((row) => row.accountId === team)?.secrets[
          "recovery"
        ]?.left,
      ).toBe(2);
    }),
  );

  it.effect("an answer saves onto the login it was made for only while it is the same login", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://shop.example.com";
      const shop = (yield* service.save({
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: { password: { type: "scient", value: "working-A" } },
      })).accountId;
      const { pendingId } = yield* service.pending({
        type: "rotate",
        origin,
        username: "ada",
        password: "new-B",
        accountId: shop,
      });
      // The row now names another account, its password untouched.
      yield* service.save({
        accountId: shop,
        name: "Shop",
        details: { kind: "website", sites: [origin], username: "bob" },
        secrets: {},
      });
      expect(
        yield* service.pending({ type: "settle", pendingId: pendingId!, outcome: "accepted" }),
      ).toMatchObject({ conflict: true });
      // "Use this one" can't put it on what is now bob's login, even as the person sees it.
      const seen = (yield* service.snapshot).accounts.find((row) => row.accountId === shop)!;
      const refused = yield* service
        .pending({ type: "save", pendingId: pendingId!, replace: true, updatedAt: seen.updatedAt })
        .pipe(Effect.flip);
      expect(refused.message).toBe("That login changed since. Look at it again.");
      const values = yield* service.resolveSecrets(shop, ["password"]);
      expect(secretEquals(values.password, "working-A")).toBe(true);
    }),
  );

  it.effect("saves a factor only to the login as the person saw it, still on the page's site", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://lab.example.org";
      const saved = yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: {},
      });
      const lab = saved.accountId;
      const seen = (yield* service.snapshot).accounts.find((row) => row.accountId === lab)!;
      const pendingId = yield* service.holdPending({
        kind: "totp",
        value: Redacted.make("otpauth://totp/Lab:ada?secret=JBSWY3DPEHPK3PXP"),
        origin,
        label: "ada",
      });
      // The login moved to another site after the person saw it: refused, still pending.
      yield* service.save({
        accountId: lab,
        name: "Lab",
        details: { kind: "website", sites: ["https://other.example.org"], username: "ada" },
        secrets: {},
      });
      const stale = yield* service
        .pending({ type: "save", pendingId, accountId: lab, updatedAt: seen.updatedAt })
        .pipe(Effect.flip);
      expect(stale.message).toBe("That login changed. Choose again.");
      const now = (yield* service.snapshot).accounts.find((row) => row.accountId === lab)!;
      const moved = yield* service
        .pending({ type: "save", pendingId, accountId: lab, updatedAt: now.updatedAt })
        .pipe(Effect.flip);
      expect(moved.message).toBe("That login changed. Choose again.");
      // Without the version the person saw, nothing is saved either.
      const unseen = yield* service
        .pending({ type: "save", pendingId, accountId: lab })
        .pipe(Effect.flip);
      expect(unseen.reason).toBe("invalid-input");
      expect((yield* service.snapshot).pendingSecrets).toMatchObject([{ pendingId }]);
      expect(
        (yield* service.snapshot).accounts.find((row) => row.accountId === lab)?.secrets["totp"],
      ).toBeUndefined();
    }),
  );

  it.effect(
    "shows an interrupted rotation after five minutes, and forgets factors after a week",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const origin = "https://shop.example.com";
        const { pendingId } = yield* service.pending({
          type: "rotate",
          origin,
          username: "ada",
          password: "new-B",
          login: {
            name: "Shop",
            details: { kind: "website", sites: [origin], username: "ada" },
          },
        });
        const factor = yield* service.holdPending({
          kind: "recovery",
          value: Redacted.make("1111-2222\n"),
          origin,
        });
        const shown = Effect.map(service.snapshot, ({ pendingSecrets }) =>
          (pendingSecrets ?? []).map((held) => held.pendingId),
        );
        // Its client never answered: hidden while it may, the person's from then on.
        expect(yield* shown).toEqual([factor]);
        yield* TestClock.adjust("6 minutes");
        expect(yield* shown).toEqual([pendingId, factor]);
        yield* TestClock.adjust("7 days");
        expect(yield* shown).toEqual([pendingId]);
      }),
  );

  it.effect("Undo gives a linked password back its link", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const sites = ["https://lab.example.org"];
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites, username: "ada" },
        secrets: { password: { type: "keychain", service: "synthetic", account: "ada" } },
      })).accountId;
      const saved = yield* service.save({
        accountId: lab,
        name: "Lab",
        details: { kind: "website", sites, username: "ada" },
        secrets: { password: { type: "scient", value: "new-N" } },
      });
      yield* service.undoPasswordUpdate(saved.undoId!);
      expect(
        (yield* service.snapshot).accounts.find((row) => row.accountId === lab)?.secrets["password"]
          ?.source,
      ).toMatchObject({ type: "keychain", service: "synthetic", account: "ada" });
    }),
  );

  it.effect("a new login for a site never gets backup codes used on its other logins", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const origin = "https://lab.example.org";
      const page = "1111-aaaa\n2222-bbbb\n3333-cccc\n";
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: [origin], username: "ada" },
        secrets: {},
      })).accountId;
      yield* service.keepFound([{ field: "recovery", value: Redacted.make(page), accountId: lab }]);
      yield* service.takeBackupCode(lab);
      // The same list shown again, saved as a new login: the used code stays used.
      const pendingId = yield* service.holdPending({
        kind: "recovery",
        value: Redacted.make(page),
        origin,
      });
      const made = (yield* service.pending({ type: "save", pendingId })).accountId!;
      expect(
        (yield* service.snapshot).accounts.find((row) => row.accountId === made)?.secrets[
          "recovery"
        ]?.left,
      ).toBe(2);
    }),
  );

  it.effect("an import never replaces a key saved meanwhile", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const key = "otpauth://totp/Lab:ada?secret=AAAAAAAAAAAAAAAA";
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: ["https://lab.example.org"], username: "ada" },
        secrets: { totp: { type: "scient", value: key } },
      })).accountId;
      const kept = yield* service.keepFound([
        {
          field: "totp",
          value: Redacted.make("otpauth://totp/Lab:ada?secret=JBSWY3DPEHPK3PXP"),
          accountId: lab,
          onlyIfEmpty: true,
        },
      ]);
      expect(kept).toEqual([]);
      const values = yield* service.resolveSecrets(lab, ["totp"]);
      expect(secretEquals(values.totp, key)).toBe(true);
    }),
  );

  it.effect("reads round 1's backup codes, one per line, as one code per line", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: ["example.com"], username: "ada" },
        secrets: { recovery: { type: "scient", value: "1111 aaaa\n2222 bbbb\n" } },
      })).accountId;
      const code = yield* service.takeBackupCode(lab);
      expect(code && Redacted.value(code)).toBe("1111 aaaa");
    }),
  );

  it.effect("keeps round 1's used backup codes on their logins after an upgrade", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      // As round 1 left it: 1111 given out (gone from the list, its digest in one shared list).
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: ["example.com"], username: "ada" },
        secrets: { recovery: { type: "scient", value: "2222-bbbb\n" } },
      })).accountId;
      const name = "accounts-state";
      const stored = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      ) as { usedBackupCodes?: unknown };
      stored.usedBackupCodes = [{ accountId: lab, digest: usedCodeDigest(lab, "1111-aaaa") }];
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      // Upgraded, the site's list captured again: the used code stays used.
      const restarted = yield* makeHarness({ storage });
      yield* restarted.service.keepFound([
        { field: "recovery", value: Redacted.make("1111-aaaa\n2222-bbbb\n"), accountId: lab },
      ]);
      expect(
        (yield* restarted.service.snapshot).accounts.find((row) => row.accountId === lab)?.secrets[
          "recovery"
        ]?.left,
      ).toBe(1);
    }),
  );

  it.effect("one Undo covers every copy a new password reached, copies made by that save too", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const sites = ["https://lab.example.org"];
      const work = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites, username: "ada" },
        secrets: { password: { type: "scient", value: "working-P" } },
      })).accountId;
      const keyOnly = yield* service.save({
        name: "lab.example.org",
        details: { kind: "website", sites },
        secrets: { totp: { type: "scient", value: "otpauth://totp/Lab?secret=JBSWY3DPEHPK3PXP" } },
      });
      // Naming ada makes the key-only row a copy of Lab: the new password reaches Lab too.
      const saved = yield* service.save({
        accountId: keyOnly.accountId,
        name: "lab.example.org",
        details: { kind: "website", sites, username: "ada" },
        secrets: { password: { type: "scient", value: "new-N" } },
      });
      const password = (accountId: AccountId) =>
        Effect.map(service.resolveSecrets(accountId, ["password"]), (values) => values.password);
      expect(secretEquals(yield* password(work), "new-N")).toBe(true);
      yield* service.undoPasswordUpdate(saved.undoId!);
      expect(secretEquals(yield* password(work), "working-P")).toBe(true);
      // The key-only row became another login (ada) in that save: its Undo never crosses that.
      expect(secretEquals(yield* password(keyOnly.accountId), "new-N")).toBe(true);
    }),
  );

  it.effect("reads backup codes saved before lines as they were: split at any space", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: ["example.com"], username: "ada" },
        secrets: { recovery: { type: "scient", value: "aaaa bbbb\ncccc dddd" } },
      })).accountId;
      const left = Effect.map(
        service.snapshot,
        ({ accounts }) => accounts.find((row) => row.accountId === lab)?.secrets["recovery"]?.left,
      );
      expect(yield* left).toBe(4);
      const take = Effect.map(service.takeBackupCode(lab), (code) => code && Redacted.value(code));
      expect(yield* take).toBe("aaaa");
      expect(yield* left).toBe(3);
    }),
  );

  it.effect("gives out each backup code once; capturing the page again never restores one", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const lab = (yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: ["example.com"], username: "ada" },
        secrets: {},
      })).accountId;
      // As a page lists them: one per line, a code with a space in it still one code.
      const page = "1111 aaaa\n2222 bbbb\n3333 cccc\n";
      yield* service.keepFound([{ field: "recovery", value: Redacted.make(page), accountId: lab }]);
      const left = Effect.map(
        service.snapshot,
        ({ accounts }) => accounts.find((row) => row.accountId === lab)?.secrets["recovery"]?.left,
      );
      expect(yield* left).toBe(3);
      const take = Effect.map(service.takeBackupCode(lab), (code) => code && Redacted.value(code));
      expect(yield* take).toBe("1111 aaaa");
      expect(yield* left).toBe(2);
      // The site still shows its list: recaptured, the used code stays used.
      yield* service.keepFound([{ field: "recovery", value: Redacted.make(page), accountId: lab }]);
      expect(yield* left).toBe(2);
      expect(yield* take).toBe("2222 bbbb");
      expect(yield* take).toBe("3333 cccc");
      expect(yield* left).toBeUndefined();
      expect(yield* take).toBeUndefined();
      // Nothing new on a page of used codes: it isn't saved again.
      yield* service.keepFound([{ field: "recovery", value: Redacted.make(page), accountId: lab }]);
      expect(yield* left).toBeUndefined();
    }),
  );

  it.effect("keeps a found value only on the row as it was chosen", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const lab = yield* service.save({
        name: "Lab",
        details: { kind: "website", sites: ["example.com"], username: "ada" },
        secrets: {},
      });
      const key = "otpauth://totp/Lab:ada?secret=JBSWY3DPEHPK3PXP";
      const kept = yield* service.keepFound([
        {
          field: "totp",
          value: Redacted.make(key),
          accountId: lab.accountId,
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ]);
      expect(kept).toEqual([]);
      expect(
        (yield* service.snapshot).accounts.find((row) => row.accountId === lab.accountId)?.secrets[
          "totp"
        ],
      ).toBeUndefined();
    }),
  );

  it.effect("shows a saved password's health on its row; a leak check sends only the prefix", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      let garbled = false;
      const { service } = yield* makeHarness({
        sourceOverrides: {
          pwnedRange: (prefix) =>
            Effect.suspend(() => {
              asked.push(prefix);
              // The first prefix of each turn fails: the others are still asked.
              if (prefix === "A8A19")
                return Effect.fail(
                  new AccountsError({ reason: "unavailable", message: "Leak check unavailable." }),
                );
              // "letmein-2026" is B5301…: listed, beside a padding line that counts nothing.
              return Effect.succeed(
                garbled
                  ? "<html>Sign in to the network</html>"
                  : "4C20A0627E0614E457575F8970FF7AF9572:12\r\n4C20A0627E0614E457575F8970FF7AF9573:0",
              );
            }),
        },
      });
      const save = (site: string, value: string) =>
        service.save({
          name: site,
          details: { kind: "website", sites: [site], username: "ada" },
          secrets: { password: { type: "scient", value } },
        });
      const shared = "u3$Wq9!rT6yP2#mK7vL1";
      const shop = (yield* save("shop.test", shared)).accountId;
      const bank = (yield* save("bank.test", shared)).accountId;
      const old = (yield* save("old.test", "letmein-2026")).accountId;
      const findings = Effect.map(service.snapshot, (snapshot) => snapshot.passwordHealth);
      expect(yield* findings).toEqual([
        { accountId: shop, finding: "reused" },
        { accountId: bank, finding: "reused" },
        { accountId: old, finding: "weak" },
      ]);
      // A minute's turn, then the pace between its two prefixes.
      yield* TestClock.adjust("63 seconds");
      // Two prefixes asked, once each, and nothing more of either password.
      expect(asked).toEqual(["A8A19", "B5301"]);
      const oldFinding = Effect.map(
        findings,
        (all) => all?.find((entry) => entry.accountId === old)?.finding,
      );
      expect(yield* oldFinding).toBe("leaked");
      // A day on, a garbled answer is no answer: what was known stays.
      garbled = true;
      yield* TestClock.adjust("1 day");
      yield* TestClock.adjust("63 seconds");
      expect(asked.filter((prefix) => prefix === "B5301").length).toBeGreaterThan(1);
      expect(yield* oldFinding).toBe("leaked");
    }),
  );

  it.effect("undoes a new password in the Keychain too, or names the copy it couldn't", () =>
    Effect.gen(function* () {
      const written: string[] = [];
      let failKeychain = false;
      const { service } = yield* makeHarness({
        sourceOverrides: {
          platform: "macos",
          keychain: () => Effect.succeed(Redacted.make(written.at(-1) ?? "")),
          writeKeychain: (_source, value) =>
            failKeychain
              ? Effect.fail(new AccountsError({ reason: "unavailable", message: "Keychain" }))
              : Effect.sync(() => void written.push(Redacted.value(value))),
        },
      });
      const login = (value: string, accountId?: AccountId) =>
        service.save({
          ...(accountId ? { accountId } : {}),
          name: "Lab",
          details: { kind: "website", sites: ["example.com"], username: "ada" },
          secrets: {
            password: {
              type: "scient",
              value,
              ...(accountId
                ? {}
                : { saveTo: [{ type: "scient" as const }, { type: "keychain" as const }] }),
            },
          },
        });
      const [first, second, third] = [syntheticValue(), syntheticValue(), syntheticValue()];
      const { accountId } = yield* login(first);
      yield* login(second, accountId);
      expect(written.at(-1)).toBe(second);
      const [update] = (yield* service.snapshot).passwordUpdates ?? [];
      // regression: Undo put the earlier password back in Scient only; the Keychain kept the newer.
      expect(yield* service.undoPasswordUpdate(update!.undoId)).toEqual({
        restored: 1,
        changed: 0,
      });
      expect(written.at(-1)).toBe(first);
      expect(
        secretEquals((yield* service.resolveSecrets(accountId, ["password"])).password, first),
      ).toBe(true);
      // The Keychain refuses this time: the receipt says which copy keeps the newer password.
      yield* login(third, accountId);
      const [again] = (yield* service.snapshot).passwordUpdates ?? [];
      failKeychain = true;
      expect(yield* service.undoPasswordUpdate(again!.undoId)).toEqual({
        restored: 1,
        changed: 0,
        mirrorsLeft: ["Lab"],
      });
    }),
  );

  it.effect("keeps a removed login removed when its browser profile is refreshed", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const csv = (url: string) =>
        `name,url,username,password,note\nSynthetic,${url},user,${syntheticValue()},\n`;
      const count = Effect.map(service.snapshot, ({ accounts }) => accounts.length);
      const imported = (url: string, profileId: string, refresh?: true) =>
        service
          .importPasswords({
            format: "auto",
            content: csv(url),
            profileId,
            ...(refresh ? { refresh } : {}),
          })
          .pipe(Effect.andThen(count));
      const saved = (sites: string[], loginUrl?: string) =>
        service.save({
          name: "Synthetic",
          details: {
            kind: "website",
            sites,
            username: "user",
            ...(loginUrl ? { loginUrl } : {}),
          },
          secrets: { password: { type: "scient", value: syntheticValue() } },
        });
      // Removed with its port: a refresh of that address stays away.
      yield* service.remove((yield* saved(["https://example.com:8443"])).accountId);
      expect(yield* imported("https://example.com:8443/login", "profile-a", true)).toBe(0);
      // One tenant's removal leaves another tenant on that host alone.
      yield* service.remove(
        (yield* saved(["tenant.example"], "https://tenant.example/t/acme/login")).accountId,
      );
      expect(yield* imported("https://tenant.example/t/acme/login", "profile-a", true)).toBe(0);
      expect(yield* imported("https://tenant.example/t/other/login", "profile-a", true)).toBe(1);
      // A removal with no saved address keeps every page away, but not a tenant saved exactly.
      yield* saved(["solo.example"], "https://solo.example/t/acme/login");
      yield* service.remove((yield* saved(["solo.example"])).accountId);
      const refreshed = (url: string) =>
        service.importPasswords({ format: "auto", content: csv(url), refresh: true });
      expect(yield* refreshed("https://solo.example/login")).toMatchObject({ skipped: 1 });
      // The exact tenant is reached: a profile's refresh claims it (its undated password stays).
      expect(
        yield* service.importPasswords({
          format: "auto",
          content: csv("https://solo.example/t/acme/login"),
          profileId: "profile-a",
          refresh: true,
        }),
      ).toMatchObject({ updated: 1, skipped: 0 });
      // Importing it on purpose brings it back, and then a refresh elsewhere does too.
      expect(yield* imported("https://example.com:8443/login", "profile-a")).toBe(3);
      expect(yield* imported("https://example.com:8443/login", "profile-b", true)).toBe(4);
    }),
  );

  it.effect("keeps how each Accounts card ended across a restart", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      const saved = AccountId.make("acc_cardsaved1");
      yield* service.recordCard("scient-account:key:one", "saved", saved);
      yield* service.recordCard("scient-account:key:two", "timed_out");
      const restarted = yield* makeHarness({ storage });
      // A saved card names its row, so the card links to it.
      expect((yield* restarted.service.snapshot).cards).toEqual([
        { requestId: "scient-account:key:one", outcome: "saved", accountId: saved },
        { requestId: "scient-account:key:two", outcome: "timed_out" },
      ]);
    }),
  );

  it.effect("says which cards are still being kept, so an old one never reads Saving…", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      const settling = Effect.map(service.snapshot, ({ cardsSettling }) => cardsSettling);
      yield* service.startCard("scient-account:key:first");
      yield* service.startCard("scient-account:key:open");
      expect(yield* settling).toEqual(["scient-account:key:first", "scient-account:key:open"]);
      yield* service.recordCard("scient-account:key:first", "saved");
      for (let index = 0; index < 500; index++)
        yield* service.recordCard(`scient-account:key:n${index}`, "saved");
      const { cards, cardsSettling } = yield* service.snapshot;
      // Its outcome made way for newer ones, and it isn't being kept: it has ended.
      expect(cards?.some(({ requestId }) => requestId === "scient-account:key:first")).toBe(false);
      expect(cardsSettling).toEqual(["scient-account:key:open"]);
      // Nothing is being kept by a server that restarted.
      expect((yield* (yield* makeHarness({ storage })).service.snapshot).cardsSettling).toEqual([]);
    }),
  );

  it.effect("spends a login's one fallback once a day, across a restart", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service } = yield* makeHarness({ storage });
      expect(yield* service.takeFallback("login-key")).toBe(true);
      expect(yield* service.takeFallback("login-key")).toBe(false);
      expect(yield* service.takeFallback("other-login")).toBe(true);
      const restarted = yield* makeHarness({ storage });
      expect(yield* restarted.service.takeFallback("login-key")).toBe(false);
      yield* TestClock.adjust("25 hours");
      expect(yield* restarted.service.takeFallback("login-key")).toBe(true);
    }),
  );

  it.effect("binds a refused password to the value that was typed, apart from the session", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const input = website();
      const { accountId } = yield* service.save(input);
      const target = { type: "account" as const, accountId };
      const refused = (passwordVersion: string | undefined) =>
        service.recordUse(
          {
            target,
            action: "sign-in",
            outcome: "error",
            signInOutcome: "password-rejected",
            ...(passwordVersion ? { passwordVersion } : {}),
          },
          undefined,
          true,
        );
      const password = Effect.map(
        service.snapshot,
        ({ accounts }) => accounts[0]!.secrets.password,
      );
      const typed = yield* service.passwordVersion(accountId);
      // Saved anew while the attempt ran: the old value's refusal doesn't land on the new one.
      yield* service.save({
        ...input,
        accountId,
        secrets: { password: { type: "scient", value: syntheticValue() } },
      });
      yield* refused(typed);
      expect((yield* password)?.refusedAt).toBeUndefined();
      yield* refused(yield* service.passwordVersion(accountId));
      expect((yield* password)?.refusedAt).toBeDefined();
      // Signing in by hand says nothing about the saved password; Scient typing it does.
      const signedIn = (savedPasswordUsed: boolean) =>
        service.recordUse(
          {
            target,
            action: "sign-in",
            outcome: "ok",
            signInOutcome: "signed-in",
            ...(savedPasswordUsed ? { savedPasswordUsed } : {}),
          },
          undefined,
          true,
        );
      yield* signedIn(false);
      expect((yield* password)?.refusedAt).toBeDefined();
      yield* signedIn(true);
      expect((yield* password)?.refusedAt).toBeUndefined();
    }),
  );

  it.effect("keeps Don't ask for this site for every client, until asked again", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.neverAsk({ add: ["https://example.com/login", "http://plain.example"] });
      expect((yield* service.snapshot).neverAsk).toEqual(["https://example.com"]);
      yield* service.neverAsk({ remove: "https://example.com" });
      expect((yield* service.snapshot).neverAsk).toBeUndefined();
    }),
  );

  it.effect("keeps saved tenant paths apart, and aliases another page only on evidence", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const save = (loginUrl: string | undefined, value: string) =>
        service.save({
          name: "Synthetic",
          details: {
            kind: "website",
            sites: ["example.com"],
            username: "user",
            ...(loginUrl ? { loginUrl } : {}),
          },
          secrets: { password: { type: "scient", value } },
        });
      // Two saved tenants under one folder are two logins: a new password reaches only one.
      const acme = yield* save("https://example.com/login/acme", syntheticValue());
      const otherValue = syntheticValue();
      const other = yield* save("https://example.com/login/other", otherValue);
      yield* service.save({
        accountId: acme.accountId,
        name: "Synthetic",
        details: {
          kind: "website",
          sites: ["example.com"],
          username: "user",
          loginUrl: "https://example.com/login/acme",
        },
        secrets: { password: { type: "scient", value: syntheticValue() } },
      });
      expect(
        secretEquals(
          (yield* service.resolveSecrets(other.accountId, ["password"])).password,
          otherValue,
        ),
      ).toBe(true);
      // The save offer names its page's route: that tenant, or both to choose from without one.
      const offered = (path?: string) =>
        service.matchSignIn({
          origin: "https://example.com",
          username: "user",
          password: syntheticValue(),
          ...(path ? { path } : {}),
        });
      for (const [path, account] of [
        ["/login/other", other],
        ["/login/acme", acme],
      ] as const)
        expect(yield* offered(path)).toEqual({
          result: "password-changed",
          accountId: account.accountId,
        });
      expect((yield* offered())?.choices?.toSorted()).toEqual(
        [acme.accountId, other.accountId].toSorted(),
      );
      // A refresh can't tell which of them a third page is: it writes neither.
      const csv = (url: string, value: string) =>
        `name,url,username,password,note\nSynthetic,${url},user,${value},\n`;
      expect(
        yield* service.importPasswords({
          format: "auto",
          content: csv("https://example.com/login/third", syntheticValue()),
          refresh: true,
        }),
      ).toMatchObject({ created: 0, updated: 0, skipped: 1 });
      expect(
        secretEquals(
          (yield* service.resolveSecrets(other.accountId, ["password"])).password,
          otherValue,
        ),
      ).toBe(true);
      // A saved path is its own tenant, even beside another page holding the same password; an
      // entry at the site's root names no tenant, so it is that login.
      const kept = syntheticValue();
      yield* service.save({
        name: "Synthetic",
        details: {
          kind: "website",
          sites: ["example.org"],
          username: "user",
          loginUrl: "https://example.org/login/acme",
        },
        secrets: { password: { type: "scient", value: kept } },
      });
      const rowsAt = (url: string, value: string) =>
        service.importPasswords({ format: "auto", content: csv(url, value) }).pipe(
          Effect.andThen(service.snapshot),
          Effect.map(({ accounts }) =>
            accounts.filter(
              ({ details }) =>
                "sites" in details && details.sites.some((site) => site.includes("example.org")),
            ),
          ),
        );
      expect(yield* rowsAt("https://example.org/", kept)).toHaveLength(1);
      expect(yield* rowsAt("https://example.org/login/other", kept)).toHaveLength(2);
    }),
  );

  it.effect("imports a later file's tenant as its own login, keeping its port", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const csv = (url: string) =>
        `name,url,username,password,note\nSynthetic,${url},user,${syntheticValue()},\n`;
      const imported = (url: string) =>
        service.importPasswords({ format: "auto", content: csv(url), profileId: "profile-a" }).pipe(
          Effect.andThen(service.snapshot),
          Effect.map(({ accounts }) => accounts),
        );
      yield* imported("https://example.com/t/a/login");
      expect(yield* imported("https://example.com/t/b/login")).toHaveLength(2);
      // A port is kept on the row, so the same address again updates it.
      expect(yield* imported("https://example.com:8443/login")).toHaveLength(3);
      const rows = yield* imported("https://example.com:8443/login");
      expect(rows).toHaveLength(3);
      expect(rows.flatMap(({ details }) => ("sites" in details ? details.sites : []))).toContain(
        "https://example.com:8443",
      );
    }),
  );

  it.effect("imports two tenants of one host as two logins", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const content = [
        "name,url,username,password,note",
        `A,https://example.com/t/a/login,user,${syntheticValue()},`,
        `B,https://example.com/t/b/login,user,${syntheticValue()},`,
      ].join("\n");
      yield* service.importPasswords({ format: "auto", content, profileId: "profile-a" });
      expect((yield* service.snapshot).accounts).toHaveLength(2);
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

  it.effect(
    "merges a profile into Main: rows and choices name Main, the record kept for Undo",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const profileId = BrowserProfileId.make("profile-made");
        const main = BrowserProfileId.make("default");
        const row = (owner: BrowserProfileId, site: string, username: string) => ({
          name: site,
          details: { kind: "website" as const, sites: [site], profileId: owner, username },
          secrets: {},
        });
        yield* service.save(row(profileId, "github.com", "person"));
        yield* service.save(row(main, "github.com", "person"));
        yield* service.save(row(profileId, "arxiv.org", "person"));
        yield* service.chooseProfile({ projectId: scope.projectId, profileId });
        yield* service.chooseProfile({
          threadId: scope.threadId,
          profileId,
          url: "https://github.com/",
        });
        yield* service.retireProfile(profileId, { name: "Made" });
        const { accounts, profileChoices, profiles } = yield* service.snapshot;
        expect(profiles.find((profile) => profile.profileId === profileId)?.retired).toMatchObject({
          into: "main",
          name: "Made",
        });
        expect(
          accounts.map(({ details }) =>
            details.kind === "website" ? [details.sites[0], details.profileId] : [],
          ),
        ).toEqual([
          ["github.com", "default"],
          ["arxiv.org", "default"],
        ]);
        expect(profileChoices?.projects).toEqual({ [scope.projectId]: "default" });
        expect(profileChoices?.threads[scope.threadId]).toMatchObject({
          profileId: "default",
          sites: { "github.com": { profileId: "default" } },
        });
      }),
  );

  it.effect("keeps a profile merged into Main from agents, by any id they hold", () =>
    Effect.gen(function* () {
      const profileId = BrowserProfileId.make("profile-made");
      // A window that still lists it reports it among the browser's profiles.
      const { service } = yield* makeHarness({
        sourceOverrides: { profiles: Effect.succeed(["default", profileId]) },
      });
      yield* service.retireProfile(profileId, { name: "Made" });
      const listed = (ids?: ReadonlyArray<string>) =>
        Effect.map(service.forSession(scope, ids), ({ profiles }) =>
          profiles.some((profile) => profile.profileId === profileId),
        );
      expect(yield* listed()).toBe(false);
      expect(yield* listed([profileId])).toBe(false);
      expect(
        yield* service.authorize(scope, { type: "profile", profileId }, "open-profile"),
      ).toEqual({ decision: "denied", reason: "off" });
    }),
  );

  it.effect("undoes a merge once: a merge read before Undo is refused after it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("profile-made");
      const record = Effect.map(service.snapshot, ({ profiles }) =>
        profiles.find((profile) => profile.profileId === profileId),
      );
      yield* service.retireProfile(profileId, { name: "Made" });
      const first = (yield* record)?.retired?.at;
      // A second merge, as from another launch, keeps the first.
      yield* service.retireProfile(profileId, { name: "Made" });
      expect((yield* record)?.retired?.at).toBe(first);
      yield* service.retireProfile(profileId, "undo");
      expect(yield* record).toMatchObject({ undone: expect.any(String) });
      expect((yield* record)?.retired).toBeUndefined();
      const stale = yield* service.retireProfile(profileId, { name: "Made" }).pipe(Effect.flip);
      expect(stale.reason).toBe("conflict");
      expect((yield* record)?.retired).toBeUndefined();
    }),
  );
});

describe("AccountsService and Main", () => {
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

  it.effect("reads rows stored before `from` as imported or copied, keeping the rest", () =>
    Effect.gen(function* () {
      const storage = memoryStore();
      const { service, vault, blobs } = yield* makeHarness({ storage });
      yield* service.sessionsSeen({
        profileId: BrowserProfileId.make("profile-work"),
        sessions: [{ site: "github.com", how: "imported", from: "Chrome · Person" }],
      });
      const work = yield* service.save(row("profile-work", ["overleaf.com"]));
      yield* service.mainFilled({ accountId: work.accountId, profileName: "Work" });
      // The state as the earlier build stored it: the origin only in the detail's first words.
      const name = "accounts-state";
      const stored = JSON.parse(
        new TextDecoder().decode(Redacted.value(yield* vault.decrypt(name, blobs.get(name)!))),
      ) as { accounts: Array<{ summary: { signIn?: Record<string, unknown> } }> };
      for (const { summary } of stored.accounts) delete summary.signIn?.["from"];
      blobs.set(
        name,
        yield* vault.encrypt(name, Redacted.make(new TextEncoder().encode(JSON.stringify(stored)))),
      );
      const restarted = yield* makeHarness({ storage });
      expect(
        (yield* restarted.service.snapshot).accounts.flatMap(({ details, signIn }) =>
          signIn && details.kind === "website"
            ? [[details.sites, signIn.state, signIn.by, signIn.detail, signIn.from]]
            : [],
        ),
      ).toEqual([
        [["github.com"], "unknown", "look", "Imported from Chrome · Person", "import"],
        [["overleaf.com"], "unknown", "look", "Copied from Work", "copy"],
      ]);
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
            account.signIn?.from,
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
        [["github.com"], "unknown", "look", "import"],
        [["huji.ac.il"], "unknown", "look", "import"],
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

  it.effect("tells a new typed password with the same Undo as the person's own sign-in", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const before = syntheticValue();
      const { accountId } = yield* service.save({
        ...website(),
        secrets: { password: { type: "scient", value: before } },
      });
      yield* service.recordUse({
        target: { type: "account", accountId },
        action: "sign-in",
        outcome: "ok",
        signInOutcome: "signed-in",
      });
      const typed = { username: "person", password: Redacted.make(syntheticValue()) };
      expect(yield* service.keepTyped(accountId, typed)).toBe("kept");
      const [update] = (yield* service.snapshot).passwordUpdates ?? [];
      expect(update).toMatchObject({ accountId });
      expect(yield* service.undoPasswordUpdate(update!.undoId)).toEqual({
        restored: 1,
        changed: 0,
      });
      expect(
        secretEquals((yield* service.resolveSecrets(accountId, ["password"])).password, before),
      ).toBe(true);
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
  it.effect("closes an approval card when the asking agent's time runs out", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const target = { type: "account" as const, accountId };
      yield* service.setControls({ target, access: "ask" });
      const asking = yield* service
        .authorize(scope, target, "sign-in", { waitMs: 30_000 })
        .pipe(Effect.forkChild);
      yield* waitingApproval(service);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(asking)).toEqual({ decision: "denied", reason: "timed-out" });
      expect((yield* service.snapshot).approvals).toEqual([]);
    }),
  );

  it.effect("offers to turn an Off account on for agents, and the answer decides its access", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const target = { type: "account" as const, accountId };
      yield* service.setControls({ target, access: "off" });
      const ask = (decision: "once" | "deny") =>
        Effect.gen(function* () {
          const asking = yield* service.authorize(scope, target, "sign-in").pipe(Effect.forkChild);
          const approval = yield* waitingApproval(service);
          expect(approval.turnOn).toBe(true);
          yield* service.respondApproval(approval.approvalId, decision);
          return yield* Fiber.join(asking);
        });
      // Not now: it stays Off.
      expect((yield* ask("deny")).decision).toBe("denied");
      expect((yield* service.snapshot).accounts[0]?.controls.access).toBe("off");
      // This conversation: Ask, allowed here; an unattended run still gets no card.
      expect((yield* ask("once")).decision).toBe("allowed");
      expect((yield* service.snapshot).accounts[0]?.controls.access).toBe("ask");
      expect((yield* service.authorize(scope, target, "sign-in")).decision).toBe("allowed");
      yield* service.setControls({ target, access: "off" });
      expect(
        (yield* service.authorize({ ...scope, unattended: true }, target, "sign-in")).decision,
      ).toBe("denied");
    }),
  );

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
            // Off beats the conversation's grant (attended, it would ask to turn it on).
            expect(
              yield* service.authorize({ ...approvalScope, unattended: true }, target, "request"),
            ).toEqual({ decision: "denied", reason: "off" });
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
    const line = (password: string, date: string) =>
      `name,url,username,password,password_changed\nSite,https://example.com/login,synthetic-user,${password},${date}`;
    yield* service.importPasswords({
      format: "auto",
      content: line(value, "2024-01-01T00:00:00.000Z"),
    });
    const { accountId } = (yield* service.snapshot).accounts[0]!;
    storage.failWritesTo("accounts-state");
    yield* service
      .importPasswords({
        format: "auto",
        content: line(syntheticValue(), "2025-01-01T00:00:00.000Z"),
      })
      .pipe(Effect.flip);
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
      const content = `name,url,username,password,password_changed\nMail,https://mail.example.com/login,user,${mailValue},2024-01-01T00:00:00.000Z\nWiki,https://wiki.example.com/login,user,${wikiValue},2024-01-01T00:00:00.000Z`;
      const stateWrites = () =>
        operations.filter((operation) => operation.includes("accounts-state")).length;
      const before = stateWrites();
      expect(yield* service.importPasswords({ format: "auto", content })).toEqual({
        created: 2,
        updated: 0,
        skipped: 0,
      });
      // The import is one write of its rows, after one reserving its new values' names on disk:
      // per-entry writes and publishes froze large imports.
      expect(stateWrites() - before).toBe(2);
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
          content: `name,url,username,password,password_changed\nMail,https://mail.example.com/login,user,${next},2025-01-01T00:00:00.000Z`,
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
  "reads 1Password without holding up other changes, and returns the row's value after",
  () =>
    Effect.gen(function* () {
      const [started, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const { service } = yield* makeHarness({
        sourceOverrides: {
          onePassword: () =>
            Effect.succeed({
              label: "Synthetic vault",
              resolve: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(answer)),
                  Effect.as(Redacted.make(syntheticValue())),
                ),
            }),
        },
      });
      yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
      const { accountId } = yield* service.save({
        ...website(),
        secrets: { password: { type: "1password", reference: "op://vault/item/password" } },
      });
      const read = yield* service.resolveSecrets(accountId, ["password"]).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      // 1Password is still waiting on its prompt; the user's edit goes through meanwhile.
      const typed = syntheticValue();
      yield* service.save({ ...website(typed), accountId });
      yield* Deferred.succeed(answer, undefined);
      expect(secretEquals((yield* Fiber.join(read)).password, typed)).toBe(true);
    }),
);

it.effect("never lets a Connect that finishes late undo a Disconnect made meanwhile", () =>
  Effect.gen(function* () {
    const [connecting, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    let calls = 0;
    const { service } = yield* makeHarness({
      sourceOverrides: {
        onePassword: () =>
          (calls++ === 1
            ? Deferred.succeed(connecting, undefined).pipe(Effect.andThen(Deferred.await(answer)))
            : Effect.void
          ).pipe(Effect.as({ label: "Synthetic vault", resolve: () => Effect.die("not read") })),
      },
    });
    yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
    const late = yield* service
      .connectOnePassword({ mode: "desktop", accountName: "Other" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(connecting);
    yield* service.disconnectOnePassword;
    yield* Deferred.succeed(answer, undefined);
    yield* Fiber.join(late);
    expect((yield* service.snapshot).stores.onePassword.state).toBe("not-connected");
  }),
);

it.effect("drops a 1Password answer that arrives after 1Password was disconnected", () =>
  Effect.gen(function* () {
    const [started, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const { service } = yield* makeHarness({
      sourceOverrides: {
        onePassword: () =>
          Effect.succeed({
            label: "Synthetic vault",
            resolve: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(answer)),
                Effect.as(Redacted.make(syntheticValue())),
              ),
          }),
      },
    });
    yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
    const { accountId } = yield* service.save({
      ...website(),
      secrets: { password: { type: "1password", reference: "op://vault/item/password" } },
    });
    const read = yield* service.resolveSecrets(accountId, ["password"]).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* service.disconnectOnePassword;
    yield* Deferred.succeed(answer, undefined);
    expect((yield* Fiber.join(read).pipe(Effect.flip)).message).toContain("not connected");
  }),
);

it.effect("settles a late 1Password copy into the row as it is now, in the order saved", () =>
  Effect.gen(function* () {
    const [writing, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const written: Array<string> = [];
    let calls = 0;
    const { service } = yield* makeHarness({
      sourceOverrides: {
        onePassword: () =>
          Effect.succeed({
            label: "Synthetic vault",
            vaults: [{ id: "vault", name: "Vault", readOnly: false }],
            resolve: () => Effect.die("not read"),
            createLogin: () =>
              Effect.succeed({ type: "1password" as const, reference: "op://vault/item/password" }),
            // The first write waits on 1Password's prompt; later ones answer at once.
            write: (_reference, value) =>
              (calls++ === 0
                ? Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(answer)))
                : Effect.void
              ).pipe(Effect.andThen(Effect.sync(() => written.push(Redacted.value(value))))),
          }),
      },
    });
    yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
    const { accountId } = yield* service.save({
      ...website(),
      secrets: {
        password: {
          type: "scient",
          value: syntheticValue(),
          saveTo: [{ type: "scient" }, { type: "1password", vaultId: "vault" }],
        },
      },
    });
    const [older, newer] = [syntheticValue(), syntheticValue()];
    const first = yield* service.save({ ...website(older), accountId }).pipe(Effect.forkChild);
    yield* Deferred.await(writing);
    // While 1Password waits: the row goes Off, and a newer password is saved.
    yield* service.setControls({ target: { type: "account", accountId }, access: "off" });
    const second = yield* service.save({ ...website(newer), accountId }).pipe(Effect.forkChild);
    yield* Deferred.succeed(answer, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    const row = (yield* service.snapshot).accounts.find(
      (account) => account.accountId === accountId,
    )!;
    expect(row.controls.access).toBe("off");
    expect(written.at(-1)).toBe(newer);
    expect(
      secretEquals((yield* service.resolveSecrets(accountId, ["password"])).password, newer),
    ).toBe(true);
  }),
);

it.effect("writes an imported password's 1Password copy without holding up other changes", () =>
  Effect.gen(function* () {
    const [writing, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const { service } = yield* makeHarness({
      sourceOverrides: {
        onePassword: () =>
          Effect.succeed({
            label: "Synthetic vault",
            vaults: [{ id: "vault", name: "Vault", readOnly: false }],
            resolve: () => Effect.die("not read"),
            createLogin: () =>
              Effect.succeed({ type: "1password" as const, reference: "op://vault/item/password" }),
            write: () =>
              Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(answer))),
          }),
      },
    });
    yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
    yield* service.save({
      ...website(),
      secrets: {
        password: {
          type: "scient",
          value: syntheticValue(),
          changedAt: "2024-01-01T00:00:00.000Z",
          saveTo: [{ type: "scient" }, { type: "1password", vaultId: "vault" }],
        },
      },
    });
    const imported = yield* service
      .importPasswords({
        format: "auto",
        content: `name,url,username,password,password_changed\nSite,https://example.com/login,synthetic-user,${syntheticValue()},2025-01-01T00:00:00.000Z`,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writing);
    // 1Password is still writing the copy; another save goes through meanwhile.
    yield* service.save({
      ...website(),
      details: { kind: "website", sites: ["other.example.com"] },
    });
    yield* Deferred.succeed(answer, undefined);
    expect(yield* Fiber.join(imported)).toEqual({ created: 0, updated: 1, skipped: 0 });
  }),
);

it.effect("writes a typed password's 1Password copy without holding up other changes", () =>
  Effect.gen(function* () {
    const [writing, answer] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const { service } = yield* makeHarness({
      sourceOverrides: {
        onePassword: () =>
          Effect.succeed({
            label: "Synthetic vault",
            vaults: [{ id: "vault", name: "Vault", readOnly: false }],
            resolve: () => Effect.die("not read"),
            createLogin: () =>
              Effect.succeed({ type: "1password" as const, reference: "op://vault/item/password" }),
            write: () =>
              Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(answer))),
          }),
      },
    });
    yield* service.connectOnePassword({ mode: "desktop", accountName: "Synthetic" });
    yield* service.save({
      ...website(),
      secrets: {
        password: {
          type: "scient",
          value: syntheticValue(),
          changedAt: "2024-01-01T00:00:00.000Z",
          saveTo: [{ type: "scient" }, { type: "1password", vaultId: "vault" }],
        },
      },
    });
    const { accountId } = (yield* service.snapshot).accounts[0]!;
    const imported = yield* service
      .keepTyped(accountId, {
        username: "synthetic-user",
        password: Redacted.make(syntheticValue()),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writing);
    // 1Password is still writing the copy; another save goes through meanwhile.
    yield* service.save({
      ...website(),
      details: { kind: "website", sites: ["other.example.com"] },
    });
    yield* Deferred.succeed(answer, undefined);
    expect(yield* Fiber.join(imported)).toBe("kept");
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
      // The row's waiting entry steps back while its hand-off says the same, then returns.
      const need = {
        needId: `sign-in:${accountId}`,
        name: "Synthetic",
        detail: "Approve on your phone",
        action: "sign-in" as const,
        accountId,
      };
      yield* service.setNeedsYou(need);
      expect((yield* service.snapshot).needsYou).toBeUndefined();
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
      expect((yield* service.snapshot).needsYou).toMatchObject([need]);
      expect(yield* service.handoffCancelled(entry.handoffId)).toBe(false);
    }),
);

it.effect("takes a Use saved click only for the card revision on screen, and once", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness({ storage: memoryStore() });
    const { accountId } = yield* service.save(website());
    const card = {
      handoffId: "synthetic-saved",
      threadId: scope.threadId,
      accountId,
      accountName: "Synthetic",
      site: "example.com",
      kind: "code" as const,
      useSaved: "dana",
      useSavedRevision: "r1",
      startedAt: "2026-10-27T00:00:00Z",
      expiresAt: "2026-10-27T00:03:00Z",
    };
    yield* service.setHandoff(card, Effect.void);
    // The sign-in moved to another box: a click on the card it replaced counts for nothing.
    yield* service.setHandoff({ ...card, useSavedRevision: "r2" }, Effect.void);
    // regression: a click was kept by hand-off alone, so a newer box under it received it.
    expect((yield* service.useSavedInHandoff(card.handoffId, "r1").pipe(Effect.flip)).reason).toBe(
      "not-found",
    );
    expect(yield* service.savedRequested(card.handoffId)).toBeUndefined();
    yield* service.useSavedInHandoff(card.handoffId, "r2");
    expect(yield* service.savedRequested(card.handoffId)).toBe("r2");
    expect(yield* service.savedRequested(card.handoffId)).toBeUndefined();
    // regression: a retried click, after the sign-in took it, queued the same revision again.
    yield* service.useSavedInHandoff(card.handoffId, "r2");
    expect(yield* service.savedRequested(card.handoffId)).toBeUndefined();
    // A click waiting to be taken goes with a newer card, and with the hand-off itself.
    yield* service.setHandoff({ ...card, useSavedRevision: "r3" }, Effect.void);
    yield* service.useSavedInHandoff(card.handoffId, "r3");
    yield* service.setHandoff({ ...card, useSavedRevision: "r4" }, Effect.void);
    expect(yield* service.savedRequested(card.handoffId)).toBeUndefined();
    yield* service.useSavedInHandoff(card.handoffId, "r4");
    yield* service.removeHandoff(card.handoffId);
    expect(yield* service.savedRequested(card.handoffId)).toBeUndefined();
  }),
);

it.effect("renames a row from the directory only while nobody changed it meanwhile", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness({ storage: memoryStore() });
    const proxyUrl = "https://go.openathens.net/redirector/huji.ac.il?url={url}";
    const details = { kind: "website" as const, sites: ["huji.ac.il"], proxyUrl };
    const { accountId } = yield* service.save({ name: "go.openathens.net", details, secrets: {} });
    const nameOf = Effect.map(
      service.snapshot,
      ({ accounts }) => accounts.find((row) => row.accountId === accountId)?.name,
    );
    // The person renamed it while the directory was being asked.
    yield* service.save({ accountId, name: "My library", details, secrets: {} });
    yield* service.renameIfUnchanged(accountId, { name: "go.openathens.net", proxyUrl }, "HUJI");
    expect(yield* nameOf).toBe("My library");
    yield* service.renameIfUnchanged(accountId, { name: "My library", proxyUrl }, "HUJI");
    expect(yield* nameOf).toBe("HUJI");
  }),
);

it.effect("a sign-out keeps its targets until cleared, and a newer sign-in ends it for good", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness({ storage: memoryStore() });
    const details = {
      kind: "website" as const,
      sites: ["huji.ac.il"],
      proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}",
    };
    const { accountId } = yield* service.save({ name: "HUJI", details, secrets: {} });
    const target = { profileId: BrowserProfileId.make("default"), site: "huji.ac.il" };
    const vendor = {
      profileId: BrowserProfileId.make("default"),
      site: "proxy.library-vendor.com",
    };
    const op = yield* service.beginSignOut([accountId], [target, vendor]);
    // Pressed again, even after the row changed, it finishes what it started with.
    expect(yield* service.beginSignOut([accountId], [target])).toEqual(op);
    expect((yield* service.settleSignOut(op.opId, [target]))?.pending).toEqual([vendor]);
    expect((yield* service.snapshot).universitySignOuts).toHaveLength(1);
    // The person signs in from another window: the old sign-out is over, its report ignored.
    yield* service.recordUse(
      {
        target: { type: "account", accountId },
        action: "sign-in",
        signInOutcome: "signed-in",
        outcome: "ok",
        byPerson: true,
      },
      undefined,
      true,
    );
    expect(yield* service.settleSignOut(op.opId, [vendor])).toBeUndefined();
    const after = yield* service.snapshot;
    expect(after.universitySignOuts).toBeUndefined();
    expect(after.accounts.find((row) => row.accountId === accountId)?.signIn?.state).toBe(
      "signed-in",
    );
    // A new sign-out after that is a newer one.
    expect((yield* service.beginSignOut([accountId], [target])).seq).toBeGreaterThan(op.seq);
  }),
);

it.effect("takes one code per hand-off: the first claim, Scient's or a device's, wins", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness({
      storage: memoryStore(),
      sourceOverrides: {
        codesHost: Effect.succeed({ computer: "Synthetic Mac", readable: true }),
      },
    });
    const { accountId } = yield* service.save(website());
    const handoff = (handoffId: string) =>
      service.setHandoff({
        handoffId,
        threadId: scope.threadId,
        accountId,
        accountName: "Synthetic",
        site: "example.com",
        kind: "code",
        codes: [
          { codeId: "first", source: "messages", at: "2026-10-27T00:00:10Z" },
          { codeId: "second", source: "mail", at: "2026-10-27T00:00:20Z" },
        ],
        startedAt: "1970-01-01T00:00:00Z",
        expiresAt: "1970-01-01T00:03:00Z",
      });
    yield* handoff("clicked-first");
    yield* service.insertHandoffCode("clicked-first", "first");
    // The phone's click after the desktop's is told so, not silently replacing it.
    expect(
      (yield* service.insertHandoffCode("clicked-first", "second").pipe(Effect.flip)).reason,
    ).toBe("conflict");
    // Scient's own code loses to the click that came first.
    expect(yield* service.claimHandoffCode("clicked-first")).toBe(false);
    expect(yield* service.chosenHandoffCode("clicked-first")).toBe("first");
    // And a click after Scient's own code went in is told so.
    yield* handoff("automatic-first");
    expect(yield* service.claimHandoffCode("automatic-first")).toBe(true);
    expect(
      (yield* service.insertHandoffCode("automatic-first", "first").pipe(Effect.flip)).reason,
    ).toBe("conflict");
    // With the switch turned off, a stale card's click is refused.
    yield* handoff("switched-off");
    const before = yield* service.codeSourcesVersion;
    yield* service.setCodeSources({ messages: false });
    // A sign-in holding a code picked under the old switch sees it changed.
    expect(yield* service.codeSourcesVersion).toBeGreaterThan(before);
    expect(
      (yield* service.insertHandoffCode("switched-off", "first").pipe(Effect.flip)).reason,
    ).toBe("denied");
  }),
);

it.effect("settles a sign-in's outcome by version, inside the write that records it", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const input = website();
    const { accountId } = yield* service.save(input);
    const target = { type: "account" as const, accountId };
    const row = Effect.map(service.snapshot, ({ accounts }) => accounts[0]!);
    // The sign-in reads the row, then the person saves a replacement before its outcome lands.
    const started = (yield* row).updatedAt;
    yield* TestClock.adjust("1 second");
    yield* service.save({ ...input, accountId });
    const replaced = (yield* row).signIn;
    const refusal = {
      target,
      action: "sign-in" as const,
      outcome: "error" as const,
      signInOutcome: "password-rejected" as const,
    };
    yield* service.recordUse({ ...refusal, version: started }, undefined, true);
    expect((yield* row).signIn).toEqual(replaced);
    // The same refusal about the row as it is now holds it.
    yield* service.recordUse({ ...refusal, version: (yield* row).updatedAt }, undefined, true);
    expect((yield* row).signIn?.state).toBe("password-rejected");
  }),
);

it.effect(
  "publishes a session only while no sign-out of its site stands, and none lands meanwhile",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const main = BrowserProfileId.make("default");
      const row = { details: { kind: "website" as const, sites: ["example.com"] } };
      const sequence = yield* service.signOutSequence;
      let published = 0;
      // A sign-out asked for while a publication runs waits for it, then stands.
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const publication = yield* service
        .unlessSignedOutSince(
          row,
          sequence,
          Deferred.succeed(writing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => void published++)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const signOut = yield* service.rememberSignOut(main, "example.com").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* service.signedOut).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(publication)).toBe(true);
      yield* Fiber.join(signOut);
      expect(published).toBe(1);
      // A sign-out since the sign-in began: nothing goes out.
      expect(
        yield* service.unlessSignedOutSince(
          row,
          sequence,
          Effect.sync(() => void published++),
        ),
      ).toBe(false);
      expect(published).toBe(1);
    }),
);

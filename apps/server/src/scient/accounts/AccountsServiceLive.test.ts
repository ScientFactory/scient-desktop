import { describe, expect, it } from "@effect/vitest";
import { AccountsSnapshot, ProjectId, ThreadId, defaultAccountControls } from "@t3tools/contracts";
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
            Stream.filter((snapshot) => snapshot.accounts[0]?.lastSignInOutcome === signInOutcome),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild,
          );
          yield* service.recordUse({
            target,
            action: "sign-in",
            outcome: signInOutcome === "signed-in" ? "ok" : "error",
            signInOutcome,
          });
          yield* Fiber.join(recorded);
          expect((yield* service.activity({ target }))[0]?.signInOutcome).toBe(signInOutcome);
        }
        yield* service.save({ ...input, accountId, secrets: {} });
        expect((yield* service.snapshot).accounts[0]?.lastSignInOutcome).toBe("code-rejected");
        yield* service.save({ ...input, accountId });
        expect((yield* service.snapshot).accounts[0]?.lastSignInOutcome).toBeUndefined();
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

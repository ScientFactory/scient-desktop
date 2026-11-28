// @effect-diagnostics nodeBuiltinImport:off -- Probe real filesystem modes, symlinks and shell parsing with synthetic values.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  AccountId,
  BrowserProfileId,
  defaultBrowserProfileRecord,
  type AccountsSnapshot,
  type AccountSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  cleanSessionFiles,
  credentialContents,
  makeSessionFiles,
  revokeIssuedFiles,
} from "./sessionFiles.ts";
import { netscapeCookieJar } from "./cookies.ts";
import { accountGrant, profileGrant } from "../accessChanges.ts";

const account: AccountSummary = {
  accountId: AccountId.make("acc_fixture1"),
  name: "Fixture",
  details: {
    kind: "database",
    engine: "postgres",
    host: "db.example.com",
    port: 5432,
    user: "reader",
    database: "research",
  },
  secrets: { password: { source: { type: "scient" } } },
  controls: {
    access: "allowed",
    permission: "read-only",
    visibility: "readable",
    scope: { type: "all-projects" },
  },
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

it.effect(
  "writes private atomic files, isolates threads, replaces symlinks, and removes expired material",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "accounts-agent-")),
      );
      try {
        const files = yield* makeSessionFiles(root);
        const target = yield* files.write("thread-a", "credentials.env", "synthetic-first");
        expect(
          (yield* Effect.promise(() => NodeFSP.stat(NodePath.dirname(target)))).mode & 0o777,
        ).toBe(0o700);
        expect((yield* Effect.promise(() => NodeFSP.stat(target))).mode & 0o777).toBe(0o600);
        const other = yield* files.write("thread-b", "credentials.env", "synthetic-other");
        expect(NodePath.dirname(target)).not.toBe(NodePath.dirname(other));
        yield* Effect.promise(async () => {
          await NodeFSP.unlink(target);
          await NodeFSP.symlink(other, target);
        });
        yield* files.write("thread-a", "credentials.env", "synthetic-new");
        expect(yield* Effect.promise(() => NodeFSP.readFile(other, "utf8"))).toBe(
          "synthetic-other",
        );
        expect(yield* Effect.promise(() => NodeFSP.readFile(target, "utf8"))).toBe("synthetic-new");
        yield* Effect.promise(async () => {
          await NodeFSP.utimes(target, 1, 1);
          await cleanSessionFiles(root, 24 * 60 * 60 * 1000 + 1001);
        });
        expect(
          yield* Effect.promise(() =>
            NodeFSP.stat(target).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true);
        expect(
          (yield* Effect.flip(files.write("thread-a", "../outside", "synthetic"))).message,
        ).toContain("session files");
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }),
);

it("encodes libpq passwords and read-only configuration, quotes shell values without execution, and serializes HttpOnly cookie jars safely", () => {
  const content = credentialContents(
    account,
    {
      password: Redacted.make("synthetic:back\\slash"),
      clientKey: Redacted.make("synthetic-certificate"),
    },
    "/synthetic path",
  );
  expect(content.files["acc_fixture1-pg_service.conf"]).toContain(
    "options=-c default_transaction_read_only=on",
  );
  expect(content.files["acc_fixture1-.pgpass"]).toContain("synthetic\\:back\\\\slash");
  expect(content.files["acc_fixture1-clientKey.pem"]).toBe("synthetic-certificate");
  const value = "synthetic'$(exit 89)\nvalue";
  const env = credentialContents(
    {
      ...account,
      details: { kind: "api-key", sites: [], auth: { type: "bearer" }, envName: "TEST_ACCOUNT" },
    },
    { token: Redacted.make(value) },
    "/synthetic path",
  );
  expect(
    NodeChildProcess.execFileSync(
      "/bin/sh",
      ["-c", env.files["acc_fixture1.env"] + '\nprintf %s "$TEST_ACCOUNT"'],
      {
        encoding: "utf8",
      },
    ),
  ).toBe(value);
  expect(() =>
    credentialContents(
      {
        ...account,
        details: {
          ...account.details,
          kind: "database",
          engine: "postgres",
          host: "db\nuser=other",
          port: 5432,
          database: "research",
          user: "reader",
        },
      },
      {},
      "/synthetic",
    ),
  ).toThrow();
  const cookie = {
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
    name: "session",
    value: "synthetic",
  };
  const jar = netscapeCookieJar([
    cookie,
    { ...cookie, domain: "app.example.com", hostOnly: true, httpOnly: false, expires: 2000.5 },
    {
      ...cookie,
      name: "partitioned",
      partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: false },
    },
  ]);
  expect(jar).toContain("#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsession\tsynthetic");
  // A host-only cookie stays off subdomains; the format can't carry a partition.
  expect(jar).toContain("\napp.example.com\tFALSE\t/\tTRUE\t2000\tsession\tsynthetic");
  expect(jar).not.toContain("partitioned");
  expect(() => netscapeCookieJar([{ ...cookie, value: "synthetic\ninjected" }])).toThrow(
    "unsupported cookie",
  );
});

it.effect("takes back issued files when any grant they were given under changes", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "accounts-agent-"))),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
    const profile = defaultBrowserProfileRecord(BrowserProfileId.make("work"));
    const other = { ...account, accountId: AccountId.make("acc_fixture2") };
    const off = { ...account, controls: { ...account.controls, access: "off" as const } };
    const snapshot = (accounts: ReadonlyArray<AccountSummary>, agentAccess = true) =>
      ({ agentAccess, accounts, profiles: [profile] }) as unknown as AccountsSnapshot;
    // Each read takes the next snapshot; the last one stays.
    let current = [snapshot([account, other])];
    const files = yield* makeSessionFiles(
      root,
      Effect.sync(() => (current.length > 1 ? current.shift()! : current[0]!)),
    );
    // A website session names both its grants: the account and the profile it came from.
    const [cookies] = yield* files.issue(
      yield* files.begin("thread-a"),
      [profileGrant(profile), accountGrant(account)],
      [["work-cookies.txt", "synthetic"]],
    );
    const [credentials] = yield* files.issue(
      yield* files.begin("thread-b"),
      [accountGrant(other)],
      [["acc_fixture2.env", "synthetic"]],
    );
    const left = () =>
      Effect.promise(() =>
        Promise.all(
          [cookies!, credentials!].map((file) =>
            NodeFSP.stat(file).then(
              () => true,
              () => false,
            ),
          ),
        ),
      );
    yield* revokeIssuedFiles(root, Stream.make(snapshot([account, other]), snapshot([off, other])));
    expect(yield* left()).toEqual([false, true]);
    // Allowed when the export began, Off by the time its file is written: refused, nothing left.
    current = [snapshot([account, other]), snapshot([off, other])];
    const late = yield* files
      .issue(
        yield* files.begin("thread-a"),
        [accountGrant(account)],
        [["acc_fixture1.env", "synthetic"]],
      )
      .pipe(Effect.flip);
    expect(late.reason).toBe("denied");
    expect(
      yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(NodePath.dirname(cookies!)))),
    ).toEqual([]);
    // On start, whatever no longer stands goes, without a change to compare, and so does an
    // export an older build left with no grants recorded.
    const legacy = yield* files.write("thread-b", "acc_fixture9.env", "synthetic");
    yield* revokeIssuedFiles(root, Stream.make(snapshot([off, other], false)));
    expect(yield* left()).toEqual([false, false]);
    expect(
      yield* Effect.promise(() =>
        NodeFSP.stat(legacy).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    // A website's cookies are granted for its sites: taking the site away takes them back.
    const site: AccountSummary = {
      ...account,
      accountId: AccountId.make("acc_fixture3"),
      details: { kind: "website", sites: ["example.com", "other.example.com"] },
    };
    current = [snapshot([site])];
    const [cookie] = yield* files.issue(
      yield* files.begin("thread-d"),
      [accountGrant(site)],
      [["work-cookies.txt", "synthetic"]],
    );
    yield* revokeIssuedFiles(
      root,
      Stream.make(
        snapshot([site]),
        snapshot([{ ...site, details: { kind: "website", sites: ["example.com"] } }]),
      ),
    );
    expect(
      yield* Effect.promise(() =>
        NodeFSP.stat(cookie!).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    // A removed profile takes its cookies with it, though its grant looked like the defaults.
    current = [snapshot([account])];
    const [kept] = yield* files.issue(
      yield* files.begin("thread-c"),
      [profileGrant(profile)],
      [["work-cookies.txt", "synthetic"]],
    );
    yield* revokeIssuedFiles(
      root,
      Stream.make(snapshot([account]), {
        ...snapshot([account]),
        profiles: [],
      } as AccountsSnapshot),
    );
    expect(
      yield* Effect.promise(() =>
        NodeFSP.stat(kept!).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps each export with its own grants, whatever a later one for the same names does",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "accounts-agent-"))),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const other = { ...account, accountId: AccountId.make("acc_fixture2") };
      const off = (row: AccountSummary) => ({
        ...row,
        controls: { ...row.controls, access: "off" as const },
      });
      const snapshot = (accounts: ReadonlyArray<AccountSummary>) =>
        ({ agentAccess: true, accounts, profiles: [] }) as unknown as AccountsSnapshot;
      let current = [snapshot([account, other])];
      const files = yield* makeSessionFiles(
        root,
        Effect.sync(() => (current.length > 1 ? current.shift()! : current[0]!)),
      );
      const [first] = yield* files.issue(
        yield* files.begin("thread"),
        [accountGrant(account)],
        [["work-cookies.txt", "first"]],
      );
      // A second export of the same names that fails half-way, and one refused after writing.
      const broken = yield* files
        .issue(
          yield* files.begin("thread"),
          [accountGrant(other)],
          [
            ["work-cookies.txt", "second"],
            ["../outside", "second"],
          ],
        )
        .pipe(Effect.flip);
      expect(broken.reason).toBe("unavailable");
      current = [snapshot([account, other]), snapshot([account, off(other)])];
      yield* files
        .issue(yield* files.begin("thread"), [accountGrant(other)], [["work-cookies.txt", "third"]])
        .pipe(Effect.flip);
      expect(yield* Effect.promise(() => NodeFSP.readFile(first!, "utf8"))).toBe("first");
      // The first export still answers to its own account only.
      yield* revokeIssuedFiles(root, Stream.make(snapshot([account]), snapshot([off(account)])));
      expect(
        yield* Effect.promise(() => NodeFSP.readdir(NodePath.dirname(NodePath.dirname(first!)))),
      ).toEqual([]);
    }).pipe(Effect.scoped),
);

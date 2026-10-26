// @effect-diagnostics nodeBuiltinImport:off -- Probe real filesystem modes, symlinks and shell parsing with synthetic values.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { AccountId, type AccountSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { cleanSessionFiles, credentialContents, makeSessionFiles } from "./sessionFiles.ts";
import { netscapeCookieJar } from "./cookies.ts";

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
    path: "/",
    secure: true,
    httpOnly: true,
    expires: -1,
    name: "session",
    value: "synthetic",
  };
  expect(netscapeCookieJar([cookie])).toContain(
    "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsession\tsynthetic",
  );
  expect(() => netscapeCookieJar([{ ...cookie, value: "synthetic\ninjected" }])).toThrow(
    "unsupported cookie",
  );
});

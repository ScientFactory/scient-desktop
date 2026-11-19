// @effect-diagnostics nodeBuiltinImport:off -- Reads the session files the module writes in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { AccountsService } from "./AccountsService.ts";
import { makeConnectorSessions } from "./connectorSessions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const SITE = "https://portal.example.edu";
const account = {
  accountId: "acc_portal0001",
  name: "Course portal",
  details: { kind: "website", sites: [SITE] },
  controls: { access: "allowed", scope: { type: "all-projects" } },
  secrets: { password: {} },
};
const cookie = (value: string) => ({
  name: "portal_session",
  value,
  domain: "portal.example.edu",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
});

/** A browser whose profile holds `jar`; every operation is recorded. */
const fakes = (jar: { current: ReadonlyArray<ReturnType<typeof cookie>> }) => {
  const operations: string[] = [];
  const broker = {
    invoke: ({ operation }: { operation: string }) => {
      operations.push(operation);
      switch (operation) {
        case "status":
          return Effect.succeed({ tabs: [], defaultProfileId: "default" });
        case "open":
          return Effect.succeed({ tabId: "tab-1", tabs: [] });
        case "accountCookies":
          return Effect.succeed(jar.current);
        case "evaluate":
          return Effect.succeed("Mozilla/5.0 Test");
        default:
          return Effect.succeed({});
      }
    },
  } as unknown as PreviewAutomationBroker["Service"];
  const accounts = {
    snapshot: Effect.succeed({ accounts: [account], agentAccess: true }),
    attempts: Effect.succeed([]),
  } as unknown as AccountsService["Service"];
  const environment = {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env-test")),
  } as unknown as ServerEnvironment["Service"];
  return { operations, broker, accounts, environment };
};

const setup = Effect.fn("setup")(function* (jar: {
  current: ReadonlyArray<ReturnType<typeof cookie>>;
}) {
  const secretsDir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-connector-sessions-")),
  );
  roots.push(secretsDir);
  const { operations, broker, accounts, environment } = fakes(jar);
  const sessions = yield* makeConnectorSessions({ secretsDir }).pipe(
    Effect.provideService(AccountsService, accounts),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.provideService(ServerEnvironment, environment),
  );
  return { sessions, operations, secretsDir };
});

const target = { connectorId: "con_portal0001", accountId: account.accountId, site: SITE };

describe("connector sessions", () => {
  it.effect("hands the program the site's cookies and user agent, and removes them", () =>
    Effect.gen(function* () {
      const jar = { current: [cookie("first-session-value")] };
      const { sessions, secretsDir } = yield* setup(jar);
      const prepared = yield* sessions.prepare(target);
      expect(prepared.environment).toMatchObject({
        SCIENT_SIGN_IN_SITE: SITE,
        SCIENT_SIGN_IN_USER_AGENT: "Mozilla/5.0 Test",
      });
      expect(prepared.hide).toEqual(["first-session-value"]);
      const json = prepared.environment.SCIENT_SIGN_IN_COOKIES!;
      expect(JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(json, "utf8")))).toMatchObject(
        [{ name: "portal_session", value: "first-session-value" }],
      );
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(prepared.environment.SCIENT_SIGN_IN_COOKIES_TXT!, "utf8"),
        ),
      ).toContain("#HttpOnly_portal.example.edu\tFALSE\t/\tTRUE\t0\tportal_session");

      yield* sessions.remove(target.connectorId);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(secretsDir, "connector-sessions")),
        ),
      ).toEqual([]);
    }),
  );

  it.effect("uses a session the profile renewed instead of signing in again", () =>
    Effect.gen(function* () {
      const jar = { current: [cookie("first-session-value")] };
      const { sessions, operations } = yield* setup(jar);
      yield* sessions.prepare(target);
      // The person signed in themselves meanwhile: the profile holds a new session.
      jar.current = [cookie("renewed-session-value")];
      operations.length = 0;
      const renewed = yield* sessions.signInAgain(target);
      expect(renewed.hide).toEqual(["renewed-session-value"]);
      expect(operations).not.toContain("navigate");
      expect(operations.filter((operation) => operation === "open")).toHaveLength(1);
    }),
  );

  it.effect("refuses a sign-in for another site, saying what the person must do", () =>
    Effect.gen(function* () {
      const { sessions } = yield* setup({ current: [] });
      const refused = yield* sessions
        .prepare({ ...target, site: "https://other.example.org" })
        .pipe(Effect.flip);
      expect(refused).toEqual({
        reason: "needs-user",
        message: "Course portal is not a sign-in for other.example.org.",
      });
    }),
  );
});

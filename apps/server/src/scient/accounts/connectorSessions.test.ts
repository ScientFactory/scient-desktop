// @effect-diagnostics nodeBuiltinImport:off -- Reads the session files the module writes in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { AccountId, AccountsError, EnvironmentId, type AccountsSnapshot } from "@t3tools/contracts";
import { cookieValueDigest } from "@t3tools/shared/scientCookieWriteBack";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import { signInDetectionScript } from "./signIn/detection.ts";
import { makeConnectorSessions } from "./connectorSessions.ts";
import type { SiteTransport } from "./websiteRead.ts";

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

/**
 * A browser whose profile holds `jar`; every operation is recorded. `uses` decides each use the
 * moment it acts, as Accounts' gate does.
 */
const fakes = (
  jar: { current: ReadonlyArray<ReturnType<typeof cookie>> },
  uses: { allowed: boolean } = { allowed: true },
  fence: { sequence: number; onOpen?: (opens: number) => void; onJar?: () => void } = {
    sequence: 0,
  },
) => {
  const operations: string[] = [];
  let opens = 0;
  const cookieUrls: string[] = [];
  const broker = {
    invoke: ({ operation, input }: { operation: string; input?: { expression?: string } }) => {
      operations.push(operation);
      // Scient's own sign-in finds the site already signed in.
      if (operation === "evaluate" && input?.expression === signInDetectionScript)
        return Effect.succeed({
          origin: SITE,
          username: null,
          password: null,
          otp: null,
          submit: null,
          challenge: null,
          signedIn: true,
        });
      switch (operation) {
        case "status":
          return Effect.succeed({ tabs: [], defaultProfileId: "default" });
        case "open":
          fence.onOpen?.(++opens);
          return Effect.succeed({ tabId: "tab-1", tabs: [] });
        case "accountCookies": {
          fence.onJar?.();
          const urls = (input as unknown as { readonly urls: ReadonlyArray<string> }).urls;
          cookieUrls.push(...urls);
          // As a browser answers: a cookie whose path covers one of the addresses.
          return Effect.succeed(
            jar.current.filter((found) =>
              urls.some((url) => {
                const path = URL.canParse(url) ? new URL(url).pathname : "/";
                return (
                  found.path === "/" || path === found.path || path.startsWith(`${found.path}/`)
                );
              }),
            ),
          );
        }
        case "accountWriteCookie": {
          const write = input as unknown as {
            readonly name: string;
            readonly expected: string;
            readonly cookie?: ReturnType<typeof cookie>;
          };
          const slot = jar.current.find((found) => found.name === write.name);
          if (slot === undefined) return Effect.succeed({ outcome: "gone" });
          if (cookieValueDigest(slot.value) !== write.expected)
            return Effect.succeed({ outcome: "changed" });
          const others = jar.current.filter((found) => found !== slot);
          jar.current = write.cookie ? [...others, write.cookie] : others;
          return Effect.succeed({ outcome: "written" });
        }
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
    authorizeUse: (scope: { readonly scheduledTaskId?: string }) =>
      uses.allowed && scope.scheduledTaskId !== "task:pinned-elsewhere"
        ? Effect.void
        : Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." })),
    signOutSequence: Effect.sync(() => fence.sequence),
    unlessSignedOutSince: (
      _account: unknown,
      since: number,
      publish: Effect.Effect<void>,
      authorized?: unknown,
    ) =>
      authorized !== undefined && !uses.allowed
        ? Effect.fail(new AccountsError({ reason: "denied", message: "Access changed." }))
        : fence.sequence > since
          ? Effect.succeed(false)
          : Effect.as(publish, true),
    recordUse: () => Effect.void,
  } as unknown as AccountsService["Service"];
  const environment = {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env-test")),
  } as unknown as ServerEnvironment["Service"];
  return { operations, cookieUrls, broker, accounts, environment };
};

const setup = Effect.fn("setup")(function* (
  jar: { current: ReadonlyArray<ReturnType<typeof cookie>> },
  service?: AccountsService["Service"],
  uses?: { allowed: boolean },
  site?: {
    readonly transport: SiteTransport;
    readonly fence: { sequence: number; onOpen?: (opens: number) => void; onJar?: () => void };
  },
) {
  const secretsDir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-connector-sessions-")),
  );
  roots.push(secretsDir);
  const { operations, cookieUrls, broker, accounts, environment } = fakes(jar, uses, site?.fence);
  const sessions = yield* makeConnectorSessions({
    secretsDir,
    ...(site === undefined ? {} : { transport: site.transport }),
  }).pipe(
    Effect.provideService(AccountsService, service ?? accounts),
    Effect.provideService(PreviewAutomationBroker, broker),
    Effect.provideService(ServerEnvironment, environment),
  );
  return { sessions, operations, cookieUrls, secretsDir };
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

  it.effect("hands over no session that access no longer allows when it's written", () =>
    Effect.gen(function* () {
      // Already signed in, and renewed by the profile: both hand over without a sign-in.
      const jar = { current: [cookie("first-session-value")] };
      const uses = { allowed: true };
      const { sessions, secretsDir } = yield* setup(jar, undefined, uses);
      yield* sessions.prepare(target);
      const files = () =>
        Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(secretsDir, "connector-sessions", target.connectorId, "cookies.json"),
            "utf8",
          ),
        );
      uses.allowed = false;
      jar.current = [cookie("renewed-session-value")];
      expect((yield* sessions.signInAgain(target).pipe(Effect.flip)).reason).toBe("needs-user");
      expect(yield* sessions.prepare(target).pipe(Effect.flip)).toMatchObject({
        reason: "needs-user",
      });
      expect(yield* files()).toContain("first-session-value");
    }),
  );

  it.effect("stops a running project-less session once its sign-in is kept to some projects", () =>
    Effect.gen(function* () {
      let scope: { type: "all-projects" } | { type: "projects"; projectIds: Array<string> } = {
        type: "all-projects",
      };
      const fake = fakeAccounts({ values: { password: "synthetic-password" } });
      const service = AccountsService.of({
        ...fake.service,
        snapshot: Effect.sync(
          () =>
            ({
              accounts: [{ ...account, controls: { ...account.controls, scope } }],
              agentAccess: true,
            }) as unknown as AccountsSnapshot,
        ),
      });
      const { sessions } = yield* setup({ current: [cookie("first-session-value")] }, service);
      const running = { connectorId: target.connectorId, accountId: target.accountId, site: SITE };
      expect(yield* sessions.allowed(running)).toBe(true);
      // regression: the session's reuse checked only Off, so a scope edit left it usable.
      scope = { type: "projects", projectIds: ["project-a"] };
      expect(yield* sessions.allowed(running)).toBe(false);
      expect(yield* sessions.allowed({ ...running, projectId: "project-a" as never })).toBe(true);
    }),
  );

  it.effect("hands over no session when the sign-in is turned off while Scient signs in", () =>
    Effect.gen(function* () {
      const jar = { current: [] as ReadonlyArray<ReturnType<typeof cookie>> };
      let access: "allowed" | "off" = "allowed";
      const row = () => ({
        ...account,
        accountId: AccountId.make(account.accountId),
        controls: { ...account.controls, access, permission: "full", visibility: "hidden" },
        status: "ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const fake = fakeAccounts({ values: { password: "synthetic-password" } });
      const service = AccountsService.of({
        ...fake.service,
        snapshot: Effect.sync(
          () => ({ accounts: [row()], agentAccess: true }) as unknown as AccountsSnapshot,
        ),
        // The person turns it off as the sign-in finishes, which left a session in the profile.
        recordUse: () =>
          Effect.sync(() => {
            access = "off";
            jar.current = [cookie("late-session-value")];
          }),
      });
      const { sessions, secretsDir } = yield* setup(jar, service);
      const refused = yield* sessions.prepare(target).pipe(Effect.flip);
      expect(refused).toEqual({
        reason: "needs-user",
        message: "Course portal is turned off in Settings → Accounts & secrets.",
      });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(secretsDir, "connector-sessions")).catch(() => []),
        ),
      ).toEqual([]);
    }),
  );

  it.effect("hands a pinned task's run no session but its pin's", () =>
    Effect.gen(function* () {
      // An empty jar: a use the pin allowed would sign in here.
      const jar: { current: ReadonlyArray<ReturnType<typeof cookie>> } = { current: [] };
      const { sessions, operations } = yield* setup(jar);
      // Accounts refuses this row to that task's run: it is pinned to another sign-in.
      for (const ask of [sessions.prepare, sessions.signInAgain]) {
        const refused = yield* ask({ ...target, scheduledTaskId: "task:pinned-elsewhere" }).pipe(
          Effect.flip,
        );
        // regression: a connector called from a pinned run asked Accounts without the run's task.
        expect(refused.reason).toBe("needs-user");
      }
      // regression: the jar was read and a sign-in started before the pin was asked.
      expect(operations).not.toContain("open");
      expect(operations).not.toContain("accountCookies");
      jar.current = [cookie("first-session-value")];
      yield* sessions.prepare(target);
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

  describe("reads Scient makes for a connector", () => {
    const slot = { cookie: "portal_session", path: "/" };
    const READ = `${SITE}/api/hours`;
    /** The synthetic site: answers each read with `reply`, after `during` runs. */
    const siteWith = (reply: () => Response, during: () => void = () => undefined) => {
      const sent: string[] = [];
      const fence: { sequence: number; onOpen?: (opens: number) => void; onJar?: () => void } = {
        sequence: 0,
      };
      const transport: SiteTransport = async (_url, init) => {
        sent.push(new Headers(init.headers).get("cookie") ?? "");
        during();
        return reply();
      };
      return { sent, fence, transport };
    };
    const rotated = () =>
      new Response('{"hours":8}', {
        headers: [
          ["content-type", "application/json"],
          [
            "set-cookie",
            "portal_session=rotated-session-value; Path=/; Secure; HttpOnly; Max-Age=3600",
          ],
          ["set-cookie", "tracker=1; Path=/"],
        ],
      });

    it.effect("keeps the site's rotation in the profile, so the next start needs no sign-in", () =>
      Effect.gen(function* () {
        const jar = { current: [cookie("first-session-value")] };
        const site = siteWith(rotated);
        const { sessions, operations } = yield* setup(jar, undefined, undefined, site);
        const read = yield* sessions.readWithWebsiteSession(target, slot, READ);
        expect(read).toMatchObject({
          outcome: "ok",
          status: 200,
          body: '{"hours":8}',
          kept: "rotated",
        });
        expect(site.sent).toEqual(["portal_session=first-session-value"]);
        // Only the named slot came back: the tracker made no new cookie.
        expect(jar.current.map((found) => [found.name, found.value])).toEqual([
          ["portal_session", "rotated-session-value"],
        ]);
        const next = yield* sessions.prepare(target);
        expect(next.hide).toEqual(["rotated-session-value"]);
        expect(operations).not.toContain("navigate");
      }),
    );

    it.effect("writes nothing over a sign-out or a newer cookie that came while it read", () =>
      Effect.gen(function* () {
        const jar = { current: [cookie("first-session-value")] };
        const signedOut = siteWith(rotated, () => void (signedOut.fence.sequence += 1));
        const first = yield* setup(jar, undefined, undefined, signedOut);
        // A sign-out while the read was out: its answer and its rotation go nowhere.
        expect(
          (yield* first.sessions.readWithWebsiteSession(target, slot, READ).pipe(Effect.flip))
            .reason,
        ).toBe("needs-user");
        expect(jar.current[0]?.value).toBe("first-session-value");

        // The person's browser renewed the session while Scient's read was out.
        const renewed = siteWith(rotated, () => void (jar.current = [cookie("browser-value")]));
        const second = yield* setup(jar, undefined, undefined, renewed);
        expect(yield* second.sessions.readWithWebsiteSession(target, slot, READ)).toMatchObject({
          kept: "newer",
        });
        expect(jar.current[0]?.value).toBe("browser-value");
      }),
    );

    it.effect("tells a site it couldn't reach from one that signed the session out", () =>
      Effect.gen(function* () {
        const jar = { current: [cookie("first-session-value")] };
        const down = siteWith(() => {
          throw new TypeError("fetch failed");
        });
        const { sessions, operations } = yield* setup(jar, undefined, undefined, down);
        expect(yield* sessions.readWithWebsiteSession(target, slot, READ)).toEqual({
          outcome: "unreachable",
          kept: "unchanged",
        });
        expect(operations).not.toContain("navigate");

        const gone = siteWith(
          () =>
            new Response(null, {
              status: 302,
              headers: [
                ["location", "/login?next=%2Fapi%2Fhours"],
                ["set-cookie", "portal_session=anonymous; Path=/; Secure; HttpOnly"],
              ],
            }),
        );
        const again = yield* setup(jar, undefined, undefined, gone);
        expect(yield* again.sessions.readWithWebsiteSession(target, slot, READ)).toMatchObject({
          outcome: "signed-out",
          kept: "refused",
        });
        expect(jar.current[0]?.value).toBe("first-session-value");
      }),
    );

    it.effect(
      "reads the jar for the request itself, so a session cookie at a deeper path counts",
      () =>
        Effect.gen(function* () {
          const deep = { ...cookie("first-session-value"), path: "/api" };
          const jar = { current: [deep] };
          const site = siteWith(
            () =>
              new Response("{}", {
                headers: [["set-cookie", "portal_session=rotated; Path=/api; Secure; HttpOnly"]],
              }),
          );
          const { sessions, cookieUrls } = yield* setup(jar, undefined, undefined, site);
          expect(
            yield* sessions.readWithWebsiteSession(
              target,
              { cookie: "portal_session", path: "/api" },
              READ,
            ),
          ).toMatchObject({ kept: "rotated" });
          // regression: the jar was read for the site's root, which a cookie at /api isn't sent to.
          expect(cookieUrls).toContain(READ);
        }),
    );

    it.effect("makes a read with no named cookie, and writes nothing back", () =>
      Effect.gen(function* () {
        const jar = { current: [cookie("first-session-value")] };
        const site = siteWith(rotated);
        const { sessions } = yield* setup(jar, undefined, undefined, site);
        expect(yield* sessions.readWithWebsiteSession(target, undefined, READ)).toMatchObject({
          outcome: "ok",
          kept: "unchanged",
        });
        expect(site.sent).toEqual(["portal_session=first-session-value"]);
        expect(jar.current[0]?.value).toBe("first-session-value");
      }),
    );

    it.effect("sends nothing once access changed, even for a read that waited its turn", () =>
      Effect.gen(function* () {
        const jar = { current: [cookie("first-session-value")] };
        const uses = { allowed: true };
        const release = Promise.withResolvers<void>();
        const reached = Promise.withResolvers<void>();
        const sent: string[] = [];
        const site = {
          fence: { sequence: 0 },
          transport: (async (_url, init) => {
            sent.push(new Headers(init.headers).get("cookie") ?? "");
            reached.resolve();
            await release.promise;
            return rotated();
          }) satisfies SiteTransport,
        };
        const { sessions } = yield* setup(jar, undefined, uses, site);
        const first = yield* sessions
          .readWithWebsiteSession(target, slot, READ)
          .pipe(Effect.flip, Effect.forkChild);
        const queued = yield* sessions
          .readWithWebsiteSession(target, slot, READ)
          .pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => reached.promise);
        // The person turns it off while the first read is out and the second waits behind it.
        uses.allowed = false;
        release.resolve();
        // regression: the second read was allowed before it waited, so it went out after Off.
        expect(sent).toHaveLength(1);
        expect((yield* Fiber.join(first)).reason).toBe("needs-user");
        expect((yield* Fiber.join(queued)).reason).toBe("needs-user");
        // The first read's answer and its rotation went nowhere.
        expect(jar.current[0]?.value).toBe("first-session-value");
      }),
    );

    it.effect(
      "sends nothing after a sign-out during the jar read, and withholds a fenced commit",
      () =>
        Effect.gen(function* () {
          const jar = { current: [cookie("first-session-value")] };
          const during = siteWith(rotated);
          // regression: a sign-out while the cookies were read was only noticed after the GET.
          during.fence.onJar = () => void (during.fence.sequence += 1);
          const first = yield* setup(jar, undefined, undefined, during);
          expect(
            (yield* first.sessions.readWithWebsiteSession(target, slot, READ).pipe(Effect.flip))
              .reason,
          ).toBe("needs-user");
          expect(during.sent).toEqual([]);

          // A sign-out that lands as the rotation is committed: its tab is the read's second.
          const atCommit = siteWith(rotated);
          atCommit.fence.onOpen = (opens) => {
            if (opens === 2) atCommit.fence.sequence += 1;
          };
          const second = yield* setup(jar, undefined, undefined, atCommit);
          // regression: the fenced commit still handed the site's answer to the program.
          expect(
            (yield* second.sessions.readWithWebsiteSession(target, slot, READ).pipe(Effect.flip))
              .reason,
          ).toBe("needs-user");
          expect(jar.current[0]?.value).toBe("first-session-value");
        }),
    );

    it.effect(
      "lets a minted token stand through rotation, never a sign-out or another session",
      () =>
        Effect.gen(function* () {
          const jar = {
            current: [cookie("first-session-value"), { ...cookie("u1"), name: "user" }],
          };
          const site = siteWith(rotated);
          const { sessions } = yield* setup(jar, undefined, undefined, site);
          const mark = yield* sessions.sessionMark(target, slot, READ);
          // The read rotates the slot: still the session the token was minted from.
          yield* sessions.readWithWebsiteSession(target, slot, READ);
          expect(yield* sessions.sessionStands(target, slot, mark)).toBe("stands");
          // Someone else signs in in the profile.
          jar.current = [cookie("rotated-session-value"), { ...cookie("u2"), name: "user" }];
          // regression: a token minted from the replaced session still went out.
          expect(yield* sessions.sessionStands(target, slot, mark)).toBe("changed");
          // Only the session cookie is someone else's: a slot Scient didn't rotate is a new one.
          jar.current = [cookie("someone-elses-session"), { ...cookie("u1"), name: "user" }];
          // regression: the slot was left out of the digest, so this kept the old token going.
          expect(yield* sessions.sessionStands(target, slot, mark)).toBe("changed");
          jar.current = [cookie("rotated-session-value"), { ...cookie("u1"), name: "user" }];
          expect(yield* sessions.sessionStands(target, slot, mark)).toBe("stands");
          // A sign-out while the jar is read refuses.
          site.fence.onJar = () => void (site.fence.sequence += 1);
          // regression: the fence was asked only before the jar read.
          expect(yield* sessions.sessionStands(target, slot, mark)).toBe("refused");
          delete site.fence.onJar;
          // A sign-out since the mint refuses outright, whatever the profile holds.
          expect(yield* sessions.sessionStands(target, slot, mark)).toBe("refused");
        }),
    );

    it.effect("binds a token to the session cookie at the minting page's own path", () =>
      Effect.gen(function* () {
        const deep = { cookie: "portal_session", path: "/api" };
        const at = (value: string) => ({ ...cookie(value), path: "/api" });
        const jar = { current: [at("first-session-value"), { ...cookie("u1"), name: "user" }] };
        const { sessions } = yield* setup(jar, undefined, undefined, siteWith(rotated));
        const mark = yield* sessions.sessionMark(target, deep, READ);
        // Someone else's session in the slot under /api only.
        jar.current = [at("someone-elses-session"), { ...cookie("u1"), name: "user" }];
        // regression: the site root was read, which never sees the /api cookie.
        expect(yield* sessions.sessionStands(target, deep, mark)).toBe("changed");
      }),
    );
  });
});

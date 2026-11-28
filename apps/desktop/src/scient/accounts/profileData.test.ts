// @effect-diagnostics nodeBuiltinImport:off -- Temporary folders stand in for the app's state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as Electron from "electron";
import type { CdpCookie, CdpSend } from "@t3tools/shared/scientSessionCookies";
import { expect, it } from "vite-plus/test";
import { resolvePartitionScope } from "../../ipc/methods/preview.ts";
import { accountsSessionIdentity, rememberAccountsSession } from "./sessionIdentity.ts";
import {
  copyProfileCookies,
  undoProfileCopy,
  sealSignOut,
  signOutSiteKept,
  loadProfileGenerations,
  profileGeneration,
  restoreSignOutCookies,
  setProfileGenerations,
  setSaveDeadlines,
  sweepSignOutSaves,
} from "./profileData.ts";

const stateDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-profile-data-"));

it("opens a cleared profile in a new partition and keeps the choice across restarts", () => {
  const dir = stateDir();
  loadProfileGenerations(dir);
  const first = resolvePartitionScope("env-local", "profile-lab");
  expect(setProfileGenerations("env-local", { "profile-lab": 1, "": 0 })).toBe(true);
  expect(setProfileGenerations("env-local", { "profile-lab": 1 })).toBe(false);
  const cleared = resolvePartitionScope("env-local", "profile-lab");
  expect(cleared.scope).not.toBe(first.scope);
  expect(cleared).toEqual({
    scope: JSON.stringify(["env-local", "profile-lab", 1]),
    persistent: true,
    namespace: "profile",
  });
  // Main too, and the generation before stays reachable for Undo and the purge.
  setProfileGenerations("env-local", { "profile-lab": 1, default: 2 });
  expect(resolvePartitionScope("env-local", "default").scope).toBe(
    JSON.stringify(["env-local", "default", 2]),
  );
  expect(resolvePartitionScope("env-local", "profile-lab", 0)).toEqual(first);
  // A restarted app reads the same.
  setProfileGenerations("env-local", {});
  loadProfileGenerations(dir);
  expect(profileGeneration("env-local", "default")).toBe(0);
  setProfileGenerations("env-local", { default: 2 });
  loadProfileGenerations(dir);
  expect(profileGeneration("env-local", "default")).toBe(2);
  // The partition still belongs to its profile, for capture and fills.
  const session = {} as Electron.Session;
  rememberAccountsSession(session, cleared.scope, true, "profile");
  expect(accountsSessionIdentity(session)).toEqual({
    environmentId: "env-local",
    profileId: "profile-lab",
    persistent: true,
  });
});

const cdpJar = (cookies: ReadonlyArray<Partial<CdpCookie> & { name: string; domain: string }>) => {
  const jar: CdpCookie[] = cookies.map((cookie) => ({
    value: "",
    path: "/",
    expires: -1,
    session: true,
    secure: true,
    httpOnly: true,
    ...cookie,
  }));
  const same = (a: Partial<CdpCookie>, b: Partial<CdpCookie>) =>
    a.name === b.name &&
    a.domain === b.domain &&
    (a.path ?? "/") === (b.path ?? "/") &&
    JSON.stringify(a.partitionKey ?? null) === JSON.stringify(b.partitionKey ?? null);
  const send: CdpSend = async (method, params) => {
    if (method === "Network.getAllCookies") return { cookies: jar.map((c) => ({ ...c })) };
    if (method === "Network.setCookies") {
      for (const param of (params as { cookies: Array<Record<string, unknown>> }).cookies) {
        if (param.name === "refused") throw new Error("refused");
        const cookie = {
          name: param.name as string,
          value: param.value as string,
          domain: (param.domain as string | undefined) ?? new URL(param.url as string).hostname,
          path: (param.path as string | undefined) ?? "/",
          expires: (param.expires as number | undefined) ?? -1,
          session: param.expires === undefined,
          secure: param.secure === true,
          httpOnly: param.httpOnly === true,
          ...(param.partitionKey
            ? { partitionKey: param.partitionKey as CdpCookie["partitionKey"] }
            : {}),
        };
        const at = jar.findIndex((c) => same(c, cookie));
        if (at >= 0) jar.splice(at, 1, cookie);
        else jar.push(cookie);
      }
      return {};
    }
    if (method === "Network.deleteCookies") {
      const gone = params as Partial<CdpCookie>;
      const at = jar.findIndex((c) => same(c, gone));
      if (at >= 0) jar.splice(at, 1);
      return {};
    }
    throw new Error(`unexpected ${method}`);
  };
  return { jar, send };
};
const inSite = (cookie: { readonly domain: string }, site: string) =>
  cookie.domain.replace(/^\./, "") === site || cookie.domain.endsWith(`.${site}`);
const values = (jar: ReadonlyArray<CdpCookie>) =>
  jar
    .map(({ name, domain, value, partitionKey }) =>
      [name, domain, value, typeof partitionKey === "object" ? partitionKey.topLevelSite : ""].join(
        " ",
      ),
    )
    .toSorted();

it("copies only what the source has, over the same cookies, partitions kept apart", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (b: Buffer) => b.toString(),
  };
  const embed = { topLevelSite: "https://embed.test", hasCrossSiteAncestor: true };
  const lab = cdpJar([
    { name: "sid", value: "lab-session", domain: ".example.com" },
    // The same name in a partition: its own cookie, carried with its partition.
    { name: "sid", value: "lab-embedded", domain: ".example.com", partitionKey: embed },
    { name: "refused", value: "x", domain: ".example.com" },
    // One Scient can't write back exactly stays, and its site is named.
    { name: "opaque", value: "x", domain: ".partly.org", partitionKeyOpaque: true },
    { name: "other", value: "keep", domain: ".other.org" },
  ]);
  const home = cdpJar([
    { name: "sid", value: "home-session", domain: ".example.com" },
    // Only the destination's: it stays.
    { name: "pref", value: "home-pref", domain: ".example.com" },
    { name: "kept", value: "home-only", domain: ".missing.org" },
  ]);
  const moved = await copyProfileCookies({
    stateDir: dir,
    operationId: "op-move",
    from: lab.send,
    into: home.send,
    sites: ["example.com", "partly.org", "missing.org"],
    inSite,
    move: true,
    crypto,
  });
  expect(moved).toEqual({
    copied: 2,
    uncovered: expect.arrayContaining(["partly.org", "missing.org", "example.com"]),
  });
  expect(values(home.jar)).toEqual([
    "kept .missing.org home-only ",
    "pref .example.com home-pref ",
    "sid .example.com lab-embedded https://embed.test",
    "sid .example.com lab-session ",
  ]);
  // The source keeps what wasn't chosen and what can't be carried; and since one of
  // example.com's cookies was refused, all of example.com stays there, unsplit (round 6d).
  const unsplit = [
    "opaque .partly.org x ",
    "other .other.org keep ",
    "refused .example.com x ",
    "sid .example.com lab-embedded https://embed.test",
    "sid .example.com lab-session ",
  ];
  expect(values(lab.jar)).toEqual(unsplit);
  // A page signs in again in Home's partition meanwhile: that newer cookie stays.
  const signedIn = home.jar.findIndex((c) => c.partitionKey === undefined && c.name === "sid");
  home.jar.splice(signedIn, 1, { ...home.jar[signedIn]!, value: "home-newer" });
  const undone = await undoProfileCopy({
    stateDir: dir,
    operationId: "op-move",
    from: lab.send,
    into: home.send,
    decrypt: crypto.decrypt,
  });
  expect(undone).toEqual({ restored: 0, refused: 0, newer: 1 });
  expect(values(home.jar)).toEqual([
    "kept .missing.org home-only ",
    "pref .example.com home-pref ",
    "sid .example.com home-newer ",
  ]);
  // Nothing was taken from the source, so nothing goes back to it.
  expect(values(lab.jar)).toEqual(unsplit);
  // Without the system's encryption nothing is copied.
  expect(
    await copyProfileCookies({
      stateDir: dir,
      operationId: "op-plain",
      from: lab.send,
      into: home.send,
      sites: undefined,
      inSite,
      move: false,
      crypto: undefined,
    }),
  ).toBeNull();
});

it("keeps what a copy replaces before it writes anything", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (b: Buffer) => b.toString(),
  };
  const lab = cdpJar([{ name: "sid", value: "lab-session", domain: ".example.com" }]);
  const home = cdpJar([{ name: "sid", value: "home-session", domain: ".example.com" }]);
  // The app stops at the first write: the save is already there for Undo.
  const atFirstWrite: Array<ReadonlyArray<string>> = [];
  const stopping: CdpSend = async (method, params) => {
    if (method === "Network.setCookies") {
      const saves = NodePath.join(dir, "scient-sign-outs");
      const sealed = NodeFS.existsSync(saves)
        ? (
            JSON.parse(
              NodeFS.readFileSync(
                NodePath.join(
                  saves,
                  NodeFS.readdirSync(saves).find((name) => name.endsWith(".bin"))!,
                ),
              ).toString(),
            ) as { before: Array<{ value: string }> }
          ).before.map(({ value }) => value)
        : [];
      atFirstWrite.push(sealed);
      throw new Error("stopped");
    }
    return home.send(method, params);
  };
  expect(
    await copyProfileCookies({
      stateDir: dir,
      operationId: "op-stop",
      from: lab.send,
      into: stopping,
      sites: ["example.com"],
      inSite,
      move: false,
      crypto,
    }),
  ).toEqual({ copied: 0, uncovered: ["example.com"] });
  expect(atFirstWrite).toEqual([["home-session"]]);
  expect(values(home.jar)).toEqual(["sid .example.com home-session "]);
});

it("signs a site out with its partitioned cookies, keeps them for Undo, names what it can't reach", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(`sealed:${plain}`),
    decrypt: (sealed: Buffer) => sealed.toString().replace(/^sealed:/, ""),
  };
  const embed = { topLevelSite: "https://embed.test", hasCrossSiteAncestor: true };
  const lab = cdpJar([
    { name: "sid", value: "lab-session", domain: ".example.com" },
    // regression: Electron's cookie API missed this one, so it outlived the sign-out.
    { name: "sid", value: "lab-embedded", domain: ".example.com", partitionKey: embed },
    { name: "opaque", value: "x", domain: ".example.com", partitionKeyOpaque: true },
    { name: "other", value: "keep", domain: ".other.org" },
  ]);
  const out = await signOutSiteKept({
    stateDir: dir,
    operationId: "op-out",
    send: lab.send,
    site: "example.com",
    inSite,
    encrypt: crypto.encrypt,
  });
  expect(out).toEqual({ signedOut: true, saved: 2, notRestorable: 0, leftBehind: 1 });
  expect(values(lab.jar)).toEqual(["opaque .example.com x ", "other .other.org keep "]);
  // No cookie value sits in a plain file (the deadlines beside them hold none).
  const files = NodeFS.readdirSync(NodePath.join(dir, "scient-sign-outs")).filter((name) =>
    name.endsWith(".bin"),
  );
  expect(NodeFS.readFileSync(NodePath.join(dir, "scient-sign-outs", files[0]!)).toString()).toMatch(
    /^sealed:/,
  );
  // The site sets its session again since: that newer one stays; the partitioned one comes back.
  await lab.send("Network.setCookies", {
    cookies: [
      {
        name: "sid",
        value: "newer",
        domain: ".example.com",
        path: "/",
        url: "https://example.com/",
      },
    ],
  });
  expect(await restoreSignOutCookies(dir, "op-out", lab.send, crypto.decrypt)).toEqual({
    restored: 1,
    refused: 0,
    newer: 1,
  });
  expect(values(lab.jar)).toEqual([
    "opaque .example.com x ",
    "other .other.org keep ",
    "sid .example.com lab-embedded https://embed.test",
    "sid .example.com newer ",
  ]);
  // Undone once: the save is gone. Without a protected store nothing is kept, and it says so.
  expect(await restoreSignOutCookies(dir, "op-out", lab.send, crypto.decrypt)).toBeNull();
  const plain = await signOutSiteKept({
    stateDir: dir,
    operationId: "op-plain",
    send: lab.send,
    site: "example.com",
    inSite,
    encrypt: undefined,
  });
  expect(plain).toMatchObject({ saved: 0, notRestorable: 2 });
  keepSaveForSweep(dir);
});

/** A save made now is kept for its hour, and swept after it. */
function keepSaveForSweep(dir: string) {
  sealSignOut(dir, "op-old", [], (plain) => Buffer.from(plain));
  const cookie = {
    name: "sid",
    value: "x",
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
  };
  sealSignOut(dir, "op-old", [cookie], (plain) => Buffer.from(plain));
  const saved = NodePath.join(dir, "scient-sign-outs", `${encodeURIComponent("op-old")}.bin`);
  const made = NodeFS.statSync(saved).mtimeMs;
  // Its receipt is still under way: kept however old, a restart's sweep included (round 6e).
  setSaveDeadlines(dir, { "op-old": null }, made);
  sweepSignOutSaves(dir, made + 3 * 60 * 60 * 1000);
  // regression: the sweep went by the file's age, an hour, before the receipt's Undo ended.
  expect(NodeFS.existsSync(saved)).toBe(true);
  // Settled late: its hour runs from then, and the save goes only past it.
  const until = made + 5 * 60 * 60 * 1000;
  setSaveDeadlines(dir, { "op-old": until }, made + 4 * 60 * 60 * 1000);
  sweepSignOutSaves(dir, until - 1);
  expect(NodeFS.existsSync(saved)).toBe(true);
  sweepSignOutSaves(dir, until + 1);
  expect(NodeFS.existsSync(saved)).toBe(false);
  // A save no deadline was ever kept for (an older build's) goes after a week; one this build
  // writes is under way from the start (round 6f).
  const unseen = NodePath.join(dir, "scient-sign-outs", "op-unseen.bin");
  NodeFS.writeFileSync(unseen, "sealed");
  const unseenAt = NodeFS.statSync(unseen).mtimeMs;
  sweepSignOutSaves(dir, unseenAt + 2 * 60 * 60 * 1000);
  expect(NodeFS.existsSync(unseen)).toBe(true);
  sweepSignOutSaves(dir, unseenAt + 8 * 24 * 60 * 60 * 1000);
  expect(NodeFS.existsSync(unseen)).toBe(false);
}

it("keeps its first seal when a copy is run again after a restart", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (b: Buffer) => b.toString(),
  };
  const lab = cdpJar([{ name: "sid", value: "lab-session", domain: ".example.com" }]);
  const home = cdpJar([{ name: "sid", value: "home-session", domain: ".example.com" }]);
  const copy = () =>
    copyProfileCookies({
      stateDir: dir,
      operationId: "op-again",
      from: lab.send,
      into: home.send,
      sites: ["example.com"],
      inSite,
      move: false,
      crypto,
    });
  await copy();
  // The app stopped before it reported; the copy runs again over a jar that holds the copy now.
  await copy();
  const undone = await undoProfileCopy({
    stateDir: dir,
    operationId: "op-again",
    from: lab.send,
    into: home.send,
    decrypt: crypto.decrypt,
  });
  expect(undone).toEqual({ restored: 1, refused: 0 });
  // Home's own session is back, not the copy the second run took for "before".
  expect(values(home.jar)).toEqual(["sid .example.com home-session "]);
});

it("removes on Undo a session a retried copy brought where there was none (round 6e)", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (b: Buffer) => b.toString(),
  };
  const lab = cdpJar([{ name: "sid", value: "lab-session", domain: ".example.com" }]);
  // Home has no session for the site: the copy brings one.
  const home = cdpJar([]);
  const copy = () =>
    copyProfileCookies({
      stateDir: dir,
      operationId: "op-absent",
      from: lab.send,
      into: home.send,
      sites: ["example.com"],
      inSite,
      move: false,
      crypto,
    });
  await copy();
  // Restarted before it reported: run again over a jar holding the copy.
  await copy();
  await undoProfileCopy({
    stateDir: dir,
    operationId: "op-absent",
    from: lab.send,
    into: home.send,
    decrypt: crypto.decrypt,
  });
  // regression: the retry sealed the copy as Home's "before", and Undo put it back.
  expect(values(home.jar)).toEqual([]);
});

it("moves no part of a site whose sign-in has a cookie that can't come over (round 6e)", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (b: Buffer) => b.toString(),
  };
  const lab = cdpJar([
    { name: "sid", value: "lab-session", domain: ".example.com" },
    { name: "opaque", value: "x", domain: ".example.com", partitionKeyOpaque: true },
    { name: "sid", value: "other-session", domain: ".other.org" },
  ]);
  const home = cdpJar([]);
  const moved = await copyProfileCookies({
    stateDir: dir,
    operationId: "op-move",
    from: lab.send,
    into: home.send,
    sites: undefined,
    inSite,
    move: true,
    crypto,
  });
  expect(moved?.uncovered).toEqual(["example.com"]);
  // regression: example.com's session left Lab without its opaque cookie: a split sign-in.
  expect(values(lab.jar)).toEqual(["opaque .example.com x ", "sid .example.com lab-session "]);
});

it("refuses a retried copy over a cookie someone set since its intent was kept (round 6f)", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (b: Buffer) => b.toString(),
  };
  const lab = cdpJar([{ name: "sid", value: "lab-session", domain: ".example.com" }]);
  const home = cdpJar([]);
  const copy = (mayWrite?: () => Promise<boolean>) =>
    copyProfileCookies({
      stateDir: dir,
      operationId: "op-intent",
      from: lab.send,
      into: home.send,
      sites: ["example.com"],
      inSite,
      move: false,
      crypto,
      ...(mayWrite ? { mayWrite } : {}),
    });
  // Its intent kept, then stopped before it wrote (as a crash would).
  expect(await copy(async () => false)).toBeNull();
  // The site signs Home in on its own meanwhile.
  await home.send("Network.setCookies", {
    cookies: [{ name: "sid", value: "home-own", domain: ".example.com", path: "/" }],
  });
  // regression: the retry took Home's new cookie for its own write, and Undo would remove it.
  expect(await copy()).toBeNull();
  expect(values(home.jar)).toEqual(["sid .example.com home-own "]);
});

it("keeps a save its desktop never heard a deadline for while its work goes on (round 6f)", () => {
  const dir = stateDir();
  const cookie = {
    name: "sid",
    value: "x",
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax" as const,
  };
  sealSignOut(dir, "op-unheard", [cookie], (plain) => Buffer.from(plain));
  const save = NodePath.join(dir, "scient-sign-outs", "op-unheard.bin");
  // A week and a day on, its receipt's deadline still untold: it is still under way.
  sweepSignOutSaves(dir, NodeFS.statSync(save).mtimeMs + 8 * 24 * 60 * 60 * 1000);
  // regression: an unseen pending save aged out after a week.
  expect(NodeFS.existsSync(save)).toBe(true);
});

it("never overwrites, on a retry, a cookie the destination had and the site changed since (6h)", async () => {
  const dir = stateDir();
  const crypto = {
    encrypt: (plain: string) => Buffer.from(plain),
    decrypt: (b: Buffer) => b.toString(),
  };
  const lab = cdpJar([{ name: "sid", value: "lab-session", domain: ".example.com" }]);
  // Home had its own session before the copy.
  const home = cdpJar([{ name: "sid", value: "home-old", domain: ".example.com" }]);
  const copy = (mayWrite?: () => Promise<boolean>) =>
    copyProfileCookies({
      stateDir: dir,
      operationId: "op-prior",
      from: lab.send,
      into: home.send,
      sites: ["example.com"],
      inSite,
      move: false,
      crypto,
      ...(mayWrite ? { mayWrite } : {}),
    });
  expect(await copy(async () => false)).toBeNull();
  // The site signs Home in again after the copy's intent was kept.
  await home.send("Network.setCookies", {
    cookies: [{ name: "sid", value: "home-newer", domain: ".example.com", path: "/" }],
  });
  // regression: the retry overwrote Home's newer session with the copy.
  expect(await copy()).toBeNull();
  expect(values(home.jar)).toEqual(["sid .example.com home-newer "]);
});

it.each([
  // The site renews its session at the same value, with an expiry.
  ["renewed", true],
  // The person signs Home out of the site.
  ["signed out", false],
])(
  "never writes again, on a retry, over its confirmed copy %s since (6i)",
  async (_since, renewed) => {
    const dir = stateDir();
    const crypto = {
      encrypt: (plain: string) => Buffer.from(plain),
      decrypt: (b: Buffer) => b.toString(),
    };
    const lab = cdpJar([{ name: "sid", value: "lab-session", domain: ".example.com" }]);
    const home = cdpJar([]);
    const copy = () =>
      copyProfileCookies({
        stateDir: dir,
        operationId: "op-written",
        from: lab.send,
        into: home.send,
        sites: ["example.com"],
        inSite,
        move: false,
        crypto,
      });
    expect(await copy()).toMatchObject({ copied: 1 });
    if (renewed)
      await home.send("Network.setCookies", {
        cookies: [
          {
            name: "sid",
            value: "lab-session",
            domain: ".example.com",
            path: "/",
            expires: 4_100_000_000,
            secure: true,
            httpOnly: true,
          },
        ],
      });
    else
      await home.send("Network.deleteCookies", { name: "sid", domain: ".example.com", path: "/" });
    const left = values(home.jar);
    // regression: same value, or nothing there, passed for the copy's own write.
    expect(await copy()).toBeNull();
    expect(values(home.jar)).toEqual(left);
  },
);

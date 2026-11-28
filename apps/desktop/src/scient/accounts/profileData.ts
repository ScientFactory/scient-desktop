// @effect-diagnostics nodeBuiltinImport:off -- A small state file and sign-out saves, read at start.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { SessionCookie } from "@t3tools/contracts";
import { siteOf } from "@t3tools/shared/scientSiteMatch";
import {
  deleteCookies,
  readJar,
  sameCookie as sameEveryAttribute,
  sessionCookieFromCdp,
  setCookies,
  type CdpCookie,
  type CdpSend,
} from "@t3tools/shared/scientSessionCookies";

/**
 * Round 6b: which generation each profile's partition is in, per environment, as its Accounts last
 * said. Clear moves a profile to a new partition and keeps the old one for Undo, so no data is
 * copied or deleted until the hour ends.
 */
const generations = new Map<string, ReadonlyMap<string, number>>();
let stateFile: string | undefined;

export function loadProfileGenerations(stateDir: string) {
  stateFile = NodePath.join(stateDir, "scient-profile-generations.json");
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(stateFile, "utf8")) as Record<
      string,
      Record<string, number>
    >;
    for (const [environmentId, byProfile] of Object.entries(parsed))
      generations.set(
        environmentId,
        new Map(
          Object.entries(byProfile).filter(
            ([, generation]) => Number.isInteger(generation) && generation > 0,
          ),
        ),
      );
  } catch {
    // None yet: every profile is in its first generation.
  }
}

export function profileGeneration(environmentId: string, profileId: string) {
  return generations.get(environmentId)?.get(profileId) ?? 0;
}

/** Whether anything changed; then the state file is written again. */
export function setProfileGenerations(
  environmentId: string,
  next: Readonly<Record<string, number>>,
) {
  const kept = new Map(
    Object.entries(next).filter(([, generation]) => Number.isInteger(generation) && generation > 0),
  );
  const before = generations.get(environmentId);
  if (
    before?.size === kept.size &&
    [...kept].every(([profileId, generation]) => before.get(profileId) === generation)
  )
    return false;
  generations.set(environmentId, kept);
  if (stateFile) {
    const serial = Object.fromEntries(
      [...generations].map(([id, byProfile]) => [id, Object.fromEntries(byProfile)]),
    );
    NodeFS.writeFileSync(stateFile, JSON.stringify(serial), { mode: 0o600 });
  }
  return true;
}

const savesDir = (stateDir: string) => NodePath.join(stateDir, "scient-sign-outs");
const saveFile = (stateDir: string, operationId: string) =>
  NodePath.join(savesDir(stateDir), `${encodeURIComponent(operationId)}.bin`);

/** The cookies a sign-out will remove, kept encrypted for the hour; how many could be kept. */
export function sealSignOut(
  stateDir: string,
  operationId: string,
  cookies: ReadonlyArray<SessionCookie>,
  encrypt: ((plain: string) => Buffer) | undefined,
) {
  // Without a protected store nothing is kept: no cookie values in plain files.
  if (!encrypt || cookies.length === 0) return { saved: 0, notRestorable: cookies.length };
  NodeFS.mkdirSync(savesDir(stateDir), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(saveFile(stateDir, operationId), encrypt(JSON.stringify(cookies)), {
    mode: 0o600,
  });
  pendingSave(stateDir, operationId);
  return { saved: cookies.length, notRestorable: 0 };
}

/**
 * A site sign-out with Undo, through the partition's CDP so partitioned cookies go too (round
 * 6d): kept first, then removed. One in an opaque partition can't be reached; it is counted.
 */
export async function signOutSiteKept(options: {
  readonly stateDir: string;
  readonly operationId: string;
  readonly send: CdpSend;
  readonly site: string;
  readonly inSite: (cookie: Pick<SessionCookie, "domain">, site: string) => boolean;
  readonly encrypt: ((plain: string) => Buffer) | undefined;
  readonly mayWrite?: MayWrite;
}) {
  const { stateDir, operationId, send, site, inSite, encrypt } = options;
  const raw = (
    (await send("Network.getAllCookies")) as { readonly cookies: ReadonlyArray<CdpCookie> }
  ).cookies.filter((cookie) => inSite(cookie, site));
  const exact: SessionCookie[] = [];
  let leftBehind = 0;
  for (const cookie of raw) {
    const converted = sessionCookieFromCdp(cookie);
    if ("unsupported" in converted) leftBehind++;
    else exact.push(converted);
  }
  const kept = sealSignOut(stateDir, operationId, exact, encrypt);
  if (!(await allowed(options.mayWrite))) return null;
  await deleteCookies(send, exact);
  return { signedOut: true, ...kept, ...(leftBehind ? { leftBehind } : {}) };
}

/** Sets a sign-out's cookies back, partitions kept, never over one set again since; the save goes. */
export async function restoreSignOutCookies(
  stateDir: string,
  operationId: string,
  send: CdpSend,
  decrypt: (encrypted: Buffer) => string,
  mayWrite?: MayWrite,
) {
  const file = saveFile(stateDir, operationId);
  if (!NodeFS.existsSync(file)) return null;
  const saved = JSON.parse(decrypt(NodeFS.readFileSync(file))) as ReadonlyArray<SessionCookie>;
  // A cookie the site set again since is a newer sign-in: it stays as it is.
  const present = new Set((await readJar(send)).cookies.map(jarKey));
  if (!(await allowed(mayWrite))) return null;
  let restored = 0;
  let refused = 0;
  let newer = 0;
  for (const cookie of saved) {
    if (present.has(jarKey(cookie))) {
      newer++;
      continue;
    }
    await setCookies(send, [cookie]).then(
      () => restored++,
      () => refused++,
    );
  }
  NodeFS.rmSync(file, { force: true });
  return { restored, refused, ...(newer ? { newer } : {}) };
}

/**
 * Each operation's Undo deadline, as its computer's Accounts records it: a time, or null while the
 * operation is still under way (its hour hasn't begun). Saves go by these, never by their age.
 */
const DEADLINES = "deadlines.json";
/** A save whose receipt this desktop never saw (its list unwritable): kept a week, then gone. */
const UNSEEN_SAVE_MS = 7 * 24 * 60 * 60 * 1000;
const readDeadlines = (stateDir: string): Record<string, number | null> => {
  try {
    return JSON.parse(
      NodeFS.readFileSync(NodePath.join(savesDir(stateDir), DEADLINES), "utf8"),
    ) as Record<string, number | null>;
  } catch {
    return {};
  }
};
const operationOfSave = (name: string) =>
  decodeURIComponent(name.replace(/\.bin$/u, "")).split("#")[0]!;

/**
 * A save is under way from the moment it is written (round 6f): kept, its deadline unknown,
 * until its receipt's own deadline is told. A save is never "unseen" while its work goes on.
 */
const pendingSave = (stateDir: string, operationId: string) => {
  const deadlines = readDeadlines(stateDir);
  if (operationId in deadlines) return;
  NodeFS.writeFileSync(
    NodePath.join(savesDir(stateDir), DEADLINES),
    JSON.stringify({ ...deadlines, [operationId]: null }),
    { mode: 0o600 },
  );
};

/** Records the receipts' Undo deadlines (round 6e), then lets go of the saves past theirs. */
export function setSaveDeadlines(
  stateDir: string,
  deadlines: Readonly<Record<string, number | null>>,
  now: number,
) {
  const next = { ...readDeadlines(stateDir), ...deadlines };
  NodeFS.mkdirSync(savesDir(stateDir), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(savesDir(stateDir), DEADLINES), JSON.stringify(next), {
    mode: 0o600,
  });
  sweepSignOutSaves(stateDir, now);
}

/**
 * Saves past their receipt's Undo deadline go, also those an app that was closed then left behind.
 * A save whose operation is still under way stays, however old (round 6e).
 */
export function sweepSignOutSaves(stateDir: string, now: number) {
  const dir = savesDir(stateDir);
  const deadlines = readDeadlines(stateDir);
  const kept = new Set<string>();
  for (const name of NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : []) {
    if (name === DEADLINES) continue;
    const file = NodePath.join(dir, name);
    const operationId = operationOfSave(name);
    const deadline = deadlines[operationId];
    const due =
      deadline === undefined
        ? now - NodeFS.statSync(file).mtimeMs > UNSEEN_SAVE_MS
        : deadline !== null && deadline <= now;
    if (due) NodeFS.rmSync(file, { force: true });
    else kept.add(operationId);
  }
  // A deadline outlives its saves only while it is still ahead.
  const left = Object.fromEntries(
    Object.entries(deadlines).filter(
      ([operationId, deadline]) => kept.has(operationId) || deadline === null || deadline > now,
    ),
  );
  if (Object.keys(left).length !== Object.keys(deadlines).length)
    NodeFS.writeFileSync(NodePath.join(dir, DEADLINES), JSON.stringify(left), { mode: 0o600 });
}

/**
 * Round 6f: asked just before an operation's write, after its reads and seals: whether it still
 * stands, as this desktop's own backend says. No answer, or no, and nothing is written.
 */
type MayWrite = () => Promise<boolean>;
const allowed = async (mayWrite: MayWrite | undefined) =>
  mayWrite === undefined || (await mayWrite().catch(() => false));

/** A cookie's identity in a jar: name, domain, path and partition. */
const jarKey = (cookie: Pick<SessionCookie, "name" | "domain" | "path" | "partitionKey">) =>
  JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null,
  ]);
const siteOfCookie = (domain: string) => domain.replace(/^\./, "");
/** The site a cookie's sign-in belongs to, whatever host of it the cookie names. */
const unitOf = (cookie: Pick<SessionCookie, "domain">) => siteOf(siteOfCookie(cookie.domain));

/** A copy's save: what the destination had in the copies' place, what came, what a move took. */
interface CopySave {
  readonly before: ReadonlyArray<SessionCookie>;
  readonly copied: ReadonlyArray<SessionCookie>;
  readonly moved: ReadonlyArray<SessionCookie>;
  /** What it wrote, confirmed (round 6i); a save from an older build has none. */
  readonly written?: ReadonlyArray<SessionCookie>;
}

/**
 * Copies these sites' cookies (all when none) through each partition's CDP, partitions kept, over
 * the same cookies in the destination only. What they replace is sealed for Undo first. Named:
 * sites the source has nothing for, and cookies refused or not carried exactly.
 */
export async function copyProfileCookies(options: {
  readonly stateDir: string;
  readonly operationId: string;
  readonly from: CdpSend;
  readonly into: CdpSend;
  readonly sites: ReadonlyArray<string> | undefined;
  readonly inSite: (cookie: Pick<SessionCookie, "domain">, site: string) => boolean;
  readonly move: boolean;
  readonly crypto:
    | { readonly encrypt: (plain: string) => Buffer; readonly decrypt?: (sealed: Buffer) => string }
    | undefined;
  readonly mayWrite?: MayWrite;
}) {
  const { stateDir, operationId, from, into, sites, inSite, move, crypto } = options;
  // Nothing moves without the system's encryption: Undo would have nothing to put back.
  if (!crypto) return null;
  const chosen = (cookie: Pick<SessionCookie, "domain">) =>
    sites === undefined || sites.some((site) => inSite(cookie, site));
  const raw = (
    (await from("Network.getAllCookies")) as { readonly cookies: ReadonlyArray<CdpCookie> }
  ).cookies.filter(chosen);
  const uncovered = new Set<string>();
  const copying: SessionCookie[] = [];
  // A site with a cookie that can't come over: a move leaves the whole site (round 6e).
  const stays = new Set<string>();
  for (const cookie of raw) {
    const exact = sessionCookieFromCdp(cookie);
    // One it can't write back exactly stays where it is, and its site is named.
    if ("unsupported" in exact) {
      uncovered.add(siteOfCookie(cookie.domain));
      stays.add(unitOf(cookie));
    } else copying.push(exact);
  }
  for (const site of sites ?? [])
    if (!raw.some((cookie) => inSite(cookie, site))) uncovered.add(site);
  const keys = new Set(copying.map(jarKey));
  const before = (await readJar(into)).cookies.filter((cookie) => keys.has(jarKey(cookie)));
  // A copy resumed after a restart adds to its first seal: the earliest of each cookie stays.
  const file = saveFile(stateDir, `${operationId}#copy`);
  const earlier: CopySave | undefined =
    NodeFS.existsSync(file) && crypto.decrypt
      ? (JSON.parse(crypto.decrypt(NodeFS.readFileSync(file))) as CopySave)
      : undefined;
  const merged = (first: ReadonlyArray<SessionCookie>, then: ReadonlyArray<SessionCookie>) => {
    const held = new Set(first.map(jarKey));
    return [...first, ...then.filter((cookie) => !held.has(jarKey(cookie)))];
  };
  // `copied` is the copy's intent: what it meant to write where the destination had none or its
  // own (round 6e). On a retry, a cookie there under such a key is its own write only when it is
  // exactly what was meant; anything else is someone's since: nothing changes (round 6f).
  const prior = new Map((earlier?.before ?? []).map((cookie) => [jarKey(cookie), cookie] as const));
  const beforeKeys = new Set(prior.keys());
  const meant = new Map((earlier?.copied ?? []).map((cookie) => [jarKey(cookie), cookie] as const));
  // Under each key it meant to write: what was there before it (nothing, too), or its own write;
  // once its write was confirmed, only that. Anything else, every attribute compared, was done
  // since and is never overwritten (rounds 6h, 6i).
  const written = new Set((earlier?.written ?? []).map(jarKey));
  const now = new Map(before.map((cookie) => [jarKey(cookie), cookie] as const));
  const same = (a: SessionCookie | undefined, b: SessionCookie | undefined) =>
    a === undefined ? b === undefined : b !== undefined && sameEveryAttribute(a, b);
  if (
    copying.some((cookie) => {
      const key = jarKey(cookie);
      const intent = meant.get(key);
      if (intent === undefined) return false;
      const current = now.get(key);
      return !same(intent, current) && (written.has(key) || !same(prior.get(key), current));
    })
  )
    return null;
  const brought = new Set([...meant.keys()].filter((key) => !beforeKeys.has(key)));
  const keep = (save: CopySave) => {
    NodeFS.mkdirSync(savesDir(stateDir), { recursive: true, mode: 0o700 });
    const whole = earlier
      ? {
          before: merged(
            earlier.before,
            save.before.filter((cookie) => !brought.has(jarKey(cookie))),
          ),
          copied: merged(earlier.copied, save.copied),
          moved: merged(earlier.moved, save.moved),
          written: merged(earlier.written ?? [], save.written ?? []),
        }
      : save;
    NodeFS.writeFileSync(file, crypto.encrypt(JSON.stringify(whole)), { mode: 0o600 });
    pendingSave(stateDir, operationId);
  };
  // Kept before anything changes, then again with what actually came over.
  keep({ before, copied: copying, moved: [] });
  if (!(await allowed(options.mayWrite))) return null;
  const done: SessionCookie[] = [];
  for (const cookie of copying)
    await setCookies(into, [cookie]).then(
      () => done.push(cookie),
      () => uncovered.add(siteOfCookie(cookie.domain)),
    );
  // A move takes a site from the source only once all of it came over: one refused cookie keeps
  // the whole site's sign-in where it was, unsplit (round 6d).
  const split = new Set([
    ...stays,
    ...copying.filter((cookie) => !done.includes(cookie)).map(unitOf),
  ]);
  const moved = move ? done.filter((cookie) => !split.has(unitOf(cookie))) : [];
  keep({ before, copied: done, moved, written: done });
  if (move) await deleteCookies(from, moved);
  return { copied: done.length, uncovered: [...uncovered] };
}

/**
 * A copy's Undo: each copy still as it came goes, and what it replaced comes back; a move's
 * cookies go back to the source. One set again since is a newer sign-in and stays (`newer`).
 */
export async function undoProfileCopy(options: {
  readonly stateDir: string;
  readonly operationId: string;
  readonly from: CdpSend;
  readonly into: CdpSend;
  readonly decrypt: (encrypted: Buffer) => string;
  readonly mayWrite?: MayWrite;
}) {
  const file = saveFile(options.stateDir, `${options.operationId}#copy`);
  if (!NodeFS.existsSync(file)) return null;
  const saved = JSON.parse(options.decrypt(NodeFS.readFileSync(file))) as CopySave;
  let restored = 0;
  let refused = 0;
  let newer = 0;
  const putBack = async (send: CdpSend, cookie: SessionCookie) =>
    setCookies(send, [cookie]).then(
      () => restored++,
      () => refused++,
    );
  const now = new Map((await readJar(options.into)).cookies.map((c) => [jarKey(c), c] as const));
  const asCopied = saved.copied.filter((cookie) => {
    const current = now.get(jarKey(cookie));
    if (current && current.value !== cookie.value) newer++;
    return current?.value === cookie.value;
  });
  if (!(await allowed(options.mayWrite))) return null;
  await deleteCookies(options.into, asCopied);
  const freed = new Set(asCopied.map(jarKey));
  for (const cookie of saved.before)
    if (!now.has(jarKey(cookie)) || freed.has(jarKey(cookie))) await putBack(options.into, cookie);
  const source = new Set((await readJar(options.from)).cookies.map(jarKey));
  for (const cookie of saved.moved) {
    if (source.has(jarKey(cookie))) {
      newer++;
      continue;
    }
    await putBack(options.from, cookie);
  }
  NodeFS.rmSync(file, { force: true });
  return { restored, refused, ...(newer ? { newer } : {}) };
}

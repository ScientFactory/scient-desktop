// @effect-diagnostics nodeBuiltinImport:off -- Real profile folders stand in for a profile whose browser stopped answering.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { chromium, type BrowserContext } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const pool = (profilesDir: string) =>
  new ServerBrowserContexts({
    profilesDir,
    executable: async () => "/test/chromium",
    env: {},
    chrome: { version: "157.0.8103.78", platform: "linux" as NodeJS.Platform },
  });
const fakeContext = (context: Record<string, unknown> = {}) => {
  const events = new NodeEvents.EventEmitter();
  return {
    on: (event: string, listener: () => void) => events.on(event, listener),
    pages: () => [],
    close: async () => void events.emit("close"),
    addInitScript: async () => undefined,
    route: async () => undefined,
    cookies: async () => [],
    ...context,
  } as unknown as BrowserContext;
};
const launch = vi
  .spyOn(chromium, "launchPersistentContext")
  .mockImplementation(async () => fakeContext());
const tempDir = (prefix: string) => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));

it("fences a profile for the life of the server, and carries nothing over a restart (6p)", async () => {
  const profilesDir = tempDir("profiles-fence-");
  const folder = NodePath.join(profilesDir, "work");
  try {
    const contexts = pool(profilesDir);
    await contexts.contextFor("work");
    contexts.quarantineProfile("work");
    expect(contexts.isQuarantined("work")).toBe(true);
    expect(contexts.quarantinedProfiles()).toEqual(["work"]);
    await expect(contexts.contextFor("work")).rejects.toThrow("unavailable");
    await expect(contexts.clearProfile("work")).rejects.toThrow("unavailable");
    await expect(contexts.purgeProfile("work")).rejects.toThrow("unavailable");
    // The Accounts Clear's own close, which moves its tabs to a new generation (round 6q).
    await expect(contexts.closeProfile("work")).rejects.toThrow("unavailable");
    expect(NodeFS.existsSync(folder)).toBe(true);
    // Only the profile's own folder is there: no mark, intent or record (round 6p).
    expect(NodeFS.readdirSync(profilesDir)).toEqual(["work"]);
    // The next server starts with nothing fenced, and opens the profile.
    const restarted = pool(profilesDir);
    expect(restarted.quarantinedProfiles()).toEqual([]);
    await restarted.contextFor("work");
    expect(launch).toHaveBeenCalledTimes(2);
  } finally {
    NodeFS.rmSync(profilesDir, { recursive: true, force: true });
  }
});

it("refuses a tab queued behind a hold once its profile is held, without an unhandled rejection (6m)", async () => {
  const profilesDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "profiles-queued-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const contexts = pool(profilesDir);
    const lease = await contexts.leases.lease("work");
    // A tab asks for the profile while the hold is on: it waits.
    const tab = contexts.contextFor("work");
    const refused = tab.then(
      () => "opened",
      (cause: Error) => cause.message,
    );
    contexts.quarantineProfile("work");
    await lease.release();
    expect(await refused).toContain("unavailable");
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node reports an unhandled rejection only after the current task: one turn of the event loop is the milestone
    await new Promise((resolve) => setImmediate(resolve));
    // regression: the queue's own `finally` rejected unhandled and could take the server down.
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    NodeFS.rmSync(profilesDir, { recursive: true, force: true });
  }
});
it("refuses a Clear and a purge queued behind a hold once the profile is held (6n)", async () => {
  const profilesDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "profiles-queued-rm-"));
  const folder = NodePath.join(profilesDir, "work");
  try {
    const contexts = pool(profilesDir);
    await contexts.contextFor("work");
    const lease = await contexts.leases.lease("work");
    // Both pass the check at their start, and wait for the copy's hold.
    const outcome = (work: Promise<void>) =>
      work.then(
        () => "deleted",
        (cause: Error) => cause.message,
      );
    const clearing = outcome(contexts.clearProfile("work"));
    const purging = outcome(contexts.purgeProfile("work"));
    contexts.quarantineProfile("work");
    await lease.release();
    // regression: both went on to delete the folder its browser may still write to.
    expect(await clearing).toContain("unavailable");
    expect(await purging).toContain("unavailable");
    expect(NodeFS.existsSync(folder)).toBe(true);
  } finally {
    NodeFS.rmSync(profilesDir, { recursive: true, force: true });
  }
});
it("refuses a close that waited behind a hold while the profile was fenced (6r)", async () => {
  const profilesDir = tempDir("profiles-queued-close-");
  try {
    const contexts = pool(profilesDir);
    await contexts.contextFor("work");
    const lease = await contexts.leases.lease("work");
    // The Clear's close passes the check at its start, and waits for the copy's hold.
    const closing = contexts.closeProfile("work").then(
      () => "closed",
      (cause: Error) => cause.message,
    );
    contexts.quarantineProfile("work");
    await lease.release();
    // regression: the fence dropped the context, and the close returned early as a success.
    expect(await closing).toContain("unavailable");
  } finally {
    NodeFS.rmSync(profilesDir, { recursive: true, force: true });
  }
});

it("keeps no session cookie in a quarantined profile's context (6m)", async () => {
  const profilesDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "profiles-upkeep-"));
  const events = new NodeEvents.EventEmitter();
  const addCookies = vi.fn(async () => undefined);
  launch.mockImplementationOnce(async () =>
    fakeContext({
      on: (event: string, listener: () => void) => events.on(event, listener),
      // A browser-session cookie the upkeep would give an expiry.
      cookies: async () => [
        {
          name: "sid",
          value: "s",
          domain: ".example.com",
          path: "/",
          expires: -1,
          httpOnly: true,
        },
      ],
      addCookies,
    }),
  );
  vi.useFakeTimers();
  try {
    const contexts = pool(profilesDir);
    await contexts.contextFor("work");
    contexts.quarantineProfile("work");
    // The hung browser's page still answers: the upkeep's sweep comes due.
    events.emit("response");
    await vi.advanceTimersByTimeAsync(5_000);
    // regression: the upkeep wrote into the held profile's context.
    expect(addCookies).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    NodeFS.rmSync(profilesDir, { recursive: true, force: true });
  }
});

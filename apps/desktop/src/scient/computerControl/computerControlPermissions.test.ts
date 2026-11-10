import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  screen: "denied" as string,
  trusted: false,
  packaged: true,
  choice: 0,
  getSources: vi.fn(async () => []),
  isTrusted: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  showMessageBoxSync: vi.fn(),
  once: vi.fn(),
  spawn: vi.fn(),
  watchers: [] as Array<{ emit: (event: string) => void }>,
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    getPath: () => "/tmp",
    once: mocks.once,
  },
  desktopCapturer: { getSources: mocks.getSources },
  dialog: {
    showMessageBoxSync: (options: unknown) => {
      mocks.showMessageBoxSync(options);
      return mocks.choice;
    },
  },
  shell: { openExternal: mocks.openExternal },
  systemPreferences: {
    getMediaAccessStatus: () => mocks.screen,
    isTrustedAccessibilityClient: (prompt: boolean) => {
      mocks.isTrusted(prompt);
      return mocks.trusted;
    },
  },
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (...args: Array<unknown>) => {
      mocks.spawn(...args);
      const watcher: InstanceType<typeof EventEmitter> & { unref: () => void; kill: () => void } =
        Object.assign(new EventEmitter(), {
          unref: vi.fn(),
          kill: vi.fn(() => {
            watcher.emit("exit");
          }),
        });
      mocks.watchers.push(watcher);
      return watcher;
    },
  };
});

Object.defineProperty(process, "execPath", {
  value: "/Applications/Scient.app/Contents/MacOS/Scient",
});

const { openComputerControlPermissionPane } = await import("./computerControlPermissions.ts");
const { reportRunningWork } = await import("../quitGuard/ipc.ts");

const SCREEN_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  mocks.screen = "denied";
  mocks.trusted = false;
  mocks.choice = 0;
  for (const watcher of mocks.watchers.splice(0)) watcher.emit("exit");
  reportRunningWork(0);
  vi.clearAllMocks();
});

it("asks macOS for screen capture before opening the pane, so Scient is listed there", async () => {
  expect(await openComputerControlPermissionPane("screen-recording")).toBe("opened");
  expect(mocks.getSources).toHaveBeenCalledOnce();
  expect(mocks.openExternal).toHaveBeenCalledWith(SCREEN_PANE);
  expect(mocks.getSources.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.openExternal.mock.invocationCallOrder[0]!,
  );
});

it("asks with the accessibility prompt and never waits for running work", async () => {
  reportRunningWork(2);
  expect(await openComputerControlPermissionPane("accessibility")).toBe("opened");
  expect(mocks.isTrusted).toHaveBeenCalledWith(true);
  expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
});

it("opens Screen Recording only once running work has finished", async () => {
  reportRunningWork(1);
  expect(await openComputerControlPermissionPane("screen-recording")).toBe("deferred");
  expect(mocks.openExternal).not.toHaveBeenCalled();
  reportRunningWork(1);
  expect(mocks.openExternal).not.toHaveBeenCalled();
  reportRunningWork(0);
  await vi.waitFor(() => expect(mocks.openExternal).toHaveBeenCalledWith(SCREEN_PANE));
});

it("does nothing when the user cancels while work is running", async () => {
  mocks.choice = 1;
  reportRunningWork(1);
  expect(await openComputerControlPermissionPane("screen-recording")).toBe("cancelled");
  reportRunningWork(0);
  expect(mocks.openExternal).not.toHaveBeenCalled();
  expect(mocks.getSources).not.toHaveBeenCalled();
});

it("watches for a forced exit once at a time and again after the watcher ends", async () => {
  await openComputerControlPermissionPane("screen-recording");
  await openComputerControlPermissionPane("screen-recording");
  expect(mocks.spawn).toHaveBeenCalledOnce();
  const [shell, args, options] = mocks.spawn.mock.calls[0] ?? [];
  expect(shell).toBe("/bin/sh");
  expect((args as Array<string>).slice(4, 6)).toEqual([
    "/tmp/scient-clean-exit-" + process.pid,
    "/Applications/Scient.app",
  ]);
  expect(options).toEqual({ detached: true, stdio: "ignore" });
  mocks.watchers[0]?.emit("exit");
  await openComputerControlPermissionPane("screen-recording");
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});

it("leaves granted Screen Recording alone and watches nothing outside a packaged app", async () => {
  mocks.screen = "granted";
  expect(await openComputerControlPermissionPane("screen-recording")).toBe("opened");
  expect(mocks.getSources).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
  mocks.screen = "denied";
  mocks.packaged = false;
  await openComputerControlPermissionPane("screen-recording");
  expect(mocks.spawn).not.toHaveBeenCalled();
  mocks.packaged = true;
});

it("stops watching shortly after Screen Recording is on, since a grant no longer ends Scient", async () => {
  vi.useFakeTimers();
  await openComputerControlPermissionPane("screen-recording");
  const watcher = mocks.watchers.at(-1) as unknown as { kill: ReturnType<typeof vi.fn> };
  await vi.advanceTimersByTimeAsync(10_000);
  expect(watcher.kill).not.toHaveBeenCalled();
  mocks.screen = "granted";
  await vi.advanceTimersByTimeAsync(2_000);
  expect(watcher.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(watcher.kill).toHaveBeenCalledOnce();
  mocks.screen = "denied";
  await openComputerControlPermissionPane("screen-recording");
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
});

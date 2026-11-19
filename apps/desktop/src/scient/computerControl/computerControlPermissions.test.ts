import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  screen: "denied" as string,
  trusted: false,
  /** What the fresh osascript child prints: Screen Recording, then Accessibility. */
  fresh: "0 0",
  isTrusted: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  execFile: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: { openExternal: mocks.openExternal },
  systemPreferences: {
    getMediaAccessStatus: () => mocks.screen,
    isTrustedAccessibilityClient: (prompt: boolean) => {
      mocks.isTrusted(prompt);
      return mocks.trusted;
    },
  },
}));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: ReadonlyArray<string>,
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    mocks.execFile(file, args);
    queueMicrotask(() => callback(null, `${mocks.fresh}\n`));
  },
}));

const SCREEN_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** A fresh module per test: what it has seen granted lasts for the life of the process. */
const load = () => import("./computerControlPermissions.ts");

/** The order of the helper call that asks for Screen Recording, if one ran. */
const screenRequestOrder = () => {
  const index = mocks.execFile.mock.calls.findIndex(([, args]) =>
    String(args).includes("CGRequestScreenCaptureAccess"),
  );
  return index < 0 ? undefined : mocks.execFile.mock.invocationCallOrder[index];
};

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  mocks.screen = "denied";
  mocks.trusted = false;
  mocks.fresh = "0 0";
  vi.resetModules();
  vi.clearAllMocks();
});

it("asks macOS for screen capture before opening the pane, so Scient is listed there", async () => {
  const { openComputerControlPermissionPane } = await load();
  expect(await openComputerControlPermissionPane("screen-recording")).toBe(true);
  expect(mocks.openExternal).toHaveBeenCalledWith(SCREEN_PANE);
  expect(screenRequestOrder()).toBeLessThan(mocks.openExternal.mock.invocationCallOrder[0]!);
});

it("asks with the accessibility prompt", async () => {
  const { openComputerControlPermissionPane } = await load();
  expect(await openComputerControlPermissionPane("accessibility")).toBe(true);
  expect(mocks.isTrusted).toHaveBeenCalledWith(true);
});

it("sees a grant made since Scient started, which Electron still reports as denied", async () => {
  const { computerControlPermissionGranted, openComputerControlPermissionPane } = await load();
  mocks.fresh = "1 0";
  expect(await computerControlPermissionGranted("screen-recording")).toBe(true);
  expect(await computerControlPermissionGranted("accessibility")).toBe(false);
  expect(mocks.execFile).toHaveBeenCalledOnce();
  expect(mocks.execFile.mock.calls[0]?.[0]).toBe("/usr/bin/osascript");
  await openComputerControlPermissionPane("screen-recording");
  expect(screenRequestOrder()).toBeUndefined();
});

it("starts no child while Electron reports the grant", async () => {
  const { computerControlPermissionGranted } = await load();
  mocks.screen = "granted";
  mocks.trusted = true;
  expect(await computerControlPermissionGranted("screen-recording")).toBe(true);
  expect(await computerControlPermissionGranted("accessibility")).toBe(true);
  expect(mocks.execFile).not.toHaveBeenCalled();
});

it("reuses a refusal briefly and keeps a grant, so polling starts few children", async () => {
  vi.useFakeTimers();
  const { computerControlPermissionGranted } = await load();
  expect(await computerControlPermissionGranted("screen-recording")).toBe(false);
  expect(await computerControlPermissionGranted("accessibility")).toBe(false);
  vi.advanceTimersByTime(1_500);
  expect(await computerControlPermissionGranted("screen-recording")).toBe(false);
  expect(mocks.execFile).toHaveBeenCalledOnce();
  mocks.fresh = "1 1";
  vi.advanceTimersByTime(500);
  expect(await computerControlPermissionGranted("screen-recording")).toBe(true);
  expect(mocks.execFile).toHaveBeenCalledTimes(2);
  mocks.fresh = "0 0";
  vi.advanceTimersByTime(10_000);
  expect(await computerControlPermissionGranted("screen-recording")).toBe(true);
  expect(await computerControlPermissionGranted("accessibility")).toBe(true);
  expect(mocks.execFile).toHaveBeenCalledTimes(2);
});

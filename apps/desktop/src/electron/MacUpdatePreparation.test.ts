import * as NodeEvents from "node:events";
import { expect, it, vi } from "vite-plus/test";
import { MacUpdatePreparation } from "./MacUpdatePreparation.ts";

const receipt = (version: string, generation: string) => ({
  version,
  nativeUpdateUrl: `http://127.0.0.1:12345/${generation.repeat(128)}.zip`,
});
const setup = () => {
  const native = Object.assign(new NodeEvents.EventEmitter(), {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  return { native, preparation: new MacUpdatePreparation(native) };
};
const nativeReady = (native: NodeEvents.EventEmitter, url: string) =>
  native.emit("update-downloaded", {}, "", "", undefined, url);

it("does not arm native preparation for a background archive receipt or admit an unprepared install", () => {
  const { native, preparation } = setup();
  preparation.recordDownloaded(receipt("1.2.4", "a"));
  expect(native.checkForUpdates).not.toHaveBeenCalled();
  expect(preparation.authorizedVersion).toBeNull();
  expect(() => preparation.quitAndInstall("1.2.4")).toThrow("not natively ready");
  expect(native.quitAndInstall).not.toHaveBeenCalled();
});

it("matches the native receipt to its exact generation and version before installation", async () => {
  const { native, preparation } = setup();
  const selected = receipt("1.2.4", "b");
  preparation.recordDownloaded(selected);
  const prepared = preparation.prepare(selected.version);
  nativeReady(native, receipt("1.2.4", "a").nativeUpdateUrl);
  expect(() => preparation.quitAndInstall(selected.version)).toThrow("not natively ready");
  nativeReady(native, selected.nativeUpdateUrl);
  await prepared;
  expect(() => preparation.quitAndInstall("1.2.5")).toThrow("not natively ready");
  preparation.quitAndInstall(selected.version);
  expect(native.quitAndInstall).toHaveBeenCalledOnce();
  expect(native.listenerCount("update-downloaded")).toBe(0);
});

it("reuses a still-pending native generation on retry instead of arming another operation", async () => {
  const { native, preparation } = setup();
  const selected = receipt("1.2.4", "a");
  preparation.recordDownloaded(selected);
  const first = preparation.prepare(selected.version);
  expect(preparation.prepare(selected.version)).toBe(first);
  expect(() => preparation.assertCanDownload()).toThrow("already authorized");
  preparation.recordDownloaded(receipt("1.2.5", "b"));
  nativeReady(native, receipt("1.2.5", "b").nativeUpdateUrl);
  expect(() => preparation.quitAndInstall(selected.version)).toThrow("not natively ready");
  nativeReady(native, selected.nativeUpdateUrl);
  await first;
  expect(native.checkForUpdates).toHaveBeenCalledOnce();
  preparation.quitAndInstall(selected.version);
});

it("permits a terminal native failure to retry and ignores a previous generation's late receipt", async () => {
  const { native, preparation } = setup();
  const old = receipt("1.2.4", "a");
  preparation.recordDownloaded(old);
  const failed = preparation.prepare(old.version);
  const failure = expect(failed).rejects.toThrow("signature refused");
  native.emit("error", new Error("signature refused"));
  await failure;
  expect(preparation.authorizedVersion).toBeNull();
  preparation.assertCanDownload();
  const selected = receipt("1.2.5", "b");
  preparation.recordDownloaded(selected);
  const retry = preparation.prepare(selected.version);
  nativeReady(native, old.nativeUpdateUrl);
  expect(() => preparation.quitAndInstall(selected.version)).toThrow("not natively ready");
  nativeReady(native, selected.nativeUpdateUrl);
  await retry;
  preparation.quitAndInstall(selected.version);
  expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
});

it("fails closed without pinned loopback metadata and when native preparation finds no update", async () => {
  const { native, preparation } = setup();
  preparation.recordDownloaded({ version: "1.2.4" });
  await expect(preparation.prepare("1.2.4")).rejects.toThrow(
    "no matching native preparation receipt",
  );
  preparation.recordDownloaded({
    version: "1.2.4",
    nativeUpdateUrl: "https://example.com/update.zip",
  });
  await expect(preparation.prepare("1.2.4")).rejects.toThrow(
    "no matching native preparation receipt",
  );
  expect(native.checkForUpdates).not.toHaveBeenCalled();
  preparation.recordDownloaded(receipt("1.2.4", "a"));
  const pending = preparation.prepare("1.2.4");
  const failure = expect(pending).rejects.toThrow("did not prepare");
  native.emit("update-not-available");
  await failure;
  expect(preparation.authorizedVersion).toBeNull();
  expect(native.listenerCount("error")).toBe(0);
});

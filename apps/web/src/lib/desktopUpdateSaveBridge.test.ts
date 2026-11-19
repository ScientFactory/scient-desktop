import { expect, it } from "vite-plus/test";
import { createDesktopUpdateSaveBridge } from "./desktopUpdateSaveBridge";

function fixture(clean = true) {
  let listener: ((input: { requestId: string; lockForRestart: boolean }) => void) | undefined;
  let release: ((requestId: string) => void) | undefined;
  let inputLocked = false;
  let respond: ((input: { requestId: string; saved: boolean }) => void) | undefined;
  const registration = createDesktopUpdateSaveBridge(
    {
      onPrepareUpdateSave: (receive) => {
        listener = receive;
        return () => {
          listener = undefined;
        };
      },
      onReleaseUpdateSave: (receive) => {
        release = receive;
        return () => {
          release = undefined;
        };
      },
      completeUpdateSave: async (response) => {
        respond?.(response);
        return true;
      },
    },
    () => clean,
    () => {
      inputLocked = true;
      return () => {
        inputLocked = false;
      };
    },
  );
  return {
    registration,
    locked: () => inputLocked,
    release: (requestId: string) => release?.(requestId),
    request: (requestId: string, lockForRestart = false) => {
      const receipt = Promise.withResolvers<{ requestId: string; saved: boolean }>();
      respond = receipt.resolve;
      listener?.({ requestId, lockForRestart });
      return receipt.promise;
    },
  };
}

it("allows an initially clean boot-error shell but preserves its unload veto", async () => {
  const clean = fixture();
  clean.registration.installBootShell();
  expect(await clean.request("native-request")).toEqual({
    requestId: "native-request",
    saved: true,
  });
  clean.registration.dispose();
  const blocked = fixture(false);
  blocked.registration.installBootShell();
  expect(await blocked.request("blocked")).toEqual({ requestId: "blocked", saved: false });
  blocked.registration.dispose();
});

it("never substitutes the empty-shell acknowledgement after a real editor host has existed", async () => {
  const f = fixture();
  f.registration.installBootShell();
  const unregister = f.registration.register(async () => true);
  expect((await f.request("full")).saved).toBe(true);
  unregister();
  expect((await f.request("after-failure")).saved).toBe(false);
  f.registration.dispose();
});

it("rejects a save whose owning renderer unmounted before completion", async () => {
  const f = fixture();
  const save = Promise.withResolvers<boolean>();
  const unregister = f.registration.register(() => save.promise);
  const receipt = f.request("in-flight");
  unregister();
  save.resolve(true);
  expect((await receipt).saved).toBe(false);
  f.registration.dispose();
});

it("fails closed on unavailable or failed editor saves", async () => {
  const f = fixture();
  expect((await f.request("no-host")).saved).toBe(false);
  f.registration.register(async () => {
    throw new Error("Save refused");
  });
  expect((await f.request("failed")).saved).toBe(false);
  f.registration.dispose();
});

it("blocks new edits only for the final save, until the matching native handoff is released", async () => {
  const f = fixture();
  const saved = Promise.withResolvers<boolean>();
  f.registration.register(() => saved.promise);
  const receipt = f.request("final-save", true);
  expect(f.locked()).toBe(true);
  saved.resolve(true);
  expect((await receipt).saved).toBe(true);
  expect(f.locked()).toBe(true);
  f.release("stale-request");
  expect(f.locked()).toBe(true);
  f.release("final-save");
  expect(f.locked()).toBe(false);
  f.registration.dispose();
});

it("restores input when final persistence fails rather than leaving an unusable app", async () => {
  const f = fixture();
  f.registration.register(async () => false);
  expect((await f.request("failed-final-save", true)).saved).toBe(false);
  expect(f.locked()).toBe(false);
  f.registration.dispose();
});

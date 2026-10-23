import { expect, it, vi } from "vite-plus/test";
import type { KeepAwakeState } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { toastManager } from "../../components/ui/toast";
import { keepAwakeErrorAtom, keepAwakeStateAtom, requestKeepAwake } from "./state";

vi.mock("../../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

it("retains observations before Settings mounts and reports a persistent failure only once", async () => {
  using cleanup = new DisposableStack();
  vi.useFakeTimers();
  cleanup.defer(() => vi.useRealTimers());
  cleanup.defer(() => vi.unstubAllGlobals());
  vi.mocked(toastManager.add).mockClear();
  const state: KeepAwakeState = {
    settings: { mode: "running" },
    blocking: true,
    error: null,
    threads: [],
  };
  const bridge = vi.fn().mockResolvedValue(state);
  vi.stubGlobal("window", { desktopBridge: { keepAwake: bridge } });

  await requestKeepAwake({ type: "get" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(appAtomRegistry.get(keepAwakeStateAtom)).toEqual(state);

  bridge.mockRejectedValue(new Error("Connection unavailable"));
  await requestKeepAwake({ type: "get" });
  await vi.advanceTimersByTimeAsync(60_000);
  await requestKeepAwake({ type: "get" });
  expect(appAtomRegistry.get(keepAwakeErrorAtom)).toBe("Connection unavailable");
  expect(toastManager.add).toHaveBeenCalledTimes(1);

  bridge.mockResolvedValue(state);
  await requestKeepAwake({ type: "get" });
  expect(appAtomRegistry.get(keepAwakeErrorAtom)).toBeNull();
});

import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { forwardPort, PortForwardSameMachineError } from "./portForwards";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("recognizes only the desktop's top-level same-machine error", async () => {
  const sameMachine = "LoopbackTunnelSameMachineError: The server is on this machine.";
  const ipcPrefix = "Error invoking remote method 'desktop:port-forward-start': ";
  const start = vi
    .fn()
    .mockRejectedValueOnce(new Error(ipcPrefix + sameMachine))
    .mockRejectedValueOnce(new Error(ipcPrefix + "LoopbackTunnelForwardError: " + sameMachine));
  vi.stubGlobal("window", { desktopBridge: { preview: { forwardPort: start } } });
  const environmentId = EnvironmentId.make("env");

  await expect(forwardPort(environmentId, 3000)).rejects.toBeInstanceOf(
    PortForwardSameMachineError,
  );
  await expect(forwardPort(environmentId, 3000)).rejects.not.toBeInstanceOf(
    PortForwardSameMachineError,
  );
});

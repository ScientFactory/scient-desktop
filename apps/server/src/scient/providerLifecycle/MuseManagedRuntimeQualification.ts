// @effect-diagnostics nodeBuiltinImport:off -- Native qualification owns a disposable home and closes MSP before removing it.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { managedRuntimeSmokeEnvironment } from "@scientfactory/provider-runtime";
import { createMuseSdkHost } from "@t3tools/provider-muse/server";

/** A protocol witness, never an account-status or entitlement witness. */
export async function qualifyMuseManagedRuntime(
  input: {
    readonly executablePath: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
    /** Parent-owned private home for subprocess qualification. The parent owns removal. */
    readonly home?: string;
    readonly onClosed?: () => void;
  },
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]);
  signal.throwIfAborted();
  const home =
    input.home ??
    (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-muse-qualification-")));
  let closed = false;
  try {
    const host = await createHost({
      binaryPath: input.executablePath,
      cwd: home,
      readOnly: true,
      startupTimeoutMs: 8_000,
      signal,
      onClosed: () => {
        closed = true;
        input.onClosed?.();
      },
      environment: {
        ...managedRuntimeSmokeEnvironment(input.environment),
        HOME: home,
        USERPROFILE: home,
        APPDATA: NodePath.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
        XDG_CONFIG_HOME: NodePath.join(home, ".config"),
        XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
        XDG_CACHE_HOME: NodePath.join(home, ".cache"),
        MUSE_NO_AUTO_UPDATE: "1",
        MUSE_LOGIN: "0",
      },
    });
    try {
      const catalog = await host.connection.request("model/list", {});
      if (!Array.isArray(catalog.models))
        throw new Error("Muse returned an invalid model catalog.");
      signal.throwIfAborted();
    } finally {
      await host.close();
      closed = true;
    }
  } finally {
    if (closed && input.home === undefined)
      await NodeFSP.rm(home, { recursive: true, force: true });
  }
}

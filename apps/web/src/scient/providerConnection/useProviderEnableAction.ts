import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  type ProviderOperateAccess,
} from "../../providerOperateAccess";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildEnableProviderPatch } from "./providerEnablement";

export function useProviderEnableAction(input: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
}): {
  readonly access: ProviderOperateAccess;
  readonly canEnable: boolean;
  readonly enable: () => Promise<void>;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const session = useEnvironmentSessionState(input.environmentId);
  const settings = useEnvironmentSettings(input.environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const isPrimary = input.environmentId === primaryEnvironmentId;
  const access = isPrimary
    ? resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: typeof window !== "undefined" && Boolean(window.desktopBridge),
        session: session.data,
        isPending: session.isPending,
        hasError: session.hasError,
      })
    : resolveRemoteOperateAccess({
        session: session.data,
        isPending: session.isPending,
        hasError: session.hasError,
      });
  const patch = buildEnableProviderPatch(settings, input.provider);
  const displayName = input.provider.displayName?.trim() || String(input.provider.driver);

  const enable = async () => {
    if (access !== "granted" || patch === null) {
      throw new Error(`This session cannot enable ${displayName}.`);
    }
    const result = await updateSettings({
      environmentId: input.environmentId,
      input: { patch },
    });
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) {
      throw new Error(`Enabling ${displayName} was cancelled.`);
    }
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error ? failure : new Error(`Scient could not enable ${displayName}.`);
  };

  return {
    access,
    canEnable: access === "granted" && patch !== null,
    enable,
  };
}

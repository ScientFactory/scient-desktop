import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useCallback } from "react";

import { usePrimarySessionState } from "../../environments/primary";
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
  const primarySession = usePrimarySessionState();
  const remoteSession = useEnvironmentSessionState(input.environmentId);
  const settings = useEnvironmentSettings(input.environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const isPrimary = input.environmentId === primaryEnvironmentId;
  const access = isPrimary
    ? resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: typeof window !== "undefined" && Boolean(window.desktopBridge),
        session: primarySession.data,
        isPending: primarySession.isPending,
        hasError: primarySession.error !== null,
      })
    : resolveRemoteOperateAccess({
        session: remoteSession.data,
        isPending: remoteSession.isPending,
        hasError: remoteSession.hasError,
      });
  const patch = buildEnableProviderPatch(settings, input.provider);

  const enable = useCallback(async () => {
    if (access !== "granted" || patch === null) {
      throw new Error(`This session cannot enable ${input.provider.displayName}.`);
    }
    const result = await updateSettings({
      environmentId: input.environmentId,
      input: { patch },
    });
    if (result._tag === "Success") return;
    if (isAtomCommandInterrupted(result)) {
      throw new Error(`Enabling ${input.provider.displayName} was cancelled.`);
    }
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error
      ? failure
      : new Error(`Scient could not enable ${input.provider.displayName}.`);
  }, [access, input.environmentId, input.provider.displayName, patch, updateSettings]);

  return {
    access,
    canEnable: access === "granted" && patch !== null,
    enable,
  };
}

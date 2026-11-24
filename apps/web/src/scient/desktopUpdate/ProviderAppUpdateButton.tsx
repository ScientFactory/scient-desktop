import type { DesktopBridge, EnvironmentId } from "@t3tools/contracts";
import { T, useMessages } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { getDesktopUpdateInstallConfirmationMessage } from "~/components/desktopUpdate.logic";
import { requestConfirmDialog } from "~/confirmDialog";
import { Button } from "~/components/ui/button";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { checkForDesktopUpdate, downloadLocalUpdate } from "./desktopUpdateActions";
import { resolveProviderAppUpdateAction } from "./providerAppUpdate.logic";
import {
  installDesktopUpdateNow,
  showScientUpdateReadyNotice,
  type ScientUpdateReadyNoticeHandle,
} from "./updateReadyNotice";

export function ProviderAppUpdateButton({
  environmentId,
  requiresAppUpdate,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly requiresAppUpdate: boolean | undefined;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  return requiresAppUpdate === true &&
    environmentId !== null &&
    environmentId === primaryEnvironmentId &&
    typeof bridge?.checkForUpdate === "function" ? (
    <DesktopAppUpdateButton bridge={bridge} />
  ) : null;
}

function DesktopAppUpdateButton({ bridge }: { readonly bridge: DesktopBridge }) {
  const state = useDesktopUpdateState();
  const messages = useMessages();
  const [pending, setPending] = useState(false);
  const readyNotice = useRef<ScientUpdateReadyNoticeHandle | null>(null);
  const action = resolveProviderAppUpdateAction(state);
  const confirmVersion = action === "confirm-install" ? state?.downloadedVersion : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the notice when its anchor or update goes away
  useEffect(() => {
    if (!confirmVersion) return;
    return () => readyNotice.current?.close();
  }, [confirmVersion]);

  const startUpdate = async (anchor: HTMLButtonElement) => {
    if (!state || !action || pending) return;

    // An open popup needs a confirmation that can take focus above it.
    if (
      action === "confirm-install" &&
      !anchor.closest('[data-slot="popover-popup"], [data-slot="dialog-popup"]')
    ) {
      if (readyNotice.current) {
        readyNotice.current.close();
        return;
      }
      readyNotice.current = showScientUpdateReadyNotice({
        shell: bridge,
        state,
        anchor,
        persistent: true,
        onClose: () => {
          readyNotice.current = null;
        },
      });
      return;
    }

    setPending(true);
    if (action === "confirm-install") {
      if (await requestConfirmDialog(getDesktopUpdateInstallConfirmationMessage(state, messages))) {
        await installDesktopUpdateNow(bridge, undefined, state.downloadedVersion);
      }
    } else if (action === "retry-install") {
      await installDesktopUpdateNow(bridge, undefined, state.downloadedVersion);
    } else if (action === "download") {
      await downloadLocalUpdate(bridge);
    } else {
      // The check reports a refused update itself, in the updater state's message.
      await checkForDesktopUpdate(bridge, undefined);
    }
    setPending(false);
  };

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={action === null || pending}
      onClick={(event) => void startUpdate(event.currentTarget)}
    >
      <T>Update Scient</T>
    </Button>
  );
}

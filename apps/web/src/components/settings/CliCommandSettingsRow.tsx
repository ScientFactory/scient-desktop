import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Settings → `scient` command: puts the desktop app's bundled CLI on PATH, or takes
 * it off again. Hidden where the desktop build has no launcher to install.
 */
export function CliCommandSettingsRow() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const state = query.data;
  const [pending, setPending] = useState(false);

  const change = (action: "install" | "uninstall") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              action === "install"
                ? "Could not install scient"
                : "Could not remove terminal command",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
        // SCIENT-FORK:START - refresh launcher state after a partial failure.
        refreshDesktopCliCommandState();
        // SCIENT-FORK:END
      })
      .finally(() => setPending(false));
  };

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  const removable = installed || state.legacyInstalled;
  const description = state.shadowedBy
    ? `Another CLI at ${state.shadowedBy} runs first in a new terminal. Resolve that conflict to use Scient's command.`
    : !installed
      ? "Run Scient's CLI as `scient` from any terminal."
      : state.onPath
        ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
        : `Installed at ${state.installedPath}, which is not on your PATH yet. Add its folder to your PATH to run \`scient\`.`;

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex flex-wrap items-center gap-2">
          {!installed ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || query.isPending}
              onClick={() => change("install")}
            >
              Install scient
            </Button>
          ) : null}
          {removable ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || query.isPending}
              onClick={() => change("uninstall")}
            >
              Remove
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

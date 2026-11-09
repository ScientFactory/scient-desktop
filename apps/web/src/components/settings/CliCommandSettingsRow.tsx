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

const FAILURE_TITLES = {
  install: "Could not install scient",
  uninstall: "Could not remove terminal command",
  addToPath: "Could not add scient to PATH",
} as const;

/** The desktop `scient` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLES) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: FAILURE_TITLES[action],
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
        // SCIENT-FORK:START - refresh launcher state after a partial failure.
        refreshDesktopCliCommandState();
        // SCIENT-FORK:END
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

/**
 * Settings → `scient` command: puts the desktop app's bundled CLI on PATH, or takes
 * it off again. Hidden where the desktop build has no launcher to install.
 */
export function CliCommandSettingsRow() {
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const removable = installed || state.legacyInstalled;
  const description = state.shadowedBy
    ? `Another CLI at ${state.shadowedBy} runs first in a new terminal. Resolve that conflict to use Scient's command.`
    : !installed
      ? "Run Scient's CLI as `scient` from any terminal."
      : state.onPath
        ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
        : state.pathSetup?.added
          ? `Installed at ${state.installedPath} and added to PATH in ${state.pathSetup.file}. Open a new terminal to use it.`
          : `Installed at ${state.installedPath}, which is not on your PATH yet.${state.pathSetup ? "" : " Add its folder to your PATH to run `scient`."}`;

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex flex-wrap items-center gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              Add to PATH
            </Button>
          ) : null}
          {!installed ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || Boolean(state.shadowedBy)}
              onClick={() => run("install")}
            >
              Install scient
            </Button>
          ) : null}
          {removable ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("uninstall")}>
              Remove
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useMessages } from "gt-react";
import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { m } from "../../i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const FAILURE_TITLES = {
  install: msg("Could not install scient"),
  uninstall: msg("Could not remove terminal command"),
  addToPath: msg("Could not add scient to PATH"),
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
            title: m(FAILURE_TITLES[action]),
            description:
              error instanceof Error
                ? (thrownErrorMessage(error, m) ?? error.message)
                : m(msg("Something went wrong.")),
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
  const searchableSetting = useSearchableSetting();
  const { state, busy, run } = useDesktopCliCommand();
  const resolve = useMessages();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const removable = installed || state.legacyInstalled;
  const description = state.shadowedBy
    ? resolve(
        msg(
          "Another CLI at {path} runs first in a new terminal. Resolve that conflict to use Scient's command.",
          { path: state.shadowedBy },
        ),
      )
    : !installed
      ? resolve(msg("Run Scient's CLI as `scient` from any terminal."))
      : state.onPath
        ? resolve(
            msg("Installed at {path}. Open a new terminal to use it.", {
              path: state.installedPath,
            }),
          )
        : state.pathSetup?.added
          ? resolve(
              msg(
                "Installed at {path} and added to PATH in {file}. Open a new terminal to use it.",
                { path: state.installedPath, file: state.pathSetup.file },
              ),
            )
          : state.pathSetup
            ? resolve(
                msg("Installed at {path}, which is not on your PATH yet.", {
                  path: state.installedPath,
                }),
              )
            : resolve(
                msg(
                  "Installed at {path}, which is not on your PATH yet. Add its folder to your PATH to run `scient`.",
                  { path: state.installedPath },
                ),
              );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex flex-wrap items-center gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              <T>Add to PATH</T>
            </Button>
          ) : null}
          {!installed ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || Boolean(state.shadowedBy)}
              onClick={() => run("install")}
            >
              {resolve(msg("Install scient", { $context: "button, installs the scient command" }))}
            </Button>
          ) : null}
          {removable ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("uninstall")}>
              {resolve(msg("Remove", { $context: "verb, uninstalls the scient command" }))}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

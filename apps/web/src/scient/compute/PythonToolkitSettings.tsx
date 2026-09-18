import { DownloadIcon, LoaderCircleIcon, MoreHorizontalIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComputeLanguageRuntimeInventory, ComputeToolkitId } from "@t3tools/contracts";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  ManagedRuntimeNotice,
  type ComputeManagedRuntimeController,
} from "./ComputeManagedRuntimeControls";

/** Remembers an in-flight row action, never an optimistic installation state. */
export interface ToolkitChange {
  readonly toolkitId: ComputeToolkitId;
  readonly install: boolean;
}

export function PythonToolkitSettings({
  toolkits,
  runtime,
  disabled,
  change,
  onChange,
}: {
  readonly toolkits: ComputeLanguageRuntimeInventory["toolkits"];
  readonly runtime: ComputeManagedRuntimeController;
  readonly disabled: boolean;
  readonly change: ToolkitChange | null;
  readonly onChange: (change: ToolkitChange | null) => void;
}) {
  const submitting = useRef(false);
  const requests = useRef(new Set<ComputeToolkitId>());
  const [pendingActions, setPendingActions] = useState<
    ReadonlyMap<ComputeToolkitId, "install" | "remove" | "cancel">
  >(new Map());
  const [requestErrors, setRequestErrors] = useState<
    ReadonlyMap<
      ComputeToolkitId,
      { readonly intent: ToolkitChange; readonly action: "install" | "remove" | "cancel" }
    >
  >(new Map());
  const queuedCommands = runtime.status?.toolkitChanges !== undefined;
  const installed = new Set(runtime.status?.toolkitIds ?? []);
  // The server promotes a verified generation atomically. Cancellation and errors
  // leave the installed set intact; only the server receipt changes these rows.
  useEffect(() => {
    if (
      change &&
      ((!runtime.busy && !runtime.failure) ||
        (runtime.status?.operation && runtime.status.operation.action !== "update") ||
        (runtime.failure && runtime.failure.retryAction !== "update"))
    )
      onChange(null);
  }, [change, runtime.busy, runtime.failure, runtime.status?.operation, onChange]);
  const apply = (next: ToolkitChange) => {
    if (queuedCommands) {
      void send(next, next.install ? "install" : "remove");
      return;
    }
    if (submitting.current || disabled || runtime.busy || !runtime.status?.installed) return;
    // Rebase retries on the latest installed set, preserving other clients' changes.
    const ids = new Set(runtime.status.toolkitIds ?? []);
    for (const required of toolkits.filter((item) => item.required)) ids.add(required.toolkitId);
    if (next.install) ids.add(next.toolkitId);
    else ids.delete(next.toolkitId);
    onChange(next);
    submitting.current = true;
    void runtime.act("update", { toolkitIds: [...ids] }).finally(() => {
      submitting.current = false;
    });
  };
  const send = async (next: ToolkitChange, action: "install" | "remove" | "cancel") => {
    if (disabled || requests.current.has(next.toolkitId)) return;
    requests.current.add(next.toolkitId);
    setPendingActions((current) => new Map(current).set(next.toolkitId, action));
    setRequestErrors((current) => {
      const updated = new Map(current);
      updated.delete(next.toolkitId);
      return updated;
    });
    try {
      const accepted = await runtime.act("update", {
        toolkitChange: { toolkitId: next.toolkitId, action },
      });
      if (!accepted)
        setRequestErrors((current) =>
          new Map(current).set(next.toolkitId, { intent: next, action }),
        );
    } finally {
      requests.current.delete(next.toolkitId);
      setPendingActions((current) => {
        const updated = new Map(current);
        updated.delete(next.toolkitId);
        return updated;
      });
    }
  };
  return (
    <>
      {toolkits.map((toolkit) => {
        const active = change?.toolkitId === toolkit.toolkitId;
        const entry = runtime.status?.toolkitChanges?.find(
          (item) => item.toolkitId === toolkit.toolkitId,
        );
        const pending = pendingActions.has(toolkit.toolkitId);
        const requestError = requestErrors.get(toolkit.toolkitId);
        const rowBusy = pending || entry?.state === "queued" || entry?.state === "running";
        const phase = runtime.status?.operation?.phase;
        const label =
          pendingActions.get(toolkit.toolkitId) === "cancel"
            ? "Cancelling…"
            : pending
              ? "Requesting…"
              : entry?.state === "queued"
                ? "Queued"
                : entry?.install === false
                  ? "Removing…"
                  : phase === "verifying"
                    ? "Checking…"
                    : phase === "installing-packages"
                      ? "Installing…"
                      : "Preparing…";
        const present = installed.has(toolkit.toolkitId);
        const available = runtime.status?.installed === true;
        const update = (add: boolean) => {
          apply({ toolkitId: toolkit.toolkitId, install: add });
        };
        return (
          <SettingsRow
            key={toolkit.toolkitId}
            title={toolkit.displayName}
            description={toolkit.summary}
            className="sm:[&>div]:grid-cols-[minmax(0,1fr)_auto] [&>div>div>p]:max-w-none"
            status={
              !queuedCommands && active && runtime.failure ? (
                <ManagedRuntimeNotice runtime={runtime} />
              ) : undefined
            }
            control={
              toolkit.required ? (
                <span className="text-xs text-muted-foreground">Included</span>
              ) : queuedCommands && rowBusy ? (
                <div
                  className="flex items-center gap-1"
                  role="status"
                  aria-label={`${toolkit.displayName}: ${label}`}
                >
                  <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={disabled || pending}
                    aria-label={`Cancel ${toolkit.displayName}`}
                    onClick={() =>
                      void send(
                        { toolkitId: toolkit.toolkitId, install: entry?.install ?? true },
                        "cancel",
                      )
                    }
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              ) : queuedCommands && (entry?.state === "failed" || requestError) ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={disabled}
                        onClick={() =>
                          requestError
                            ? void send(requestError.intent, requestError.action)
                            : apply({
                                toolkitId: toolkit.toolkitId,
                                install: entry?.install ?? true,
                              })
                        }
                      />
                    }
                  >
                    Retry
                  </TooltipTrigger>
                  <TooltipPopup>
                    {entry?.error ?? runtime.failure?.detail ?? "The request could not be sent."}
                  </TooltipPopup>
                </Tooltip>
              ) : active && runtime.busy ? (
                <ManagedRuntimeNotice runtime={runtime} variant="toolbar" />
              ) : active && runtime.failure?.retryAction === "update" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => apply(change)}
                >
                  Retry
                </Button>
              ) : present ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">Installed</span>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={`Manage ${toolkit.displayName}`}
                          disabled={disabled}
                        />
                      }
                    >
                      <MoreHorizontalIcon />
                    </MenuTrigger>
                    <MenuPopup align="end" className="w-max [&>div]:p-0.5">
                      <MenuItem
                        variant="destructive"
                        className="min-h-6 py-0 text-sm sm:min-h-6"
                        disabled={disabled}
                        onClick={() => update(false)}
                      >
                        Remove
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="inline-flex" tabIndex={!available ? 0 : undefined} />}
                  >
                    <Button
                      size="xs"
                      variant="outline"
                      aria-label={`Download ${toolkit.displayName}`}
                      disabled={disabled || !available}
                      onClick={() => update(true)}
                    >
                      <DownloadIcon aria-hidden /> Download
                    </Button>
                  </TooltipTrigger>
                  <TooltipPopup>
                    {!available
                      ? "Set up Scient-managed Python first"
                      : "Download into Scient-managed Python"}
                  </TooltipPopup>
                </Tooltip>
              )
            }
          >
            <details className="mt-1 text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer">Packages</summary>
              <p className="mt-1 break-words">
                {toolkit.packageRequirements.map((item) => item.displayName).join(", ")}
              </p>
            </details>
          </SettingsRow>
        );
      })}
    </>
  );
}

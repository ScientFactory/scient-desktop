import type { EnvironmentId, ToolHostPermission } from "@t3tools/contracts";
import { useState } from "react";

import { MacAccessibilityIcon, MacScreenRecordingIcon } from "~/components/Icons";
import { PermissionChecklist } from "~/components/permissions/PermissionChecklist";
import { usePermissionStatus } from "~/components/permissions/usePermissionStatus";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { usePrimaryEnvironmentId } from "~/state/environments";

import {
  COMPUTER_CONTROL_PERMISSIONS as ALL,
  COMPUTER_CONTROL_PERMISSION_COPY as COPY,
  computerControlPermissionDescription,
} from "./ComputerControlPermissions.logic";

const desktopBridge = () => (typeof window === "undefined" ? undefined : window.desktopBridge);

/** This window can check and open the panes only for the Mac it runs on. */
function useComputerControlPermissionsHere(environmentId: EnvironmentId | null): boolean {
  const primary = usePrimaryEnvironmentId();
  const bridge = desktopBridge();
  return (
    bridge?.getClientPlatform?.() === "darwin" &&
    environmentId !== null &&
    environmentId === primary
  );
}

const check = async (): Promise<Record<ToolHostPermission, boolean>> => {
  const bridge = desktopBridge();
  if (!bridge) throw new Error("Permission status unavailable");
  const [screen, accessibility] = await Promise.all([
    bridge.checkSystemPermission("screen-recording"),
    bridge.checkSystemPermission("accessibility"),
  ]);
  return { "screen-recording": screen, accessibility };
};

/**
 * Both panes with live status. Allow asks macOS first, which lists Scient in the pane, then
 * opens the pane, so the user only turns Scient on.
 */
function ComputerControlPermissionChecklist({
  status,
}: {
  status: Record<ToolHostPermission, boolean>;
}) {
  const [requested, setRequested] = useState<ReadonlySet<ToolHostPermission>>(new Set());
  return (
    <PermissionChecklist
      permissions={ALL.map((permission) => ({
        id: permission,
        icon:
          permission === "screen-recording" ? (
            <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />
          ) : (
            <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />
          ),
        title: COPY[permission].title,
        description: computerControlPermissionDescription(permission, {
          granted: status[permission],
          requested: requested.has(permission),
        }),
        granted: status[permission],
        onAllow: () => {
          setRequested((current) => new Set(current).add(permission));
          void desktopBridge()?.openSystemSettings(permission);
        },
      }))}
    />
  );
}

const useComputerControlPermissionStatus = () =>
  usePermissionStatus(check, { "screen-recording": false, accessibility: false });

/** Polls only while shown on the Mac running the conversation. */
function LiveComputerControlPermissions({ refused }: { refused: boolean }) {
  const { status } = useComputerControlPermissionStatus();
  const ready = ALL.every((permission) => status[permission]);
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">
        {ready
          ? refused
            ? "Both permissions are on. Ask the agent to try again."
            : "Both permissions are on."
          : "The agent needs two macOS permissions for Scient. Click Allow on each and turn Scient on in the pane that opens; macOS lists Scient for you."}
      </p>
      <ComputerControlPermissionChecklist status={status} />
    </div>
  );
}

/**
 * Shown under a computer call macOS refused. On the Mac running the conversation it offers
 * both panes. Elsewhere macOS charges the app that started the agent there, which may be a
 * terminal, so it points to the app the agent named.
 */
export function ComputerControlPermissionNotice({
  permissions,
  environmentId,
}: {
  permissions: ReadonlyArray<ToolHostPermission>;
  environmentId: EnvironmentId | null;
}) {
  const here = useComputerControlPermissionsHere(environmentId);
  if (permissions.length === 0) return null;
  return (
    <div className="mt-1 ms-7 max-w-md text-sm" data-computer-control-permissions>
      {here ? (
        <LiveComputerControlPermissions refused />
      ) : (
        <p className="text-muted-foreground">
          macOS refused the agent on the Mac running this conversation. On that Mac, open System
          Settings → Privacy & Security → {permissions.map((p) => COPY[p].title).join(" and ")} and
          turn on the app the agent named in its message.
        </p>
      )}
    </div>
  );
}

const computerControlOn = (config: unknown) =>
  !(
    typeof config === "object" &&
    config !== null &&
    (config as Record<string, unknown>).computerControl === false
  );

/** The Scient Agent card shows these panes while computer control is on, on the Mac it runs on. */
export function ScientAgentComputerControlPermissionsRow({
  config,
  environmentId,
}: {
  config: unknown;
  environmentId: EnvironmentId;
}) {
  const here = useComputerControlPermissionsHere(environmentId);
  if (!here || !computerControlOn(config)) return null;
  return (
    <SettingsRow
      title="macOS permissions"
      description="What macOS asks before the agent can see and use other apps."
    >
      <LiveComputerControlPermissions refused={false} />
    </SettingsRow>
  );
}

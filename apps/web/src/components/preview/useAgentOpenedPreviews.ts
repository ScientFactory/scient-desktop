import type { DeviceServiceState, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import {
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerState,
} from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore, type RightPanelSurface } from "../../rightPanelStore";
// SCIENT-FORK:START — browser presentation intents (including hide requests) have one owner.
import { useScientBrowserPresentation } from "../../scient/previewPresentation/useScientBrowserPresentation";
// SCIENT-FORK:END

const selectAutoShowFloatingPreview = (settings: { browserAutoShowFloatingPreview: boolean }) =>
  settings.browserAutoShowFloatingPreview;

/**
 * Shows browsers and devices an agent or another client opened for the thread,
 * and closes a floating device once its session ends.
 */
export function useAgentOpenedPreviews(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly deviceState: DeviceServiceState;
  readonly deviceStateLoaded: boolean;
  readonly previewState: ThreadPreviewState;
  // Whether the environment hosts browser tabs for this client.
  readonly serverBrowserAvailable: boolean;
  readonly panelSurfaces: ReadonlyArray<RightPanelSurface>;
  // SCIENT-FORK:START — the floating player holds tagged content (browser, device or figure).
  readonly miniPlayerSource: PreviewMiniPlayerState["content"] | null;
  // SCIENT-FORK:END
  // Sheet layouts show neither floating previews nor auto-opened device tabs.
  readonly sheetLayout: boolean;
}) {
  const {
    threadRef,
    deviceState,
    deviceStateLoaded,
    previewState,
    serverBrowserAvailable,
    panelSurfaces,
    miniPlayerSource,
    sheetLayout,
  } = input;
  const autoShowFloatingPreview = useClientSettings(selectAutoShowFloatingPreview);
  // A device the agent opens floats over chat like an agent-driven browser,
  // or becomes a panel tab when floating previews are off. Sessions opened by
  // another client arrive the same way; sheet layouts get neither. The first
  // snapshot is a baseline: persisted tabs restore themselves, and existing
  // sessions must not resurrect closed tabs. A session whose device summary
  // has not arrived yet stays out of the baseline so a later snapshot opens it.
  const previousDeviceSessions = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const threadKey = `${threadRef.environmentId}:${threadRef.threadId}`;
    const sessions = deviceState.sessions.filter(
      (session) => session.threadId === threadRef.threadId,
    );
    const key = (session: (typeof sessions)[number]) => `${session.hostId}:${session.deviceId}`;
    const deviceFor = (session: (typeof sessions)[number]) =>
      deviceState.devices.find(
        (entry) => entry.hostId === session.hostId && entry.id === session.deviceId,
      );
    const previous = previousDeviceSessions.current.get(threadKey);
    previousDeviceSessions.current.set(
      threadKey,
      new Set(sessions.filter((session) => deviceFor(session) !== undefined).map(key)),
    );
    if (!previous || sheetLayout) return;
    for (const session of sessions) {
      if (previous.has(key(session))) continue;
      const device = deviceFor(session);
      if (!device) continue;
      const target = {
        hostId: session.hostId,
        deviceId: session.deviceId,
        platform: device.platform,
        name: device.name,
      };
      if (autoShowFloatingPreview) {
        usePreviewMiniPlayerStore.getState().open(threadRef, { kind: "device", ...target });
        continue;
      }
      const existing = useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.some(
          (surface) =>
            surface.kind === "device" &&
            surface.target?.hostId === session.hostId &&
            surface.target.deviceId === session.deviceId,
        );
      if (existing) continue;
      useRightPanelStore.getState().openDevice(threadRef, target, true);
    }
  }, [
    threadRef,
    autoShowFloatingPreview,
    deviceStateLoaded,
    sheetLayout,
    deviceState.sessions,
    deviceState.devices,
  ]);
  // SCIENT-FORK:START — agent-revealed server browsers follow the Scient presentation owner, which
  // also honours an agent asking to hide its browser.
  useScientBrowserPresentation({
    threadRef,
    serverBrowserAvailable,
    previewState,
    autoShowFloatingPreview,
    surfaces: panelSurfaces,
  });
  // SCIENT-FORK:END
  // A floating device follows its session: once the agent or another client
  // closes the device there is nothing left to stream.
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const source = miniPlayerSource;
    if (source?.kind !== "device") return;
    const sessionStillExists = deviceState.sessions.some(
      (session) =>
        session.threadId === threadRef.threadId &&
        session.hostId === source.hostId &&
        session.deviceId === source.deviceId,
    );
    if (!sessionStillExists) usePreviewMiniPlayerStore.getState().close(threadRef);
  }, [miniPlayerSource, threadRef, deviceState.sessions, deviceStateLoaded]);
}

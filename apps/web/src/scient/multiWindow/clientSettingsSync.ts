import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";

import { ensureLocalApi } from "~/localApi";

import { browserWindowLocks, runWithWindowLock } from "./windowLocks";

const CLIENT_SETTINGS_WRITE_LOCK = "scient-client-settings-write";

interface UnsavedPatch {
  readonly patch: ClientSettingsPatch;
}

/**
 * Desktop app windows share the saved client settings. Each write saves a whole snapshot, so
 * windows take turns and read the saved settings first; a stale snapshot would otherwise revert
 * another window's change.
 */
export function createClientSettingsWindowSync(settings: {
  readonly isHydrated: () => boolean;
  readonly current: () => ClientSettings;
  readonly replace: (next: ClientSettings) => void;
  /** Takes saved settings in place of the pending hydration read, whose result is discarded. */
  readonly hydrateWith: (saved: ClientSettings) => void;
}) {
  // Patches applied to this window's snapshot that are not yet saved, oldest first.
  const unsaved = new Set<UnsavedPatch>();
  let notQueued: UnsavedPatch[] = [];
  let stopListening: (() => void) | null = null;

  const applySaved = (saved: ClientSettings): void => {
    const next: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS, ...saved };
    if (!settings.isHydrated()) {
      // They are what the pending read would return, or newer.
      settings.hydrateWith(next);
      return;
    }
    for (const { patch } of unsaved) Object.assign(next, patch);
    if (!Equal.equals(next, settings.current())) settings.replace(next);
  };

  /** Whether other windows can save these settings, as in the multi-window desktop app. */
  const listen = (): boolean => {
    if (stopListening === null && typeof window !== "undefined") {
      stopListening = window.desktopBridge?.onClientSettingsChanged?.(applySaved) ?? null;
    }
    return stopListening !== null;
  };

  const runWrite = <A>(work: () => Promise<A>): Promise<A> => {
    const locks = listen() ? browserWindowLocks() : null;
    if (locks === null) return work();
    return runWithWindowLock(locks, CLIENT_SETTINGS_WRITE_LOCK, async () => {
      if (settings.isHydrated()) {
        const saved = await ensureLocalApi()
          .persistence.getClientSettings()
          .catch(() => null);
        if (saved) applySaved(saved);
      }
      return work();
    });
  };

  return {
    listen,
    /** Keeps `patch` over settings other windows save until the next queued write settles. */
    holdPatch: (patch: ClientSettingsPatch): void => {
      const entry = { patch };
      unsaved.add(entry);
      notQueued.push(entry);
    },
    /** The queued step that runs `work`, releasing the patches held since the last one. */
    queuedWrite: <A>(work: () => Promise<A>): (() => Promise<A>) => {
      const held = notQueued;
      notQueued = [];
      return () =>
        runWrite(work).finally(() => {
          for (const entry of held) unsaved.delete(entry);
        });
    },
    reset: (): void => {
      unsaved.clear();
      notQueued = [];
      stopListening?.();
      stopListening = null;
    },
  };
}

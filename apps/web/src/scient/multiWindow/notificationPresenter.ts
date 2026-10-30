import { useSyncExternalStore } from "react";

import { browserWindowLocks, type WindowLocks } from "./windowLocks";

export const NOTIFICATION_PRESENTER_LOCK = "scient-thread-notifications-presenter";

export interface NotificationPresenter {
  readonly isPresenter: () => boolean;
  readonly stop: () => void;
}

interface PresenterOptions {
  readonly locks: WindowLocks | null;
  readonly name: string;
  readonly focusTarget: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly hasFocus: () => boolean;
  readonly onChange?: () => void;
}

function windowLocks() {
  return typeof window === "undefined" || window.desktopBridge === undefined
    ? null
    : browserWindowLocks();
}

/**
 * Desktop app windows elect one presenter for sounds, system notifications and the app badge, so
 * each fires once. Focus claims the role; when the presenter closes, a waiting window takes over.
 * Without Web Locks, or outside the desktop app, every window presents.
 */
export function electNotificationPresenter(options: PresenterOptions): NotificationPresenter {
  const { locks, name, focusTarget, hasFocus, onChange } = options;
  if (locks === null) return { isPresenter: () => true, stop: () => undefined };

  let presenter = false;
  let stopped = false;
  let attempt = 0;
  let queued: AbortController | null = null;
  let release: (() => void) | null = null;

  const setPresenter = (next: boolean) => {
    if (presenter === next) return;
    presenter = next;
    onChange?.();
  };
  const claim = (steal: boolean) => {
    const current = ++attempt;
    queued?.abort();
    queued = steal ? null : new AbortController();
    const lockOptions: LockOptions = queued === null ? { steal: true } : { signal: queued.signal };
    locks
      .request(name, lockOptions, () => {
        if (stopped || current !== attempt) return undefined;
        queued = null;
        setPresenter(true);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => {
        // Superseded requests were aborted on purpose; a stolen role waits for its next turn.
        if (current !== attempt) return;
        release = null;
        setPresenter(false);
        if (!stopped) claim(false);
      });
  };
  const onFocus = () => {
    if (!presenter) claim(true);
  };

  focusTarget.addEventListener("focus", onFocus);
  claim(hasFocus());
  return {
    isPresenter: () => presenter,
    stop: () => {
      if (stopped) return;
      stopped = true;
      attempt += 1;
      focusTarget.removeEventListener("focus", onFocus);
      queued?.abort();
      release?.();
      presenter = false;
    },
  };
}

// One election per window: two requests from the same window would contend with each other.
const presenterListeners = new Set<() => void>();
let shared: { readonly presenter: NotificationPresenter; users: number } | null = null;

/** Joins this window's election; release when done. */
export function acquireNotificationPresenter(): NotificationPresenter {
  shared ??= {
    presenter: electNotificationPresenter({
      locks: windowLocks(),
      name: NOTIFICATION_PRESENTER_LOCK,
      focusTarget: window,
      hasFocus: () => document.hasFocus(),
      onChange: () => {
        for (const listener of presenterListeners) listener();
      },
    }),
    users: 0,
  };
  const lease = shared;
  lease.users += 1;
  let released = false;
  return {
    isPresenter: lease.presenter.isPresenter,
    stop: () => {
      if (released) return;
      released = true;
      lease.users -= 1;
      if (lease.users > 0) return;
      lease.presenter.stop();
      if (shared === lease) shared = null;
    },
  };
}

function subscribePresenter(listener: () => void) {
  presenterListeners.add(listener);
  const lease = acquireNotificationPresenter();
  return () => {
    presenterListeners.delete(listener);
    lease.stop();
  };
}

function isWindowPresenter() {
  return shared === null ? windowLocks() === null : shared.presenter.isPresenter();
}

export function useIsNotificationPresenter(): boolean {
  return useSyncExternalStore(subscribePresenter, isWindowPresenter, () => true);
}

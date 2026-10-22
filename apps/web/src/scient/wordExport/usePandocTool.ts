import { useStableCallback } from "~/hooks/useStableCallback";
import type { EnvironmentId, ScientPandocToolStatus } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { installPandocTool, readPandocTool } from "./client";
import { isActivePandocInstall, pandocToolView, type PandocToolView } from "./pandocToolModel";

/** A poll every 1.5 s is as fine as the server republishes download progress. */
const PANDOC_INSTALL_POLL_MS = 1_500;

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

// Outside the hook: the React Compiler does not compile try/finally in a component.
async function settlePandocRequest(
  request: () => Promise<ScientPandocToolStatus>,
  accept: (status: ScientPandocToolStatus) => void,
  fail: (cause: unknown) => void,
  settle: () => void,
): Promise<void> {
  try {
    accept(await request());
  } catch (cause) {
    fail(cause);
  } finally {
    settle();
  }
}

export interface PandocToolController {
  readonly status: ScientPandocToolStatus | null;
  readonly view: PandocToolView;
  /** Starts the install or reinstall, or retries reading the status when it could not be read. */
  readonly act: () => void;
  /**
   * Reads the status again. Call it after a Word export fails: the server
   * may have found that its Pandoc does not start, which turns the view into
   * the reinstall offer.
   */
  readonly refresh: () => void;
  /** A status read is in flight; the install waits for its answer. */
  readonly checking: boolean;
}

/**
 * The managed Pandoc on one environment: its status, polled while an install
 * runs, and the install action. `onInstalled` runs once when an install this
 * control watched finishes. Mount it once per environment.
 */
export function usePandocTool(
  environmentId: EnvironmentId,
  onInstalled?: () => void,
): PandocToolController {
  const [status, setStatus] = useState<ScientPandocToolStatus | null>(null);
  const [error, setError] = useState<{
    readonly message: string;
    readonly fromCheck: boolean;
  } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [checks, setChecks] = useState(0);
  const onInstalledRef = useRef(onInstalled);
  useLayoutEffect(() => {
    onInstalledRef.current = onInstalled;
  });
  const wasInstalledRef = useRef<boolean | null>(null);
  // Status reads take a number and only the most recently started one may
  // change what is shown. While an install request waits for its answer, that
  // answer is in charge: reads finishing meanwhile, or started before it
  // arrived, describe the server from before the install and are set aside.
  const latestReadRef = useRef(0);
  const staleUpToRef = useRef(0);
  const installRef = useRef<number | null>(null);
  const installsRef = useRef(0);

  const accept = useStableCallback((next: ScientPandocToolStatus) => {
    // Pandoc became installed after a state that was not: missing, or not
    // known because a check failed. Callers recheck what depends on it.
    if (wasInstalledRef.current !== true && wasInstalledRef.current !== null && next.installed)
      onInstalledRef.current?.();
    wasInstalledRef.current = next.installed;
    setStatus(next);
  });

  const read = () => {
    const request = ++latestReadRef.current;
    const current = () =>
      request === latestReadRef.current &&
      request > staleUpToRef.current &&
      installRef.current === null;
    // Counted from the next microtask, so the read that mounting starts does
    // not re-render the effect that started it; it settles later still.
    queueMicrotask(() => setChecks((count) => count + 1));
    return settlePandocRequest(
      () => readPandocTool(environmentId),
      (next) => {
        if (!current()) return;
        accept(next);
        setError(null);
      },
      (cause) => {
        if (!current()) return;
        if (wasInstalledRef.current !== true) wasInstalledRef.current = false;
        setError({
          message: errorMessage(cause, "Scient could not check Word export on this server."),
          fromCheck: true,
        });
      },
      () => setChecks((count) => count - 1),
    );
  };

  useEffect(() => {
    void read();
    return () => {
      // Nothing this environment answers later applies.
      staleUpToRef.current = ++latestReadRef.current;
      installRef.current = null;
      installsRef.current++;
      setRequesting(false);
    };
  }, [read]);

  useEffect(() => {
    if (!isActivePandocInstall(status) || error !== null) return;
    const timer = setTimeout(() => void read(), PANDOC_INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [error, read, status]);

  const checking = checks > 0;
  const act = () => {
    if (error !== null || status === null) {
      void read();
      return;
    }
    if (
      checking ||
      requesting ||
      isActivePandocInstall(status) ||
      status.installed ||
      !status.canInstall
    )
      return;
    const request = ++installsRef.current;
    installRef.current = request;
    setRequesting(true);
    setError(null);
    const current = () => installRef.current === request;
    void settlePandocRequest(
      () => installPandocTool(environmentId),
      (next) => {
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        accept(next);
      },
      (cause) => {
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        setError({
          message: errorMessage(cause, "Scient could not start installing Pandoc."),
          fromCheck: false,
        });
      },
      () => {
        if (current()) {
          installRef.current = null;
          setRequesting(false);
        }
      },
    );
  };

  const refresh = () => void read();

  return {
    status,
    view: pandocToolView({
      status,
      requesting,
      error: error?.message ?? null,
      errorFromCheck: error?.fromCheck ?? false,
    }),
    act,
    refresh,
    checking,
  };
}

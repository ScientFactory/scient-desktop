import type { EnvironmentId, ScientPandocToolStatus } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { installPandocTool, readPandocTool } from "./client";
import { isActivePandocInstall, pandocToolView, type PandocToolView } from "./pandocToolModel";

/** A poll every 1.5 s is as fine as the server republishes download progress. */
const PANDOC_INSTALL_POLL_MS = 1_500;

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
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
  onInstalledRef.current = onInstalled;
  const wasInstalledRef = useRef<boolean | null>(null);
  // Status reads take a number and only the most recently started one may
  // change what is shown. While an install request waits for its answer, that
  // answer is in charge: reads finishing meanwhile, or started before it
  // arrived, describe the server from before the install and are set aside.
  const latestReadRef = useRef(0);
  const staleUpToRef = useRef(0);
  const installRef = useRef<number | null>(null);
  const installsRef = useRef(0);

  const accept = useCallback((next: ScientPandocToolStatus) => {
    // Pandoc became installed after a state that was not: missing, or not
    // known because a check failed. Callers recheck what depends on it.
    if (wasInstalledRef.current !== true && wasInstalledRef.current !== null && next.installed)
      onInstalledRef.current?.();
    wasInstalledRef.current = next.installed;
    setStatus(next);
  }, []);

  const read = useCallback(async () => {
    const request = ++latestReadRef.current;
    const current = () =>
      request === latestReadRef.current &&
      request > staleUpToRef.current &&
      installRef.current === null;
    setChecks((count) => count + 1);
    try {
      const next = await readPandocTool(environmentId);
      if (!current()) return;
      accept(next);
      setError(null);
    } catch (cause) {
      if (!current()) return;
      if (wasInstalledRef.current !== true) wasInstalledRef.current = false;
      setError({
        message: errorMessage(cause, "Scient could not check Word export on this server."),
        fromCheck: true,
      });
    } finally {
      setChecks((count) => count - 1);
    }
  }, [accept, environmentId]);

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

  const active = isActivePandocInstall(status);
  useEffect(() => {
    if (!active || error !== null) return;
    const timer = setTimeout(() => void read(), PANDOC_INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [active, error, read, status]);

  const checking = checks > 0;
  const act = useCallback(() => {
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
    void (async () => {
      try {
        const next = await installPandocTool(environmentId);
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        accept(next);
      } catch (cause) {
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        setError({
          message: errorMessage(cause, "Scient could not start installing Pandoc."),
          fromCheck: false,
        });
      } finally {
        if (current()) {
          installRef.current = null;
          setRequesting(false);
        }
      }
    })();
  }, [accept, checking, environmentId, error, read, requesting, status]);

  const refresh = useCallback(() => void read(), [read]);

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

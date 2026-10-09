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
  // Every request (a status read or the install) takes a number; only the most
  // recently started one may change what is shown. An older answer, a poll
  // overtaken by a refresh, or a read from before an install, can never
  // undo a newer state.
  const latestRef = useRef(0);

  const accept = useCallback((next: ScientPandocToolStatus) => {
    // Pandoc became installed after a state that was not: missing, or not
    // known because a check failed. Callers recheck what depends on it.
    if (wasInstalledRef.current !== true && wasInstalledRef.current !== null && next.installed)
      onInstalledRef.current?.();
    wasInstalledRef.current = next.installed;
    setStatus(next);
  }, []);

  const read = useCallback(async () => {
    const request = ++latestRef.current;
    setChecks((count) => count + 1);
    try {
      const next = await readPandocTool(environmentId);
      if (request !== latestRef.current) return;
      accept(next);
      setError(null);
      // A newer read stands in for an install answer it overtook.
      setRequesting(false);
    } catch (cause) {
      if (request !== latestRef.current) return;
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
      latestRef.current++;
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
    const request = ++latestRef.current;
    setRequesting(true);
    setError(null);
    void (async () => {
      try {
        const next = await installPandocTool(environmentId);
        if (request !== latestRef.current) return;
        accept(next);
      } catch (cause) {
        if (request !== latestRef.current) return;
        setError({
          message: errorMessage(cause, "Scient could not start installing Pandoc."),
          fromCheck: false,
        });
      } finally {
        if (request === latestRef.current) setRequesting(false);
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

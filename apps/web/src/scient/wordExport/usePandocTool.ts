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
  /** Starts the install, or retries reading the status when it could not be read. */
  readonly act: () => void;
}

/**
 * The managed Pandoc on one environment: its status, polled while an install
 * runs, and the install action. `onInstalled` runs once when an install this
 * control watched finishes.
 */
export function usePandocTool(
  environmentId: EnvironmentId,
  onInstalled?: () => void,
): PandocToolController {
  const [status, setStatus] = useState<ScientPandocToolStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;
  const wasInstalledRef = useRef<boolean | null>(null);

  const accept = useCallback((next: ScientPandocToolStatus) => {
    if (wasInstalledRef.current === false && next.installed) onInstalledRef.current?.();
    wasInstalledRef.current = next.installed;
    setStatus(next);
  }, []);

  const read = useCallback(async () => {
    try {
      accept(await readPandocTool(environmentId));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, "Scient could not check Word export on this server."));
    }
  }, [accept, environmentId]);

  useEffect(() => {
    void read();
  }, [read]);

  const active = isActivePandocInstall(status);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void read(), PANDOC_INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [active, read, status]);

  const act = useCallback(() => {
    if (status === null) {
      void read();
      return;
    }
    setRequesting(true);
    setError(null);
    installPandocTool(environmentId).then(
      (next) => {
        accept(next);
        setRequesting(false);
      },
      (cause: unknown) => {
        setError(errorMessage(cause, "Scient could not start installing Pandoc."));
        setRequesting(false);
      },
    );
  }, [accept, environmentId, read, status]);

  return { status, view: pandocToolView({ status, requesting, error }), act };
}

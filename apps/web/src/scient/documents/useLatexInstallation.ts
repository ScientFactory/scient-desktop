import type { EnvironmentId, ScientLatexToolchainReport } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readLatexToolchain, requestLatexToolchainInstall } from "../latex/client";
import { isActiveLatexInstall } from "../latex/latexToolchainSetupModel";
import { latexInstallationView, type LatexInstallationView } from "./latexInstallationModel";

/** As fine as the server republishes download progress. */
const LATEX_INSTALL_POLL_MS = 1_500;

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export interface LatexInstallationController {
  readonly view: LatexInstallationView;
  /** Installs TinyTeX, or retries reading the engine when it could not be read. */
  readonly act: () => void;
  /** Looks for an engine again, for one installed outside Scient since. */
  readonly refresh: () => Promise<void>;
  readonly refreshing: boolean;
}

/**
 * The LaTeX engine on one environment, polled while an install runs. Mount it
 * once per environment (key the caller by environment id).
 */
export function useLatexInstallation(environmentId: EnvironmentId): LatexInstallationController {
  const [report, setReport] = useState<ScientLatexToolchainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Every request (a read or the install) takes a number; only the most
  // recently started one may change what is shown, so an older answer can
  // never hide an install or stop its polling.
  const latestRef = useRef(0);

  const read = useCallback(
    async (refresh: boolean) => {
      const request = ++latestRef.current;
      try {
        const next = await readLatexToolchain(environmentId, { refresh });
        if (request !== latestRef.current) return;
        setReport(next);
        setError(null);
        // A newer read stands in for an install answer it overtook.
        setRequesting(false);
      } catch (cause) {
        if (request !== latestRef.current) return;
        setError(errorMessage(cause, "Scient could not check LaTeX on this server."));
      }
    },
    [environmentId],
  );

  useEffect(() => {
    void read(false);
    return () => {
      // Answers for the previous environment, an install request included, are void.
      latestRef.current++;
      setRequesting(false);
    };
  }, [read]);

  const active = isActiveLatexInstall(report?.managedInstall ?? null);
  useEffect(() => {
    if (!active || error !== null) return;
    const timer = setTimeout(() => void read(false), LATEX_INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [active, error, read, report]);

  const act = useCallback(() => {
    if (error !== null || report === null) {
      void read(false);
      return;
    }
    if (requesting || refreshing || active || !report.canInstallManaged) return;
    const request = ++latestRef.current;
    setRequesting(true);
    setError(null);
    void (async () => {
      try {
        const managedInstall = await requestLatexToolchainInstall(environmentId);
        if (request !== latestRef.current) return;
        setReport((current) => (current === null ? current : { ...current, managedInstall }));
      } catch (cause) {
        if (request !== latestRef.current) return;
        setError(errorMessage(cause, "Scient could not start installing TinyTeX."));
      } finally {
        if (request === latestRef.current) setRequesting(false);
      }
    })();
  }, [active, environmentId, error, read, refreshing, report, requesting]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await read(true);
    } finally {
      setRefreshing(false);
    }
  }, [read]);

  return {
    view: latexInstallationView({ report, requesting, error }),
    act,
    refresh,
    refreshing,
  };
}

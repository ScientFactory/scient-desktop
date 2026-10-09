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
  // Reads take a number and only the most recently started one may change
  // what is shown. While an install request waits for its answer, that answer
  // is in charge: reads finishing meanwhile, or started before it arrived,
  // describe the server from before the install and are set aside.
  const latestReadRef = useRef(0);
  const staleUpToRef = useRef(0);
  const installRef = useRef<number | null>(null);
  const installsRef = useRef(0);

  const read = useCallback(
    async (refresh: boolean) => {
      const request = ++latestReadRef.current;
      const current = () =>
        request === latestReadRef.current &&
        request > staleUpToRef.current &&
        installRef.current === null;
      try {
        const next = await readLatexToolchain(environmentId, { refresh });
        if (!current()) return;
        setReport(next);
        setError(null);
      } catch (cause) {
        if (!current()) return;
        setError(errorMessage(cause, "Scient could not check LaTeX on this server."));
      }
    },
    [environmentId],
  );

  useEffect(() => {
    void read(false);
    return () => {
      // Answers for the previous environment, an install request included, are void.
      staleUpToRef.current = ++latestReadRef.current;
      installRef.current = null;
      installsRef.current++;
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
    const request = ++installsRef.current;
    installRef.current = request;
    setRequesting(true);
    setError(null);
    const current = () => installRef.current === request;
    void (async () => {
      try {
        const managedInstall = await requestLatexToolchainInstall(environmentId);
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        setReport((report) => (report === null ? report : { ...report, managedInstall }));
      } catch (cause) {
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        setError(errorMessage(cause, "Scient could not start installing TinyTeX."));
      } finally {
        if (current()) {
          installRef.current = null;
          setRequesting(false);
        }
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

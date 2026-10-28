import type { EnvironmentId, ScientLatexToolchainReport } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { readLatexToolchain, requestLatexToolchainInstall } from "../latex/client";
import { isActiveLatexInstall } from "../latex/latexToolchainSetupModel";
import {
  canInstallAdditionalLatexTools,
  latexInstallationView,
  type LatexInstallationView,
} from "./latexInstallationModel";

/** As fine as the server republishes download progress. */
const LATEX_INSTALL_POLL_MS = 1_500;

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

// Outside the hook: the React Compiler does not compile try/finally in a component.
async function settleLatexRequest<A>(
  request: () => Promise<A>,
  accept: (value: A) => void,
  fail: (cause: unknown) => void,
  settle: () => void = () => {},
): Promise<void> {
  try {
    accept(await request());
  } catch (cause) {
    fail(cause);
  } finally {
    settle();
  }
}

export interface LatexInstallationController {
  readonly view: LatexInstallationView;
  readonly report: ScientLatexToolchainReport | null;
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
  const [installError, setInstallError] = useState<string | null>(null);
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

  const read = (refresh: boolean) => {
    const request = ++latestReadRef.current;
    const current = () =>
      request === latestReadRef.current &&
      request > staleUpToRef.current &&
      installRef.current === null;
    return settleLatexRequest(
      () => readLatexToolchain(environmentId, { refresh }),
      (next) => {
        if (!current()) return;
        setReport(next);
        setError(null);
        setInstallError(null);
      },
      (cause) => {
        if (!current()) return;
        setError(errorMessage(cause, "Scient could not check LaTeX on this server."));
      },
    );
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the LaTeX installation over the environment connection, voiding stale replies when the environment changes or on unmount
  useEffect(() => {
    void read(false);
    return () => {
      // Answers for the previous environment, an install request included, are void.
      staleUpToRef.current = ++latestReadRef.current;
      installRef.current = null;
      installsRef.current++;
      setRequesting(false);
      setInstallError(null);
    };
  }, [read]);

  const active = isActiveLatexInstall(report?.managedInstall ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the installation status over the environment connection on a timer while an install is active
  useEffect(() => {
    if (!isActiveLatexInstall(report?.managedInstall ?? null) || error !== null) return;
    const timer = setTimeout(() => void read(false), LATEX_INSTALL_POLL_MS);
    return () => clearTimeout(timer);
  }, [error, read, report]);

  const act = () => {
    if (error !== null || report === null) {
      void read(false);
      return;
    }
    if (requesting || refreshing || active || !canInstallAdditionalLatexTools(report)) return;
    const request = ++installsRef.current;
    installRef.current = request;
    setRequesting(true);
    setError(null);
    setInstallError(null);
    const current = () => installRef.current === request;
    void settleLatexRequest(
      () => requestLatexToolchainInstall(environmentId),
      (managedInstall) => {
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        setReport((report) => (report === null ? report : { ...report, managedInstall }));
      },
      (cause) => {
        if (!current()) return;
        staleUpToRef.current = latestReadRef.current;
        setInstallError(errorMessage(cause, "Scient could not start installing TinyTeX."));
      },
      () => {
        if (current()) {
          installRef.current = null;
          setRequesting(false);
        }
      },
    );
  };

  const refresh = () => {
    setRefreshing(true);
    return settleLatexRequest(
      () => read(true),
      () => {},
      (cause) => {
        throw cause;
      },
      () => setRefreshing(false),
    );
  };

  return {
    view: latexInstallationView({ report, requesting, error, installError }),
    report,
    act,
    refresh,
    refreshing,
  };
}

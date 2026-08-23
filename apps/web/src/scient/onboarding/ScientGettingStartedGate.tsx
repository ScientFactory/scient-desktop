import { useAtomValue } from "@effect/atom-react";
import { useEffect, type ReactNode } from "react";

import { resolvePrimaryOperateAccess } from "../../components/settings/ProviderSettingsPanel.logic";
import { usePrimarySessionState } from "../../environments/primary";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom } from "../../state/server";
import { ScientGettingStartedFlow } from "./ScientGettingStartedFlow";
import { resolveScientOnboardingEntry } from "./policy";
import { useScientOnboardingStorage } from "./storage";

export function ScientGettingStartedGate(props: { readonly fallback: ReactNode }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const shellBootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const sessionState = usePrimarySessionState();
  const { state, complete } = useScientOnboardingStorage();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: typeof window !== "undefined" && Boolean(window.desktopBridge),
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.error !== null,
  });
  const decision = resolveScientOnboardingEntry({
    status: state.status,
    shellBootstrapped,
    primaryEnvironmentReady: primaryEnvironmentId !== null && primaryServerConfig !== null,
    operateAccess,
    hasExistingActivity: projects.length > 0 || threads.length > 0,
  });

  useEffect(() => {
    if (decision === "complete-silently") complete();
  }, [complete, decision]);

  if (decision === "wait") return null;
  if (decision === "present") return <ScientGettingStartedFlow mode="automatic" />;
  return props.fallback;
}

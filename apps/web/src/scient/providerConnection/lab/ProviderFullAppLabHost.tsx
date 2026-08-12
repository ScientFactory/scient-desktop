import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ProviderRuntimePlan, ServerProvider } from "@t3tools/contracts";
import { FlaskConicalIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "../../../components/ui/button";
import {
  ProviderLifecycleControllerProvider,
  type ProviderLifecycleController,
} from "../ProviderLifecycleController";
import {
  PROVIDER_LAB_ENABLED,
  activeProvider,
  connectionOperation,
  makeProviderLabState,
  nextProviderLabState,
  providerLabStateAtom,
  replaceActiveProvider,
  runtimeOperation,
  runtimePlan,
  setActiveProviderSnapshot,
  switchActiveProvider,
  type ProviderLabFailure,
  type ProviderLabDriver,
  type ProviderLabSnapshot,
  type ProviderLabState,
  type ProviderLabTarget,
} from "./providerLabState";

const snapshots: ReadonlyArray<{ readonly value: ProviderLabSnapshot; readonly label: string }> = [
  { value: "nothing-installed", label: "Nothing installed" },
  { value: "installed-signed-out", label: "Installed, signed out" },
  { value: "browser-sign-in", label: "Browser sign-in" },
  { value: "device-code", label: "Device code" },
  { value: "authorization-code", label: "One-time code" },
  { value: "authorization-code-expired", label: "Expired one-time code" },
  { value: "verifying", label: "Verifying" },
  { value: "connected", label: "Connected" },
  { value: "update-available", label: "Update available" },
  { value: "updating", label: "Updating" },
  { value: "update-failed", label: "Update failed" },
  { value: "install-failed", label: "Install failed" },
  { value: "sign-in-failed", label: "Sign-in failed" },
];

function ControllerHost({ children }: { readonly children: ReactNode }) {
  const state = useAtomValue(providerLabStateAtom);
  const setState = useAtomSet(providerLabStateAtom);
  const stateRef = useRef(state);
  const automationGenerationRef = useRef(0);
  const automationTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  stateRef.current = state;

  const commit = (next: ProviderLabState): ProviderLabState => {
    stateRef.current = next;
    setState(next);
    return next;
  };
  const cancelAutomation = () => {
    automationGenerationRef.current += 1;
    for (const timer of automationTimersRef.current) clearTimeout(timer);
    automationTimersRef.current.clear();
  };
  const commitManualState = (next: ProviderLabState): ProviderLabState => {
    cancelAutomation();
    return commit(next);
  };
  const scheduleAutomaticAdvance = (generation: number, remainingSteps: number) => {
    const timer = setTimeout(() => {
      automationTimersRef.current.delete(timer);
      if (automationGenerationRef.current !== generation) return;
      const next = nextProviderLabState(stateRef.current);
      if (!next) return;
      commit(next);
      if (remainingSteps > 1) scheduleAutomaticAdvance(generation, remainingSteps - 1);
    }, 850);
    automationTimersRef.current.add(timer);
  };
  useEffect(() => {
    return () => {
      for (const timer of automationTimersRef.current) clearTimeout(timer);
      automationTimersRef.current.clear();
    };
  }, []);
  const consumeFailure = (kind: Exclude<ProviderLabFailure, "none">, message: string) => {
    const current = stateRef.current;
    if (current.failure !== kind) return;
    commit({
      ...current,
      failure: "none",
      events: [`Injected failure: ${message}`, ...current.events],
    });
    throw new Error(message);
  };

  const controller = useMemo<ProviderLifecycleController>(
    () => ({
      planRuntime: async (action) => {
        consumeFailure("runtime", "The simulated setup plan could not be prepared.");
        return runtimePlan(action, stateRef.current.target, stateRef.current.driver);
      },
      startRuntime: async (plan: ProviderRuntimePlan) => {
        consumeFailure("runtime", "The simulated runtime operation failed before activation.");
        const generation = ++automationGenerationRef.current;
        const current = stateRef.current;
        const provider = activeProvider(current);
        const status = plan.action === "remove" ? "removing" : "downloading";
        const nextProvider: ServerProvider = {
          ...provider,
          connection: {
            ...provider.connection!,
            runtime: {
              ...provider.connection!.runtime!,
              operation: runtimeOperation(
                status,
                `Simulated runtime step: ${status}.`,
                plan.action,
              ),
            },
          },
        };
        const next = replaceActiveProvider(
          current,
          nextProvider,
          `Started simulated ${plan.action}.`,
        );
        commit({ ...next, snapshot: plan.action === "update" ? "updating" : next.snapshot });
        scheduleAutomaticAdvance(generation, plan.action === "remove" ? 1 : 5);
        return nextProvider;
      },
      cancelRuntime: async () => {
        cancelAutomation();
        const current = stateRef.current;
        const provider = activeProvider(current);
        const nextProvider: ServerProvider = {
          ...provider,
          connection: {
            ...provider.connection!,
            runtime: {
              ...provider.connection!.runtime!,
              operation: runtimeOperation(
                "cancelled",
                "Setup was cancelled safely.",
                provider.connection?.runtime?.operation?.action,
              ),
            },
          },
        };
        commit(
          replaceActiveProvider(current, nextProvider, "Cancelled simulated runtime operation."),
        );
        return nextProvider;
      },
      startConnection: async (method) => {
        consumeFailure("connection", "The simulated provider rejected the sign-in request.");
        const generation = ++automationGenerationRef.current;
        const current = stateRef.current;
        const provider = activeProvider(current);
        const nextProvider: ServerProvider = {
          ...provider,
          connection: {
            ...provider.connection!,
            operation: connectionOperation(
              method === "codex_device_code" ? "waiting_for_device_code" : "waiting_for_browser",
              method,
            ),
          },
        };
        commit({
          ...replaceActiveProvider(current, nextProvider, "Started simulated provider sign in."),
          snapshot: method === "codex_device_code" ? "device-code" : "browser-sign-in",
        });
        if (current.driver === "codex") scheduleAutomaticAdvance(generation, 2);
        return nextProvider;
      },
      cancelConnection: async () => {
        cancelAutomation();
        const current = stateRef.current;
        const provider = activeProvider(current);
        const nextProvider: ServerProvider = {
          ...provider,
          connection: {
            ...provider.connection!,
            operation: connectionOperation(
              "cancelled",
              provider.connection?.operation?.method ??
                (current.driver === "claudeAgent" ? "claude_subscription" : "codex_browser"),
            ),
          },
        };
        commit({
          ...replaceActiveProvider(current, nextProvider, "Cancelled simulated provider sign in."),
          snapshot: "installed-signed-out",
        });
        return nextProvider;
      },
      submitAuthorizationCode: async () => {
        cancelAutomation();
        const current = stateRef.current;
        const verifying = setActiveProviderSnapshot(
          current,
          "verifying",
          "Returned the simulated one-time code to Claude.",
        );
        commit(verifying);
        const generation = ++automationGenerationRef.current;
        scheduleAutomaticAdvance(generation, 1);
        return activeProvider(verifying);
      },
      disconnect: async () => {
        consumeFailure("disconnect", "The simulated provider could not sign out.");
        cancelAutomation();
        const current = stateRef.current;
        const next = setActiveProviderSnapshot(
          current,
          "installed-signed-out",
          "Signed out of the simulated account.",
        );
        commit(next);
        return activeProvider(next);
      },
      updateExternalRuntime: async () => {
        const generation = ++automationGenerationRef.current;
        const current = stateRef.current;
        const next = setActiveProviderSnapshot(
          current,
          "updating",
          `Started simulated external ${current.driver === "codex" ? "Codex" : "Claude"} update.`,
        );
        commit(next);
        scheduleAutomaticAdvance(generation, 5);
        return activeProvider(next);
      },
      openAuthorizationPage: async () => {
        const current = stateRef.current;
        commit({
          ...current,
          events: [
            "Simulated provider page opened; no real browser or account was contacted.",
            ...current.events,
          ].slice(0, 6),
        });
      },
    }),
    [],
  );

  return (
    <ProviderLifecycleControllerProvider controller={controller}>
      {children}
      <ProviderLabControls state={state} setState={commitManualState} />
    </ProviderLifecycleControllerProvider>
  );
}

function ProviderLabControls(props: {
  readonly state: ProviderLabState;
  readonly setState: (state: ProviderLabState) => ProviderLabState;
}) {
  const [open, setOpen] = useState(true);
  const changeSnapshot = (snapshot: ProviderLabSnapshot) =>
    props.setState(setActiveProviderSnapshot(props.state, snapshot, `Loaded ${snapshot}.`));
  const changeDriver = (driver: ProviderLabDriver) =>
    props.setState(
      switchActiveProvider(
        props.state,
        driver,
        `Changed simulated provider to ${driver === "codex" ? "Codex" : "Claude"}.`,
      ),
    );
  const changeTarget = (target: ProviderLabTarget) =>
    props.setState({
      ...makeProviderLabState("nothing-installed", target, props.state.driver),
      events: [`Changed simulated computer to ${target}.`, ...props.state.events].slice(0, 6),
    });
  const advance = () => {
    const next = nextProviderLabState(props.state);
    if (next) props.setState(next);
  };
  const currentRuntimeOperation = activeProvider(props.state).connection?.runtime?.operation;
  const runtimeInProgress =
    currentRuntimeOperation !== null &&
    currentRuntimeOperation !== undefined &&
    !["failed", "cancelled", "succeeded"].includes(currentRuntimeOperation.status);

  if (!open) {
    return (
      <Button
        className="fixed bottom-4 right-4 z-[100] shadow-lg"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <FlaskConicalIcon /> Provider lab
      </Button>
    );
  }

  return (
    <aside className="fixed bottom-4 right-4 z-[100] w-80 rounded-xl border bg-background/95 p-4 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Provider simulation</p>
          <p className="text-[11px] text-muted-foreground">Normal app · synthetic provider state</p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close provider simulation controls"
          onClick={() => setOpen(false)}
        >
          <XIcon />
        </Button>
      </div>
      <div className="mt-3 grid gap-3">
        <label className="grid gap-1 text-xs font-medium">
          Provider
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={props.state.driver}
            onChange={(event) => changeDriver(event.target.value as ProviderLabDriver)}
          >
            <option value="codex">Codex</option>
            <option value="claudeAgent">Claude</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Computer
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={props.state.target}
            onChange={(event) => changeTarget(event.target.value as ProviderLabTarget)}
          >
            <option value="darwin-arm64">macOS · Apple silicon</option>
            <option value="win32-x64">Windows · x64</option>
            <option value="linux-x64">Linux · x64</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Provider state
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={runtimeInProgress ? "runtime-in-progress" : props.state.snapshot}
            onChange={(event) => changeSnapshot(event.target.value as ProviderLabSnapshot)}
          >
            {runtimeInProgress ? (
              <option value="runtime-in-progress" disabled>
                Runtime in progress
              </option>
            ) : null}
            {snapshots
              .filter((snapshot) =>
                props.state.driver === "codex"
                  ? snapshot.value !== "authorization-code" &&
                    snapshot.value !== "authorization-code-expired"
                  : snapshot.value !== "device-code",
              )
              .map((snapshot) => (
                <option key={snapshot.value} value={snapshot.value}>
                  {snapshot.label}
                </option>
              ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Fail next action
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={props.state.failure}
            onChange={(event) =>
              props.setState({ ...props.state, failure: event.target.value as ProviderLabFailure })
            }
          >
            <option value="none">No injected failure</option>
            <option value="runtime">Install / runtime</option>
            <option value="connection">Sign in</option>
            <option value="disconnect">Sign out</option>
          </select>
        </label>
        <div className="flex gap-2">
          <Button size="sm" disabled={nextProviderLabState(props.state) === null} onClick={advance}>
            Advance
          </Button>
          <Button size="sm" variant="outline" onClick={() => changeSnapshot("nothing-installed")}>
            <RotateCcwIcon /> Reset
          </Button>
        </div>
        <p
          className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground"
          aria-live="polite"
        >
          {props.state.events[0]}
        </p>
      </div>
    </aside>
  );
}

export function ProviderFullAppLabHost({ children }: { readonly children: ReactNode }) {
  return PROVIDER_LAB_ENABLED ? <ControllerHost>{children}</ControllerHost> : children;
}

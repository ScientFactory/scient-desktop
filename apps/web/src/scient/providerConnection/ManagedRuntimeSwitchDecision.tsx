import type { ProviderRuntimePlan, ServerProvider } from "@t3tools/contracts";
import { DownloadIcon, LoaderIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  AssistedSetupActions,
  AssistedSetupFrame,
  AssistedSetupStatus,
} from "./AssistedProviderSetup";
import { providerLifecycleFailureMessage } from "./providerConnectionPresentation";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

/** The server no longer stands by the plan it was asked to start. */
export function isRuntimePlanStale(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "runtime_plan_stale"
  );
}

/**
 * Whether the plan is a switch the user has to decide on with both releases in
 * view: to a release older than the system runtime, or from a system runtime
 * whose release is unknown. The server starts it only once it was accepted.
 */
export function managedRuntimeSwitchNeedsDecision(plan: ProviderRuntimePlan): boolean {
  return plan.olderThanSystem === true || plan.systemVersion === null;
}

/** The question a switch from the system runtime to the managed release asks. */
export function managedRuntimeSwitchTitle(displayName: string, plan: ProviderRuntimePlan): string {
  return `Use Scient-managed ${displayName}${plan.version ? ` ${plan.version}` : ""}?`;
}

interface PendingDecision {
  readonly plan: ProviderRuntimePlan;
  /** Settles the action that asked: the started provider, or the unchanged one after Back. */
  readonly settle: (provider: ServerProvider) => void;
}

/**
 * Every inline setup starts its runtime actions through one controller. This
 * wraps it so that a switch to a managed release older than the system runtime
 * in use never starts from the click that asked for it: the plan, which names
 * both releases, is shown first with Back and Use Scient-managed. A plan the
 * server no longer stands by because that changed meanwhile is planned again
 * and shown the same way.
 */
export function useManagedRuntimeSwitchDecision(input: {
  readonly controller: ProviderLifecycleController;
  readonly provider: ServerProvider;
  readonly displayName: string;
}): { readonly controller: ProviderLifecycleController; readonly decision: ReactNode } {
  const { controller: lifecycle, displayName } = input;
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const controller = useMemo(
    (): ProviderLifecycleController => ({
      ...lifecycle,
      startRuntime: async (plan, options) => {
        let decided = plan;
        if (!managedRuntimeSwitchNeedsDecision(plan) || options?.acceptOlderThanSystem === true) {
          try {
            return await (options
              ? lifecycle.startRuntime(plan, options)
              : lifecycle.startRuntime(plan));
          } catch (cause) {
            if (!isRuntimePlanStale(cause)) throw cause;
            const replanned = await lifecycle.planRuntime(plan.action);
            if (!managedRuntimeSwitchNeedsDecision(replanned)) throw cause;
            decided = replanned;
          }
        }
        setError(null);
        return new Promise<ServerProvider>((settle) => setPending({ plan: decided, settle }));
      },
    }),
    [lifecycle],
  );

  if (!pending) return { controller, decision: null };

  const back = () => {
    pending.settle(input.provider);
    setPending(null);
  };
  const confirm = async () => {
    setStarting(true);
    setError(null);
    try {
      const provider = await (managedRuntimeSwitchNeedsDecision(pending.plan)
        ? lifecycle.startRuntime(pending.plan, { acceptOlderThanSystem: true })
        : lifecycle.startRuntime(pending.plan));
      pending.settle(provider);
      setPending(null);
    } catch (cause) {
      try {
        // The installed release changed since this plan: decide on the current one.
        if (!isRuntimePlanStale(cause)) throw cause;
        const plan = await lifecycle.planRuntime(pending.plan.action);
        setPending({ plan, settle: pending.settle });
      } catch (failure) {
        setError(
          providerLifecycleFailureMessage(
            failure,
            `Scient could not switch to managed ${displayName}.`,
          ),
        );
      }
    } finally {
      setStarting(false);
    }
  };

  return {
    controller,
    decision: (
      <AssistedSetupFrame>
        <AssistedSetupStatus
          body={
            <>
              {pending.plan.message}
              {error ? (
                <span className="mt-1 block text-destructive" role="alert">
                  {error}
                </span>
              ) : null}
            </>
          }
          icon={
            managedRuntimeSwitchNeedsDecision(pending.plan) ? (
              <TriangleAlertIcon className="size-5 text-warning" />
            ) : (
              <ShieldCheckIcon className="size-5 text-primary" />
            )
          }
          title={managedRuntimeSwitchTitle(displayName, pending.plan)}
        />
        <AssistedSetupActions>
          <Button disabled={starting} onClick={back} size="sm" type="button" variant="ghost-muted">
            Back
          </Button>
          <Button
            disabled={starting}
            onClick={() => void confirm()}
            size="sm"
            type="button"
            variant="ghost-primary"
          >
            {starting ? <LoaderIcon className="animate-spin" /> : <DownloadIcon />}
            Use Scient-managed
          </Button>
        </AssistedSetupActions>
      </AssistedSetupFrame>
    ),
  };
}

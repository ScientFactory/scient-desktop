import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { LoaderIcon, RefreshCwIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Button } from "../../components/ui/button";
import { providerRuntimeComputerLabel } from "./providerConnectionPresentation";
import type { ProviderUpdateIssue, ProviderUpdateOffer } from "./providerLifecycleActions";
import {
  ProviderRuntimeDiagnosticsDetails,
  resolveProviderRuntimeDiagnostics,
} from "./ProviderRuntimeDiagnostics";

export function AssistedSetupFrame(props: { readonly children: ReactNode }) {
  return (
    <div
      aria-live="polite"
      className="space-y-3 px-6 pb-4 in-[[data-model-picker-content=true]]:flex in-[[data-model-picker-content=true]]:min-h-full in-[[data-model-picker-content=true]]:w-full in-[[data-model-picker-content=true]]:flex-col in-[[data-model-picker-content=true]]:items-center in-[[data-model-picker-content=true]]:justify-center in-[[data-model-picker-content=true]]:gap-3 in-[[data-model-picker-content=true]]:space-y-0 in-[[data-model-picker-content=true]]:px-5 in-[[data-model-picker-content=true]]:py-4 in-[[data-model-picker-content=true]]:text-center in-[[data-slot=dialog-panel]]:p-0"
      data-provider-onboarding-view="assisted"
    >
      {props.children}
    </div>
  );
}

export function AssistedSetupStatus(props: {
  readonly body: ReactNode;
  readonly icon: ReactNode;
  readonly trailing?: ReactNode;
  readonly title: ReactNode;
  readonly role?: "alert" | "status" | undefined;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 py-1 in-[[data-model-picker-content=true]]:flex-col in-[[data-model-picker-content=true]]:items-center in-[[data-model-picker-content=true]]:gap-2 in-[[data-model-picker-content=true]]:py-0 in-[[data-model-picker-content=true]]:text-center",
        props.trailing ? "items-center" : "items-start",
      )}
      role={props.role}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center in-[[data-model-picker-content=true]]:mt-0 in-[[data-model-picker-content=true]]:size-8 in-[[data-model-picker-content=true]]:[&>svg]:size-7",
          props.trailing ? "mt-0" : "mt-0.5",
        )}
        data-assisted-setup-icon="true"
        aria-hidden
      >
        {props.icon}
      </span>
      <div className="min-w-0 flex-1 in-[[data-model-picker-content=true]]:max-w-64 in-[[data-model-picker-content=true]]:flex-none">
        <p className="text-sm font-medium text-foreground" data-assisted-setup-title="true">
          {props.title}
        </p>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{props.body}</div>
      </div>
      {props.trailing ? (
        <div className="shrink-0 self-center in-[[data-model-picker-content=true]]:hidden">
          {props.trailing}
        </div>
      ) : null}
    </div>
  );
}

export function AssistedSetupActions(props: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 pt-1 in-[[data-model-picker-content=true]]:w-full in-[[data-model-picker-content=true]]:justify-center in-[[data-model-picker-content=true]]:pt-0",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

/**
 * The icon for a provider's install, sign-in and disabled states. The composer's
 * provider picker shows the provider's own logo, so the user sees which provider
 * they picked; elsewhere a quieter shield marks a reviewed, Scient-assisted step.
 */
export function ProviderSetupIcon(props: {
  readonly displayName: string;
  readonly driver: ProviderDriverKind;
}) {
  return (
    <>
      <ShieldCheckIcon
        className="size-5 text-primary in-[[data-model-picker-content=true]]:hidden"
        data-provider-setup-mark="shield"
      />
      <span
        className="hidden in-[[data-model-picker-content=true]]:inline-flex"
        data-provider-setup-mark="logo"
      >
        <ProviderInstanceIcon
          className="size-8"
          displayName={props.displayName}
          driverKind={props.driver}
          iconClassName="size-8"
        />
      </span>
    </>
  );
}

/**
 * The runtime diagnostics disclosure of a failed or repair state. Every
 * provider shows it only there; healthy, first-run and in-progress states
 * leave runtime details to Settings.
 */
export function AssistedSetupDiagnostics(props: {
  readonly displayName: string;
  readonly provider: ServerProvider;
  /** The management surface presents runtime diagnostics in its own runtime section. */
  readonly presentedExternally?: boolean | undefined;
  /** Offers switching a failing system installation to the Scient-managed runtime. */
  readonly onUseManaged?: (() => void) | undefined;
  readonly managedActionBusy?: boolean | undefined;
}) {
  if (props.presentedExternally || !resolveProviderRuntimeDiagnostics(props.provider)) return null;
  return (
    <div className="flex justify-end">
      <ProviderRuntimeDiagnosticsDetails
        displayName={props.displayName}
        managedActionBusy={props.managedActionBusy}
        onUseManaged={props.onUseManaged}
        provider={props.provider}
      />
    </div>
  );
}

/**
 * The status of an offered update, told by how Scient applies it. A managed
 * update installs a reviewed runtime beside the current one, which stays in
 * use until the new one is verified; an external update runs the
 * installation's own updater in place and checks the version afterwards.
 * `working` is the external updater's progress; managed updates report
 * progress as runtime operations. `issue` is why the last attempt did not
 * take effect.
 */
export function AssistedSetupUpdateStatus(props: {
  readonly name: string;
  readonly provider: ServerProvider;
  readonly update: ProviderUpdateOffer;
  readonly working?: "queued" | "running" | null | undefined;
  readonly issue?: ProviderUpdateIssue | null | undefined;
  readonly trailing?: ReactNode;
}) {
  const { name, update } = props;
  const computer = providerRuntimeComputerLabel(props.provider);
  const command =
    update.path === "external" && update.command ? (
      <code className="text-foreground wrap-anywhere">{update.command}</code>
    ) : null;
  if (props.working) {
    return (
      <AssistedSetupStatus
        body={
          props.working === "queued" ? (
            "Waiting for another provider update to finish."
          ) : update.path === "managed" ? (
            "Downloading and verifying the reviewed update…"
          ) : command ? (
            <>
              Running {command} on {computer}. Scient checks the installed version when it finishes.
            </>
          ) : (
            `Running ${name}’s own updater on ${computer}. Scient checks the installed version when it finishes.`
          )
        }
        icon={<LoaderIcon className="size-5 animate-spin text-primary" />}
        role="status"
        title={`Updating ${name}`}
        trailing={props.trailing}
      />
    );
  }
  if (props.issue) {
    const unchanged = props.issue.kind === "unchanged";
    return (
      <AssistedSetupStatus
        body={props.issue.message}
        icon={
          <TriangleAlertIcon
            className={cn("size-5", unchanged ? "text-warning" : "text-destructive")}
          />
        }
        role="alert"
        title={unchanged ? `${name} update didn’t take effect` : `${name} couldn’t be updated`}
        trailing={props.trailing}
      />
    );
  }
  const offered = update.version
    ? `${name} ${update.version} is available.`
    : `A newer ${name} is available.`;
  return (
    <AssistedSetupStatus
      body={
        update.path === "managed" ? (
          "Install the reviewed update when you’re ready. Your current version remains available until the update is verified."
        ) : command ? (
          <>
            {offered} Scient will run {command} to update the {name} installed on {computer}.
          </>
        ) : (
          `${offered} Scient will update the ${name} installed on ${computer} with its own updater.`
        )
      }
      icon={<RefreshCwIcon className="size-5 text-primary" />}
      title={`${name} update available`}
      trailing={props.trailing}
    />
  );
}

/** Starts the offered update, or retries it after `retry`: an update that did not take effect. */
export function AssistedSetupUpdateButton(props: {
  readonly name: string;
  readonly retry: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      aria-label={props.retry ? `Try again to update ${props.name}` : `Update ${props.name}`}
      onClick={props.onClick}
      size="sm"
      type="button"
      variant="ghost-primary"
    >
      <RefreshCwIcon aria-hidden /> {props.retry ? "Try again" : "Update"}
    </Button>
  );
}

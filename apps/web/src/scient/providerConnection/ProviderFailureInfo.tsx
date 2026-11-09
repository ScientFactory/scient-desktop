import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { useProviderSettingsLifecyclePresentation } from "./providerSettingsLifecyclePresentation";

/** A small info button beside a failed status; hovering or clicking it shows why. */
export function ProviderFailureInfo(props: { readonly title: string; readonly detail: string }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <Button
            type="button"
            size="icon-tiny"
            variant="ghost-muted"
            aria-label={`${props.title}: show why`}
            className="flex-none self-center"
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="md" padding="comfortable">
        <div className="grid min-w-0 gap-0.5">
          <p className="text-sm font-semibold leading-tight text-foreground">{props.title}</p>
          <p className="text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">
            {props.detail}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** "● Setup failed ⓘ" for a provider row that has no status line of its own. */
export function ProviderSetupFailureLine(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly displayName: string;
}) {
  const presentation = useProviderSettingsLifecyclePresentation(
    props.environmentId,
    props.provider,
    props.displayName,
  );
  if (presentation.kind !== "failed" || !presentation.detail) return null;
  const title = presentation.statusLabel ?? "Setup failed";
  return (
    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />
      {title}
      <ProviderFailureInfo title={title} detail={presentation.detail} />
    </span>
  );
}

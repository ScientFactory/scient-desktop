import type { ProviderRuntimeDiagnostics, ServerProvider } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ScientTooltip } from "../presentation/ScientTooltip";

function runtimeSourceTitle(source: ServerProvider["connection"]): string {
  const value = source?.runtime?.source;
  if (value === "scient_managed") return "Scient-managed";
  if (value === "system") return "System";
  if (value === "custom") return "Custom";
  if (value === "missing") return "Missing";
  return "Unknown";
}

export function resolveProviderRuntimeDiagnostics(
  provider: ServerProvider,
): ProviderRuntimeDiagnostics | null {
  const diagnostics = provider.connection?.runtime?.diagnostics;
  // Older servers may not provide runtime coordinates. Inventing an
  // executable or account-home path would make recovery instructions unsafe.
  if (!diagnostics) return null;
  return {
    ...diagnostics,
    version: diagnostics.version ?? provider.version,
  };
}

export function ProviderRuntimeDiagnosticsDetails(props: {
  readonly displayName: string;
  readonly provider: ServerProvider;
  readonly onUseManaged?: (() => void) | undefined;
  readonly managedActionBusy?: boolean | undefined;
}) {
  const diagnostics = resolveProviderRuntimeDiagnostics(props.provider);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "server executable path" });
  if (!diagnostics) return null;

  return (
    <details className="w-full text-left">
      <summary className="w-fit cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        Runtime diagnostics
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-background/40 p-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          These values describe the server running {props.displayName}. Remote clients may show
          paths from a different computer.
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] leading-relaxed">
          <dt className="text-muted-foreground">Runtime</dt>
          <dd className="min-w-0 truncate text-right text-foreground">
            {runtimeSourceTitle(props.provider.connection)}
          </dd>
          <dt className="text-muted-foreground">Version</dt>
          <dd className="min-w-0 truncate text-right text-foreground">
            {diagnostics.version ?? "Unknown"}
          </dd>
          <dt className="text-muted-foreground">Server backend</dt>
          <dd className="min-w-0 truncate text-right text-foreground">{diagnostics.backend}</dd>
          <dt className="text-muted-foreground">Server account home</dt>
          <dd className="min-w-0 truncate text-right text-foreground">
            <ScientTooltip content={diagnostics.homePath ?? "Default"}>
              <span>{diagnostics.homePath ?? "Default"}</span>
            </ScientTooltip>
          </dd>
          <dt className="self-center text-muted-foreground">Server executable</dt>
          <dd className="flex min-w-0 items-center justify-end gap-1 text-right text-foreground">
            <ScientTooltip content={diagnostics.executable}>
              <code className="min-w-0 truncate font-mono">{diagnostics.executable}</code>
            </ScientTooltip>
            <Button
              aria-label={`Copy ${props.displayName} executable path`}
              className="size-5 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              onClick={() => copyToClipboard(diagnostics.executable, undefined)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              {isCopied ? (
                <CheckIcon aria-hidden className="size-3" />
              ) : (
                <CopyIcon aria-hidden className="size-3" />
              )}
            </Button>
          </dd>
        </dl>
        {props.onUseManaged ? (
          <div className="space-y-1.5">
            <Button
              disabled={props.managedActionBusy}
              onClick={props.onUseManaged}
              size="xs"
              type="button"
              variant="outline"
            >
              Use Scient-managed {props.displayName}
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Applies to {props.displayName} accounts in this environment that use the default
              runtime. Custom executable paths remain unchanged.
            </p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

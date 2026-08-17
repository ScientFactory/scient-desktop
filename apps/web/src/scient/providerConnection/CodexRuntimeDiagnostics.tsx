import type { ProviderRuntimeDiagnostics, ServerProvider } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import { ScientTooltip } from "../presentation/ScientTooltip";

function runtimeSourceTitle(source: ServerProvider["connection"]): string {
  const value = source?.runtime?.source;
  if (value === "scient_managed") return "Scient-managed";
  if (value === "system") return "System";
  if (value === "custom") return "Custom";
  if (value === "missing") return "Missing";
  return "Unknown";
}

export function resolveCodexRuntimeDiagnostics(
  provider: ServerProvider,
): ProviderRuntimeDiagnostics | null {
  const diagnostics = provider.connection?.runtime?.diagnostics;
  // Servers that predate runtime diagnostics get no panel: invented
  // executable/backend values would contradict the runtime label and point
  // the manual-fallback command at the wrong binary.
  if (!diagnostics) return null;
  return {
    ...diagnostics,
    version: diagnostics.version ?? provider.version,
  };
}

export function CodexRuntimeDiagnosticsDetails(props: {
  readonly provider: ServerProvider;
  readonly onUseManaged?: (() => void) | undefined;
  readonly managedActionBusy?: boolean | undefined;
}) {
  const diagnostics = resolveCodexRuntimeDiagnostics(props.provider);
  if (!diagnostics) return null;

  return (
    <details className="w-full max-w-72 text-left">
      <summary className="w-fit cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        Runtime diagnostics
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-background/40 p-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          These values describe the server running Codex. Remote clients may show paths from a
          different computer.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] leading-relaxed">
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
          <dt className="text-muted-foreground">Server Codex home</dt>
          <ScientTooltip content={diagnostics.homePath ?? "Default"}>
            <dd className="min-w-0 truncate text-right text-foreground">
              {diagnostics.homePath ?? "Default"}
            </dd>
          </ScientTooltip>
          <dt className="text-muted-foreground">Server executable</dt>
          <ScientTooltip content={diagnostics.executable}>
            <dd className="min-w-0 truncate text-right font-mono text-foreground">
              {diagnostics.executable}
            </dd>
          </ScientTooltip>
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
              Use Scient-managed Codex
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Applies to Codex accounts in this environment that use the default runtime. Custom
              executable paths remain unchanged.
            </p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

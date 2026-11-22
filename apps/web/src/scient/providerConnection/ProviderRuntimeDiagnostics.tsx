import { msg, T, useGT, useMessages, Var } from "gt-react";
import type { ProviderRuntimeDiagnostics, ServerProvider } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { namedClipboardTarget, useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { m, type MessageResolver } from "~/i18n/messages";

function runtimeSourceTitle(
  source: ServerProvider["connection"],
  resolve: MessageResolver = m,
): string {
  const value = source?.runtime?.source;
  if (value === "scient_managed") return resolve(msg("Scient-managed"));
  if (value === "registry") return resolve(msg("Scient-owned ACP Registry"));
  if (value === "system") return resolve(msg("System", { $context: "runtime source" }));
  if (value === "custom") return resolve(msg("Custom", { $context: "runtime source" }));
  if (value === "missing") return resolve(msg("Missing", { $context: "runtime source" }));
  return resolve(msg("Unknown", { $context: "runtime source" }));
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
  const installation = props.provider.connection?.runtime?.installation;
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("server executable path"),
  });
  const gt = useGT();
  const messages = useMessages();
  if (!diagnostics) return null;

  return (
    <details className="w-full text-left">
      <summary className="w-fit cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        <T>Runtime diagnostics</T>
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-background/40 p-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          <T>
            These values describe the server running <Var>{props.displayName}</Var>. Remote clients
            may show paths from a different computer.
          </T>
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] leading-relaxed">
          <dt className="text-muted-foreground">
            <T>Runtime</T>
          </dt>
          <dd className="min-w-0 truncate text-right text-foreground">
            {runtimeSourceTitle(props.provider.connection, messages)}
          </dd>
          <dt className="text-muted-foreground">
            <T>Version</T>
          </dt>
          <dd className="min-w-0 truncate text-right text-foreground">
            {diagnostics.version ?? gt("Unknown", { $context: "version is not known" })}
          </dd>
          <dt className="text-muted-foreground">
            <T>Server backend</T>
          </dt>
          <dd className="min-w-0 truncate text-right text-foreground">{diagnostics.backend}</dd>
          {installation ? (
            <>
              <dt className="text-muted-foreground">
                <T>Installation</T>
              </dt>
              <dd className="min-w-0 truncate text-right text-foreground">
                {installation.agentId} · {installation.distribution}
              </dd>
              <dt className="text-muted-foreground">
                <T>Installer</T>
              </dt>
              <dd className="min-w-0 truncate text-right text-foreground">
                <ScientTooltip content={installation.installer ?? gt("Not recorded")}>
                  <code>{installation.installer ?? gt("Not recorded")}</code>
                </ScientTooltip>
              </dd>
              <dt className="text-muted-foreground">
                <T>Owned directory</T>
              </dt>
              <dd className="min-w-0 truncate text-right text-foreground">
                <ScientTooltip content={installation.installRoot}>
                  <code>{installation.installRoot}</code>
                </ScientTooltip>
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">
            <T>Server account home</T>
          </dt>
          <dd className="min-w-0 truncate text-right text-foreground">
            <ScientTooltip
              content={diagnostics.homePath ?? gt("Default", { $context: "default home folder" })}
            >
              <span>
                {diagnostics.homePath ?? gt("Default", { $context: "default home folder" })}
              </span>
            </ScientTooltip>
          </dd>
          <dt className="self-center text-muted-foreground">
            <T>Server executable</T>
          </dt>
          <dd className="flex min-w-0 items-center justify-end gap-1 text-right text-foreground">
            <ScientTooltip content={diagnostics.executable}>
              <code className="min-w-0 truncate font-mono">{diagnostics.executable}</code>
            </ScientTooltip>
            <Button
              aria-label={gt("Copy {provider} executable path", { provider: props.displayName })}
              className="shrink-0"
              onClick={() => copyToClipboard(diagnostics.executable, undefined)}
              size="icon-micro"
              type="button"
              variant="ghost-muted"
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
              variant="ghost-primary"
            >
              <T>
                Use Scient-managed <Var>{props.displayName}</Var>
              </T>
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              <T>
                Applies to <Var>{props.displayName}</Var> accounts in this environment that use the
                default runtime. Custom executable paths remain unchanged.
              </T>
            </p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

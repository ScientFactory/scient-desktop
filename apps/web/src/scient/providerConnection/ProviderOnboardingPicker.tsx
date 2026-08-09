import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { BlocksIcon, ChevronRightIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ComposerControl, ComposerControlChevron } from "../../components/chat/ComposerControl";
import { PROVIDER_CLIENT_DEFINITIONS } from "../../components/settings/providerDriverMeta";
import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { cn } from "~/lib/utils";
import { CodexInlineSetup } from "./CodexInlineSetup";
import { ProviderConnectionDialog } from "./ProviderConnectionDialog";
import {
  canManageProviderLifecycle,
  providerConnectionPresentation,
} from "./providerConnectionPresentation";
import { useProviderLifecycleController } from "./useProviderLifecycleController";

function statusLabel(entry: ProviderInstanceEntry | undefined): string {
  if (!entry) return "Not configured";
  switch (providerConnectionPresentation(entry.snapshot).kind) {
    case "not-installed":
      return "Not installed";
    case "not-connected":
      return "Sign in required";
    case "setting-up":
      return "Setting up";
    case "connecting":
      return "Connecting";
    case "connected":
    case "not-required":
      return "Connected";
    case "unsupported":
      return "Manual setup";
    case "unavailable":
      return "Unavailable";
  }
}

export function ProviderOnboardingPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly compact?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<ProviderDriverKind | null>(null);
  const [query, setQuery] = useState("");
  const [dialogEntry, setDialogEntry] = useState<ProviderInstanceEntry | null>(null);
  const open = props.open ?? uncontrolledOpen;
  const setOpen = (nextOpen: boolean) => {
    props.onOpenChange?.(nextOpen);
    if (props.open === undefined) setUncontrolledOpen(nextOpen);
  };

  useEffect(() => {
    if (open) return;
    setSelectedDriver(null);
    setQuery("");
  }, [open]);

  const entriesByDriver = useMemo(() => {
    const entries = new Map<ProviderDriverKind, ProviderInstanceEntry>();
    for (const entry of props.instanceEntries) {
      if (!entries.has(entry.driverKind) || entry.isDefault) entries.set(entry.driverKind, entry);
    }
    return entries;
  }, [props.instanceEntries]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleDefinitions = PROVIDER_CLIENT_DEFINITIONS.filter((definition) =>
    definition.label.toLocaleLowerCase().includes(normalizedQuery),
  );
  const previewDefinitions = PROVIDER_CLIENT_DEFINITIONS.slice(0, 3);
  const selectedDefinition = PROVIDER_CLIENT_DEFINITIONS.find(
    (definition) => definition.value === selectedDriver,
  );
  const selectedEntry = selectedDriver ? entriesByDriver.get(selectedDriver) : undefined;
  const showHome = selectedDefinition === undefined || normalizedQuery.length > 0;

  const openSettings = () => {
    setOpen(false);
    void navigate({ to: "/settings/providers" });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <ComposerControl
              aria-label="Choose and connect your AI"
              className={cn(
                "-ms-px min-w-0 justify-between whitespace-nowrap ps-0",
                props.compact ? "max-w-48 shrink-0" : "max-w-60 shrink sm:max-w-64",
              )}
              data-provider-onboarding-trigger="true"
            />
          }
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <BlocksIcon aria-hidden className="size-4 shrink-0" />
            <span className="truncate">Choose your AI</span>
            {!open ? (
              <span aria-hidden className="ms-0.5 flex shrink-0 items-center -space-x-0.5">
                {previewDefinitions.map((definition) => {
                  const Icon = definition.icon;
                  return (
                    <span
                      key={definition.value}
                      className="flex size-4 items-center justify-center rounded-full bg-background/80"
                    >
                      <Icon className="size-3" />
                    </span>
                  );
                })}
              </span>
            ) : null}
          </span>
          <ComposerControlChevron />
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
          viewportClassName="rounded-lg !overflow-hidden p-0"
        >
          <div
            className="dropdown-glass model-picker-surface relative flex h-screen max-h-86.5 w-screen max-w-90 overflow-hidden rounded-lg text-popover-foreground [clip-path:inset(0_round_var(--radius-lg))]"
            data-model-picker-content="true"
            data-provider-onboarding-picker="true"
          >
            <aside
              aria-label="AI providers"
              className="w-11 shrink-0 overflow-y-auto bg-muted/30 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <RailButton
                active={showHome}
                icon={BlocksIcon}
                label="Choose a provider"
                onClick={() => {
                  setSelectedDriver(null);
                  setQuery("");
                }}
              />
              <div aria-hidden className="my-1 border-b border-border/70" />
              <div className="flex flex-col gap-1">
                {PROVIDER_CLIENT_DEFINITIONS.map((definition) => (
                  <RailButton
                    key={definition.value}
                    active={!showHome && definition.value === selectedDriver}
                    icon={definition.icon}
                    label={`${definition.label}, ${statusLabel(entriesByDriver.get(definition.value))}`}
                    onClick={() => {
                      setSelectedDriver(definition.value);
                      setQuery("");
                    }}
                  />
                ))}
              </div>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col border-l border-border/70 bg-muted/40">
              <label className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
                <SearchIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
                <span className="sr-only">Search providers or models</span>
                <input
                  className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search providers or models…"
                  type="search"
                  value={query}
                />
              </label>

              {showHome ? (
                normalizedQuery.length === 0 ? (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 pb-5 text-center">
                    <BlocksIcon aria-hidden className="mb-3 size-7 text-icon-muted" />
                    <h2 className="font-semibold text-lg">Choose your provider</h2>
                    <p className="mt-1.5 max-w-52 text-balance text-muted-foreground text-sm leading-relaxed">
                      Connect your existing subscription or account, then choose a model.
                    </p>
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    <p className="mb-2 px-2 font-medium text-muted-foreground text-xs">Providers</p>
                    {visibleDefinitions.map((definition) => {
                      const Icon = definition.icon;
                      return (
                        <button
                          key={definition.value}
                          className="group flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => {
                            setSelectedDriver(definition.value);
                            setQuery("");
                          }}
                          type="button"
                        >
                          <Icon aria-hidden className="size-5 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {definition.label}
                            </span>
                            <span className="block truncate text-muted-foreground text-xs">
                              {statusLabel(entriesByDriver.get(definition.value))}
                            </span>
                          </span>
                          <ChevronRightIcon
                            aria-hidden
                            className="size-4 shrink-0 text-icon-muted"
                          />
                        </button>
                      );
                    })}
                    {visibleDefinitions.length === 0 ? (
                      <p className="px-2 py-8 text-center text-muted-foreground text-sm">
                        No providers match “{query}”.
                      </p>
                    ) : null}
                  </div>
                )
              ) : selectedDefinition && selectedEntry ? (
                selectedDefinition.value === "codex" ? (
                  <CodexSetupWithController
                    displayName={selectedEntry.displayName}
                    environmentId={props.environmentId}
                    provider={selectedEntry.snapshot}
                  />
                ) : (
                  <ProviderSetupDetail
                    displayName={selectedDefinition.label}
                    status={statusLabel(selectedEntry)}
                    onManage={() => {
                      if (canManageProviderLifecycle(selectedEntry.snapshot)) {
                        setOpen(false);
                        setDialogEntry(selectedEntry);
                      } else {
                        openSettings();
                      }
                    }}
                  />
                )
              ) : (
                <ProviderSetupDetail
                  displayName={selectedDefinition?.label ?? "Provider"}
                  status="Not configured"
                  onManage={openSettings}
                />
              )}
            </section>
          </div>
        </PopoverPopup>
      </Popover>

      {dialogEntry ? (
        <ProviderConnectionDialog
          displayName={dialogEntry.displayName}
          environmentId={props.environmentId}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setDialogEntry(null);
          }}
          open
          provider={dialogEntry.snapshot}
        />
      ) : null}
    </>
  );
}

function CodexSetupWithController(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ProviderInstanceEntry["snapshot"];
  readonly displayName: string;
}) {
  const controller = useProviderLifecycleController({
    environmentId: props.environmentId,
    provider: props.provider,
  });
  return <CodexInlineSetup {...props} controller={controller} />;
}

function RailButton(props: {
  readonly active: boolean;
  readonly icon: (typeof PROVIDER_CLIENT_DEFINITIONS)[number]["icon"];
  readonly label: string;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      aria-current={props.active ? "page" : undefined}
      aria-label={props.label}
      className={cn(
        "relative flex aspect-square w-full items-center justify-center rounded-md transition-colors hover:bg-foreground/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.active && "bg-background/75",
      )}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      <Icon aria-hidden className="size-5" />
      {props.active ? (
        <span className="absolute -right-1 top-1/2 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary" />
      ) : null}
    </button>
  );
}

function ProviderSetupDetail(props: {
  readonly displayName: string;
  readonly status: string;
  readonly onManage: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-4 text-center">
      <SettingsIcon aria-hidden className="mb-3 size-8 text-icon-muted" />
      <h2 className="font-semibold text-lg">{props.displayName}</h2>
      <p className="mt-1.5 max-w-58 text-balance text-muted-foreground text-sm leading-relaxed">
        {props.status}
      </p>
      <Button className="mt-4" onClick={props.onManage} size="sm" type="button">
        Open provider settings
      </Button>
    </div>
  );
}

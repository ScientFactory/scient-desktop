import { useAuth, useClerk, useUser } from "@clerk/react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
  orchestrationProtocolCompatibilityError,
} from "@t3tools/client-runtime/connection";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { useT3ConnectAuthPrompt } from "~/components/clerk/useT3ConnectAuthPrompt";
import { ConnectionStatusDot } from "~/components/ConnectionStatusDot";
import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { ScientSymbol } from "~/components/ScientSymbol";
import { Button } from "~/components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { environmentCatalog } from "~/connection/catalog";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { useEnvironments, useRelayEnvironmentDiscovery } from "~/state/environments";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  HOSTED_COMPUTER_STATUS_LABEL,
  HOSTED_LANDING_PREVIEWS,
  type HostedComputer,
  type HostedComputerStatus,
  type HostedLandingModel,
  statusFromAvailability,
  statusFromConnectionPhase,
  summarizeComputers,
} from "./hostedLandingModel";
import "./hostedLanding.css";
import { ScientFactoryBrand } from "./ScientFactoryBrand";

const DOWNLOAD_URL = "https://scientfactory.com";
const REFRESH_INTERVAL_MS = 5_000;

export interface HostedLandingActions {
  readonly signIn: () => void;
  readonly signOut: () => void;
  readonly tryAgain: () => void;
}

const NO_ACTIONS: HostedLandingActions = {
  signIn: () => undefined,
  signOut: () => undefined,
  tryAgain: () => undefined,
};

/**
 * The hosted app's home until one of the person's computers is open: sign in, turn on
 * Scient Connect there, and watch this page open it by itself.
 */
export function HostedLanding() {
  if (import.meta.env.DEV) {
    const preview = new URLSearchParams(window.location.search).get("hostedPreview");
    if (preview !== null && HOSTED_LANDING_PREVIEWS[preview]) {
      return <HostedLandingPreview initial={preview} />;
    }
  }
  if (isLocalEnvironmentDisabled()) {
    return <HostedLandingView model={{ kind: "local-off" }} actions={NO_ACTIONS} />;
  }
  if (!hasCloudPublicConfig()) {
    return <HostedLandingView model={{ kind: "local-off" }} actions={NO_ACTIONS} />;
  }
  return <AccountHostedLanding />;
}

/** Development-only walk through every screen; the first five play as the real flow does. */
const PREVIEW_STEPS: ReadonlyArray<{ readonly name: string; readonly label: string }> = [
  { name: "loading", label: "Loading" },
  { name: "signed-out", label: "Signed out" },
  { name: "waiting", label: "No computer yet" },
  { name: "checking", label: "Checking" },
  { name: "opening", label: "Opening" },
  { name: "off", label: "Off or asleep" },
  { name: "unreachable", label: "Can't reach" },
  { name: "several", label: "Several computers" },
  { name: "needs-update", label: "Needs an update" },
  { name: "cant-list", label: "Can't load computers" },
  { name: "local-off", label: "This computer is off" },
];
const PREVIEW_PLAY_MS: Record<string, number> = {
  loading: 1800,
  "signed-out": 2800,
  waiting: 4000,
  checking: 2800,
};
const PREVIEW_PLAY_END = "opening";

function HostedLandingPreview({ initial }: { readonly initial: string }) {
  const [name, setName] = useState(initial);
  const [playing, setPlaying] = useState(false);
  const index = Math.max(
    0,
    PREVIEW_STEPS.findIndex((step) => step.name === name),
  );
  const show = (next: string) => {
    setName(next);
    const url = new URL(window.location.href);
    url.searchParams.set("hostedPreview", next);
    window.history.replaceState(window.history.state, "", url);
  };
  const advance = useEffectEvent(() => {
    const next = PREVIEW_STEPS[index + 1]!.name;
    show(next);
    if (next === PREVIEW_PLAY_END) setPlaying(false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- development preview: a timer walks the fixture screens like the real flow
  useEffect(() => {
    const delay = PREVIEW_PLAY_MS[name];
    if (!playing || delay === undefined) return;
    const timer = setTimeout(() => advance(), delay);
    return () => clearTimeout(timer);
  }, [playing, name]);

  const actions: HostedLandingActions = {
    signIn: () => show("waiting"),
    signOut: () => show("signed-out"),
    tryAgain: () => show("checking"),
  };
  return (
    <>
      <HostedLandingView model={HOSTED_LANDING_PREVIEWS[name]!} actions={actions} />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-2">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-sm">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={playing ? "Pause" : "Play the flow"}
            onClick={() => {
              if (playing) return setPlaying(false);
              if (PREVIEW_PLAY_MS[name] === undefined) show("loading");
              setPlaying(true);
            }}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous screen"
            disabled={index === 0}
            onClick={() => show(PREVIEW_STEPS[index - 1]!.name)}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="w-40 truncate text-center tabular-nums">
            {String(index).padStart(2, "0")} {PREVIEW_STEPS[index]!.label}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next screen"
            disabled={index === PREVIEW_STEPS.length - 1}
            onClick={() => show(PREVIEW_STEPS[index + 1]!.name)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </>
  );
}

function AccountHostedLanding() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const actions = { ...NO_ACTIONS, signIn: openAuthPrompt };
  if (!isLoaded) return <HostedLandingView model={{ kind: "loading" }} actions={actions} />;
  if (!isSignedIn) return <HostedLandingView model={{ kind: "signed-out" }} actions={actions} />;
  return <SignedInHostedLanding />;
}

function SignedInHostedLanding() {
  const clerk = useClerk();
  const { user } = useUser();
  const account = user?.primaryEmailAddress?.emailAddress ?? null;
  const discovery = useRelayEnvironmentDiscovery();
  const { environments } = useEnvironments();
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const register = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  // Computers this page has asked to open, and the ones that failed, by environment id.
  const [attempted] = useState(() => new Set<string>());
  const [opening, setOpening] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  // Discovery empties its list while it refreshes; keep showing the last computers meanwhile.
  const [lastSeen, setLastSeen] = useState<ReadonlyArray<HostedComputer>>([]);

  const added = new Map(
    environments
      .filter((environment) => environment.relayManaged)
      .map((environment) => [environment.environmentId as string, environment]),
  );

  const computers: HostedComputer[] = [];
  for (const environment of added.values()) {
    computers.push({
      id: environment.environmentId,
      label: environment.label,
      machineKind: resolveEnvironmentMachineKind(environment.serverConfig),
      status: statusFromConnectionPhase(environment.connection.phase),
    });
  }
  for (const { environment, availability, status } of discovery.environments.values()) {
    if (added.has(environment.environmentId)) continue;
    const descriptor = Option.getOrNull(status ?? Option.none())?.descriptor;
    const compatible =
      descriptor === undefined || orchestrationProtocolCompatibilityError(descriptor) === null;
    computers.push({
      id: environment.environmentId,
      label: environment.label,
      machineKind: resolveEnvironmentMachineKind(
        descriptor === undefined ? null : { environment: descriptor },
      ),
      status: failed.has(environment.environmentId)
        ? "unreachable"
        : opening.has(environment.environmentId)
          ? "opening"
          : statusFromAvailability(availability, compatible),
    });
  }
  const shown = computers.length === 0 && discovery.refreshing ? lastSeen : computers;
  if (computers.length > 0 && !sameComputers(computers, lastSeen)) setLastSeen(computers);

  // Open every computer that is on and runs a compatible Scient, once each.
  const openNewComputers = useEffectEvent((discovered: typeof discovery.environments) => {
    for (const { environment, availability, status } of discovered.values()) {
      const id = environment.environmentId;
      if (availability !== "online" || added.has(id) || attempted.has(id)) continue;
      const descriptor = Option.getOrNull(status ?? Option.none())?.descriptor;
      if (descriptor !== undefined && orchestrationProtocolCompatibilityError(descriptor) !== null)
        continue;
      attempted.add(id);
      setOpening((current) => new Set([...current, id]));
      void register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        }),
      ).then((result) => {
        setOpening((current) => withoutId(current, id));
        if (result._tag !== "Success") setFailed((current) => new Set([...current, id]));
      });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discovery results arrive from an external store; each new online computer starts its connection
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- discovery results arrive from an external store and starting a connection marks it opening
    openNewComputers(discovery.environments);
  }, [discovery.environments]);

  // Keep looking while nothing can be opened, so a computer that wakes up opens by itself.
  const keepLooking = !shown.some(
    (computer) => computer.status === "opening" || computer.status === "checking",
  );
  const refreshWhenIdle = useEffectEvent(async () => {
    if (discovery.refreshing || discovery.offline) return;
    await refreshDiscovery();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls relay discovery on a timer and on focus while no computer is opening
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState === "visible";
    const tick = async () => {
      if (disposed || !visible()) return;
      await settlePromise(() => refreshWhenIdle());
      if (!disposed && keepLooking) timer = setTimeout(() => void tick(), REFRESH_INTERVAL_MS);
    };
    void tick();
    const onFocus = () => {
      clearTimeout(timer);
      void tick();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [keepLooking]);

  const tryAgain = () => {
    for (const id of failed) attempted.delete(id);
    setFailed(new Set());
    for (const environment of added.values()) {
      if (environment.connection.phase === "error" || environment.connection.phase === "offline")
        void retryNow(environment.environmentId as EnvironmentId);
    }
    void refreshDiscovery();
  };

  const listProblem =
    shown.length === 0 &&
    !discovery.refreshing &&
    (discovery.offline || discovery.error._tag === "Some");
  const model: HostedLandingModel = listProblem
    ? { kind: "cant-list", account, offline: discovery.offline }
    : shown.length === 0
      ? { kind: "waiting", account }
      : { kind: "computers", account, computers: shown };

  return (
    <HostedLandingView
      model={model}
      actions={{ ...NO_ACTIONS, signOut: () => void clerk.signOut(), tryAgain }}
    />
  );
}

function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

function sameComputers(a: ReadonlyArray<HostedComputer>, b: ReadonlyArray<HostedComputer>) {
  return (
    a.length === b.length &&
    a.every(
      (computer, index) =>
        computer.id === b[index]?.id &&
        computer.status === b[index]?.status &&
        computer.label === b[index]?.label,
    )
  );
}

/** Renders one model; the development preview feeds it fixtures. */
function HostedLandingView({
  model,
  actions,
}: {
  readonly model: HostedLandingModel;
  readonly actions: HostedLandingActions;
}) {
  switch (model.kind) {
    case "loading":
      return <HostedSplash />;
    case "signed-out":
      return (
        <HostedFrame
          title="Your Scient, from any browser"
          description="Open the projects and agents on your computer from here. Your files stay on your computer."
        >
          <div className="flex justify-center">
            <button type="button" className="scient-hosted-pill min-w-28" onClick={actions.signIn}>
              Sign in
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            New to Scient? <ExternalLink href={DOWNLOAD_URL}>Get it for your computer</ExternalLink>
          </p>
        </HostedFrame>
      );
    case "waiting":
      return (
        <HostedFrame
          title="Turn on Scient Connect"
          description="On the computer you work on:"
          footer={<AccountFooter account={model.account} onSignOut={actions.signOut} />}
        >
          <ol className="space-y-3 text-sm text-foreground">
            <Step number={1}>Open Scient.</Step>
            <Step number={2}>
              Go to <span className="font-medium">Settings → Sharing & access</span>.
            </Step>
            <Step number={3}>
              Sign in
              {model.account ? (
                <>
                  {" "}
                  as <span className="font-medium">{model.account}</span>
                </>
              ) : null}{" "}
              and turn on <span className="font-medium">Scient Connect</span>.
            </Step>
          </ol>
          <StatusLine status="checking" className="mt-8">
            Looking for your computer…
          </StatusLine>
          <p className="mt-6 text-xs text-muted-foreground">
            Don't have Scient there yet?{" "}
            <ExternalLink href={DOWNLOAD_URL}>Download it</ExternalLink>
          </p>
        </HostedFrame>
      );
    case "computers":
      return <ComputersView model={model} actions={actions} />;
    case "cant-list":
      return (
        <HostedFrame
          title="Can't load your computers"
          description={
            model.offline
              ? "This browser looks offline. Check your connection."
              : "Scient Connect didn't answer. Try again in a moment."
          }
          footer={<AccountFooter account={model.account} onSignOut={actions.signOut} />}
        >
          <Button variant="outline" onClick={actions.tryAgain}>
            Try again
          </Button>
        </HostedFrame>
      );
    case "local-off":
      return (
        <HostedFrame
          title="This computer is off"
          description="Scient on this computer is turned off for this window. Turn it back on, or open another computer."
        >
          <Button variant="outline" render={<Link to="/settings/connections" />}>
            Open settings
          </Button>
        </HostedFrame>
      );
  }
}

function ComputersView({
  model,
  actions,
}: {
  readonly model: Extract<HostedLandingModel, { kind: "computers" }>;
  readonly actions: HostedLandingActions;
}) {
  const summary = summarizeComputers(model.computers);
  const single = model.computers.length === 1;
  const copy = COMPUTERS_COPY[summary];
  return (
    <HostedFrame
      title={copy.title(single)}
      description={copy.description(single)}
      footer={<AccountFooter account={model.account} onSignOut={actions.signOut} />}
    >
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-card">
        {model.computers.map((computer) => (
          <li key={computer.id} className="flex min-h-13 items-center gap-3 px-4 py-3">
            <EnvironmentMachineIcon
              aria-hidden
              kind={computer.machineKind}
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {computer.label}
            </span>
            <StatusLine status={computer.status} className="shrink-0">
              {HOSTED_COMPUTER_STATUS_LABEL[computer.status]}
            </StatusLine>
          </li>
        ))}
      </ul>
      {summary === "unreachable" || summary === "off" ? (
        <Button variant="outline" className="mt-6" onClick={actions.tryAgain}>
          Try again
        </Button>
      ) : null}
    </HostedFrame>
  );
}

const COMPUTERS_COPY: Record<
  Exclude<HostedComputerStatus, "open">,
  {
    readonly title: (single: boolean) => string;
    readonly description: (single: boolean) => string;
  }
> = {
  opening: {
    title: (single) => (single ? "Opening your computer" : "Opening your computers"),
    description: () => "Loading your projects. This takes a few seconds.",
  },
  checking: {
    title: (single) => (single ? "Checking your computer" : "Checking your computers"),
    description: (single) =>
      single
        ? "Found it. Making sure it's awake and ready to open."
        : "Found them. Making sure they're awake and ready to open.",
  },
  off: {
    title: (single) =>
      single ? "Your computer is off or asleep" : "Your computers are off or asleep",
    description: (single) =>
      `Wake ${single ? "it" : "one"} and open Scient there. This page opens it by itself.`,
  },
  unreachable: {
    title: (single) => (single ? "Can't reach your computer" : "Can't reach your computers"),
    description: (single) =>
      `Check that ${single ? "it's" : "they're"} online and Scient is open there.`,
  },
  "needs-update": {
    title: (single) =>
      single ? "Update Scient on your computer" : "Update Scient on your computers",
    description: () => "This page needs a newer version of Scient there.",
  },
};

function HostedFrame({
  title,
  description,
  footer,
  children,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset
      role="main"
      className="relative isolate h-dvh min-h-0 overflow-x-hidden overflow-y-auto"
    >
      <ScientSymbol className="scient-hosted-geometry" />
      {/* The desktop window only moves where CSS opts in, so keep a titlebar strip there; the
          browser gets the website's header so the two read as one site. */}
      {isElectron ? (
        <WorkspacePageHeader electron />
      ) : (
        <header className="scient-hosted-header">
          <ScientFactoryBrand />
        </header>
      )}
      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-6 pb-12">
        <div className="w-full max-w-sm pb-[6vh]">
          <h1 className="text-2xl font-semibold tracking-tight text-pretty text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="mt-2 text-sm text-pretty text-muted-foreground">{description}</p>
          ) : null}
          <div className="mt-8">{children}</div>
        </div>
      </div>
      {footer ? (
        <footer className="relative z-10 flex justify-center px-6 pb-6 text-xs text-muted-foreground">
          {footer}
        </footer>
      ) : null}
    </SidebarInset>
  );
}

/** The boot splash's twin (index.html #boot-shell): one centered 160px symbol while sign-in loads. */
function HostedSplash() {
  return (
    <SidebarInset role="main" aria-label="Scient" className="h-dvh min-h-0">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <ScientSymbol className="size-40 opacity-85" />
      </div>
    </SidebarInset>
  );
}

function Step({ number, children }: { readonly number: number; readonly children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-3">
      <span aria-hidden className="w-3 shrink-0 text-xs text-muted-foreground tabular-nums">
        {number}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

const STATUS_DOT: Record<HostedComputerStatus, { dot: string; ping: string | null }> = {
  checking: { dot: "bg-warning", ping: "bg-warning/60 duration-2000" },
  opening: { dot: "bg-warning", ping: "bg-warning/60 duration-2000" },
  open: { dot: "bg-success", ping: null },
  off: { dot: "bg-muted-foreground/40", ping: null },
  unreachable: { dot: "bg-destructive", ping: null },
  "needs-update": { dot: "bg-muted-foreground/40", ping: null },
};

function StatusLine({
  status,
  className,
  children,
}: {
  readonly status: HostedComputerStatus;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-2 text-xs",
        status === "unreachable" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      <ConnectionStatusDot
        dotClassName={STATUS_DOT[status].dot}
        pingClassName={STATUS_DOT[status].ping}
      />
      {children}
    </span>
  );
}

function AccountFooter({
  account,
  onSignOut,
}: {
  readonly account: string | null;
  readonly onSignOut: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      {account ? <span className="truncate">{account}</span> : null}
      {account ? <span aria-hidden>·</span> : null}
      <button
        type="button"
        className="underline-offset-2 hover:text-foreground hover:underline"
        onClick={onSignOut}
      >
        Sign out
      </button>
    </span>
  );
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      className="text-foreground underline-offset-2 hover:underline"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

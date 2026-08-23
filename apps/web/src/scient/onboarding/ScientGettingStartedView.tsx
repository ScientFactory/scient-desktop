import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useRef } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { SidebarInset } from "../../components/ui/sidebar";
import { ScientSymbol } from "../../components/ScientSymbol";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ProviderLifecycleSetupSurface } from "../providerConnection/ProviderOnboardingPicker";
import { SCIENT_OTHER_WORK_MAX_LENGTH, type ScientWorkKind } from "./model";
import type { ScientOnboardingStep } from "./policy";

const ONBOARDING_STEP_LABELS: Readonly<Record<ScientOnboardingStep, string>> = {
  agent: "Connect",
  preferences: "Your work",
  start: "Start",
};

export function ScientGettingStartedShell(props: {
  readonly children: ReactNode;
  readonly currentStep: ScientOnboardingStep;
  readonly journey: ReadonlyArray<ScientOnboardingStep>;
  readonly canGoBack: boolean;
  readonly onBack: () => void;
  readonly onSkip: () => void;
}) {
  const currentIndex = Math.max(0, props.journey.indexOf(props.currentStep));
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
        <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 py-10 sm:px-8">
          <section
            className="relative isolate w-full -translate-y-3 overflow-hidden rounded-xl border border-border/70 bg-card px-5 py-5 shadow-sm sm:-translate-x-3 sm:-translate-y-4 sm:px-7 sm:py-6"
            data-scient-getting-started-card="true"
          >
            <ScientSymbol className="pointer-events-none absolute right-6 top-16 z-0 size-48 opacity-[0.045] [mask-image:linear-gradient(to_right,black_0%,black_88%,transparent_100%)] sm:right-12 sm:top-12 sm:size-60 dark:opacity-[0.065]" />
            <div className="relative z-10">
              <p className="mx-auto w-fit text-center text-sm font-medium tracking-[-0.015em] text-foreground">
                Getting started with Scient
              </p>
              <div className="mt-1 grid min-h-7 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <Button
                  className="-ms-2 justify-self-start"
                  disabled={!props.canGoBack}
                  onClick={props.onBack}
                  size="xs"
                  type="button"
                  variant="ghost-muted"
                >
                  <ArrowLeftIcon aria-hidden /> Back
                </Button>
                <ol
                  aria-label="Getting started steps"
                  className="flex w-fit items-center gap-4 text-[11px]"
                >
                  {props.journey.map((step, index) => {
                    const current = index === currentIndex;
                    return (
                      <li
                        key={step}
                        aria-current={current ? "step" : undefined}
                        className={
                          current
                            ? "border-b border-primary/70 pb-1 font-medium text-foreground"
                            : "border-b border-transparent pb-1 text-muted-foreground/75 transition-colors"
                        }
                      >
                        <span className="me-1 tabular-nums">{index + 1}</span>
                        {ONBOARDING_STEP_LABELS[step]}
                      </li>
                    );
                  })}
                </ol>
                <Button
                  className="-me-2 justify-self-end"
                  onClick={props.onSkip}
                  size="xs"
                  type="button"
                  variant="ghost-muted"
                >
                  Skip
                </Button>
              </div>
              <div className="mt-4">{props.children}</div>
            </div>
          </section>
        </main>
      </div>
    </SidebarInset>
  );
}

export function GettingStartedStepHeading(props: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <header>
      <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground sm:text-[1.7rem]">
        {props.title}
      </h1>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
        {props.description}
      </p>
    </header>
  );
}

export interface GettingStartedProviderChoice {
  readonly driverKind: ProviderDriverKind;
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly status: string;
  readonly ready: boolean;
  readonly actionable: boolean;
  readonly entry: ProviderInstanceEntry | null;
}

export function GettingStartedAgentStep(props: {
  readonly choices: ReadonlyArray<GettingStartedProviderChoice>;
  readonly environmentId: EnvironmentId;
  readonly selectedEntry: ProviderInstanceEntry | null;
  readonly onSelect: (choice: GettingStartedProviderChoice) => void;
  readonly onContinue: () => void;
  readonly canContinue: boolean;
}) {
  if (props.selectedEntry) {
    return (
      <div>
        <GettingStartedStepHeading
          description="Use the provider’s existing secure setup. Your password never passes through Scient."
          title="Choose an AI"
        />
        <div
          className="mt-5 border-t border-border/70 pt-5 [&_[data-antigravity-setup-surface=true]]:min-h-0 [&_[data-antigravity-setup-surface=true]]:items-start [&_[data-antigravity-setup-surface=true]]:px-0 [&_[data-antigravity-setup-surface=true]]:py-1 [&_[data-antigravity-setup-surface=true]]:text-left [&_[data-provider-onboarding-view]]:px-0 [&_[data-provider-onboarding-view]]:pb-0"
          data-scient-getting-started-provider="true"
        >
          <ProviderLifecycleSetupSurface
            entry={props.selectedEntry}
            environmentId={props.environmentId}
          />
        </div>
        {props.canContinue ? (
          <div className="mt-7 flex justify-end">
            <Button onClick={props.onContinue} size="sm" type="button">
              Continue
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <GettingStartedStepHeading
        description="Connect an existing subscription, or skip this for now."
        title="Choose an AI"
      />
      <div className="mt-6 divide-y divide-border/70 border-y border-border/70">
        {props.choices.map((choice) => {
          const Icon = choice.icon;
          return (
            <button
              key={choice.driverKind}
              className="group flex min-h-16 w-full items-center gap-3 px-1 py-3 text-left transition-colors hover:bg-foreground/3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!choice.actionable}
              onClick={() => props.onSelect(choice)}
              type="button"
            >
              <span className="flex size-8 shrink-0 items-center justify-center">
                <Icon className="size-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{choice.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{choice.status}</span>
              </span>
              {choice.ready ? (
                <span className="flex items-center gap-1 text-success text-xs font-medium">
                  <CheckIcon aria-hidden className="size-3.5" /> Ready
                </span>
              ) : (
                <ChevronRightIcon
                  aria-hidden
                  className="size-4 shrink-0 text-icon-muted transition-transform group-hover:translate-x-0.5"
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <Button render={<Link to="/settings/providers" />} size="sm" variant="ghost-muted">
          More providers
        </Button>
        {props.canContinue ? (
          <Button onClick={props.onContinue} size="sm" type="button">
            Continue
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const WORK_KIND_LABELS: ReadonlyArray<{
  readonly value: ScientWorkKind;
  readonly label: string;
}> = [
  { value: "scientific", label: "Research & science" },
  { value: "code", label: "Coding & development" },
  { value: "academic", label: "Academic work" },
];

const capitalizeInitialLowercase = (value: string) =>
  value.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase());

export function GettingStartedPreferencesStep(props: {
  readonly workKinds: ReadonlyArray<ScientWorkKind>;
  readonly otherSelected: boolean;
  readonly otherWork: string;
  readonly onToggleWorkKind: (kind: ScientWorkKind) => void;
  readonly onOtherSelectedChange: (selected: boolean) => void;
  readonly onOtherWorkChange: (value: string) => void;
  readonly onContinue: () => void;
}) {
  const otherInputRef = useRef<HTMLInputElement>(null);
  const wasOtherSelectedRef = useRef(props.otherSelected);

  useEffect(() => {
    const wasJustSelected = props.otherSelected && !wasOtherSelectedRef.current;
    wasOtherSelectedRef.current = props.otherSelected;
    if (wasJustSelected) otherInputRef.current?.focus();
  }, [props.otherSelected]);

  return (
    <div>
      <GettingStartedStepHeading
        description="Choose any that fit. You can change this later."
        title="How will you use Scient?"
      />
      <fieldset className="mt-5 max-w-md">
        <legend className="sr-only">Kinds of work</legend>
        {WORK_KIND_LABELS.map((option) => {
          const selected = props.workKinds.includes(option.value);
          return (
            <label
              key={option.value}
              className="flex min-h-11 cursor-pointer items-center gap-2.5 border-b border-border/40 py-2 text-sm text-foreground"
            >
              <Checkbox
                checked={selected}
                className="size-4.5 rounded-[0.2rem] border-border/80 shadow-none sm:size-4.5 [&_[data-slot=checkbox-indicator]]:bg-primary/75"
                onCheckedChange={() => props.onToggleWorkKind(option.value)}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
        <div className="flex min-h-11 items-center gap-2.5 py-2 text-sm text-foreground">
          <label className="flex shrink-0 cursor-pointer items-center gap-2.5">
            <Checkbox
              checked={props.otherSelected}
              className="size-4.5 rounded-[0.2rem] border-border/80 shadow-none sm:size-4.5 [&_[data-slot=checkbox-indicator]]:bg-primary/75"
              onCheckedChange={(checked) => props.onOtherSelectedChange(checked === true)}
            />
            <span>Other</span>
          </label>
          {props.otherSelected ? (
            <Input
              ref={otherInputRef}
              aria-label="Describe how you use Scient"
              autoCapitalize="sentences"
              className="min-w-28 flex-1 rounded-none border-b border-border/60 px-0 shadow-none transition-colors focus-within:border-primary/75"
              maxLength={SCIENT_OTHER_WORK_MAX_LENGTH}
              onChange={(event) =>
                props.onOtherWorkChange(
                  capitalizeInitialLowercase(event.currentTarget.value).slice(
                    0,
                    SCIENT_OTHER_WORK_MAX_LENGTH,
                  ),
                )
              }
              placeholder="Tell us what you do"
              unstyled
              value={props.otherWork}
            />
          ) : null}
        </div>
      </fieldset>
      <div className="mt-7 flex justify-end">
        <Button onClick={props.onContinue} size="sm" type="button">
          Continue
        </Button>
      </div>
    </div>
  );
}

export function GettingStartedStartStep(props: { readonly onAddProject: () => void }) {
  return (
    <div>
      <GettingStartedStepHeading
        description="Add a project to give your tasks a workspace."
        title="Start working"
      />
      <div className="mt-7 flex flex-wrap items-center gap-2">
        <Button onClick={props.onAddProject} size="sm" type="button">
          <PlusIcon aria-hidden /> Add project
        </Button>
      </div>
    </div>
  );
}

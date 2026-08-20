import {
  AlertTriangle,
  Check,
  FlaskConical,
  Laptop,
  RefreshCw,
  Server,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import type { ComputeRuntimeVerification } from "@scientfactory/compute";
import type {
  ComputeEnvironmentTarget,
  ComputeExperienceFixture,
  ComputeLanguageCard,
} from "./computeExperienceFixtures";
import {
  COMPUTE_LAB_SCENARIO_EVENT,
  readComputeLabScenario,
  type ComputeLabScenarioName,
} from "./state";
import { computeExperienceFixture } from "./computeExperienceFixtures";

/**
 * Settings → Scientific Computing, as the proposal describes it.
 *
 * This renders in the real settings shell (`SettingsPageContainer` /
 * `SettingsSection` / `SettingsRow`) rather than in a mock frame, because the
 * question worth answering here is whether a discovery report fits the density
 * of a settings page at all -- and that is only answerable next to the other
 * settings pages.
 */

const READINESS_LABEL: Record<ComputeRuntimeVerification["readiness"], string> = {
  ready: "Usable",
  "missing-requirement": "Missing requirements",
  "unsupported-version": "Version too old",
  unusable: "Unusable",
};

const SOURCE_LABEL: Record<ComputeRuntimeVerification["profile"]["source"], string> = {
  configured: "Configured in settings",
  project: "Found in this project",
  path: "Found on PATH",
  conventional: "Found in a conventional location",
};

function EnvironmentScope({
  environments,
  activeId,
}: {
  readonly environments: readonly ComputeEnvironmentTarget[];
  readonly activeId: string;
}) {
  const active =
    environments.find((environment) => environment.id === activeId) ?? environments[0]!;
  const others = environments.filter((environment) => environment.id !== active.id);

  return (
    <div className="mx-3 rounded-xl border border-border bg-muted/30 p-3 sm:mx-4">
      <div className="flex items-center gap-2">
        {active.kind === "remote" ? (
          <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="text-sm">
          <span className="text-muted-foreground">Applies to: </span>
          <span className="font-medium">{active.label}</span>
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {active.kind === "remote" ? "remote environment" : "local environment"}
        </span>
      </div>

      {/*
        REVISION — the other environments are named here, not left implicit.

        The proposal scopes the page to whichever environment is selected and
        states the scope at the top, which is necessary and, I think, not
        sufficient. "Applies to: Research Server" only warns a user who already
        suspected there was more than one place these settings could land. A
        scientist who set up Python on their Mac last week, opens a remote
        project, and comes here to check will read a Python card that says Off
        and reasonably conclude the setting was lost.

        Naming the others turns an invisible dependency into a visible one and
        costs a line. It is also the cheap version -- the fuller answer is a page
        that lists every environment and lets you switch here, which is more page
        than Phase 4 needs.
      */}
      {others.length === 0 ? null : (
        <p className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
          Configured separately for{" "}
          {others.map((environment, index) => (
            <span key={environment.id}>
              {index > 0 ? ", " : ""}
              <button
                className="font-medium text-foreground underline-offset-2 hover:underline"
                type="button"
              >
                {environment.label}
              </button>
            </span>
          ))}
          . Enabling Python here does not enable it there.
        </p>
      )}
    </div>
  );
}

function CandidateRow({
  verification,
  preferred,
}: {
  readonly verification: ComputeRuntimeVerification;
  readonly preferred: boolean;
}) {
  const usable = verification.readiness === "ready";
  return (
    <div
      className={`rounded-lg border p-2.5 ${
        preferred ? "border-primary/50 bg-primary/5" : "border-border bg-background/60"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium">{verification.profile.displayName}</span>
            <span className="rounded border border-border bg-muted/60 px-1 text-[10px] text-muted-foreground">
              {verification.profile.languageVersion}
              {verification.profile.architecture === null
                ? ""
                : ` · ${verification.profile.architecture}`}
            </span>
            {preferred ? (
              <span className="rounded border border-primary/40 bg-primary/10 px-1 text-[10px] font-medium text-primary">
                preferred
              </span>
            ) : null}
          </div>
          {/*
            The exact path, never abbreviated. This is the field a user came to
            this page to read: two interpreters can share a display name and a
            version and be completely different environments.
          */}
          <code className="mt-1 block wrap-anywhere text-[11px] text-muted-foreground">
            {verification.profile.executable}
          </code>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {SOURCE_LABEL[verification.profile.source]}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            usable
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : verification.readiness === "unusable"
                ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          }`}
        >
          {READINESS_LABEL[verification.readiness]}
        </span>
      </div>

      {verification.message === null ? null : (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {verification.message}
        </p>
      )}

      {verification.missingRequirements.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">missing</span>
          {verification.missingRequirements.map((requirement) => (
            <code
              className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-700 dark:text-amber-400"
              key={requirement}
            >
              {requirement}
            </code>
          ))}
        </div>
      ) : null}

      {usable && !preferred ? (
        <div className="mt-2 flex justify-end">
          <Button className="h-7 text-[11px]" size="sm" variant="ghost">
            Prefer this interpreter
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CapabilityFacts({ card }: { readonly card: ComputeLanguageCard }) {
  const unsupported = card.capabilities.filter((capability) => !capability.supported);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {card.capabilities.map((capability) => (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
              capability.supported
                ? "border-border bg-muted/50 text-muted-foreground"
                : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            }`}
            key={capability.label}
          >
            {capability.supported ? (
              <Check className="size-3" aria-hidden="true" />
            ) : (
              <X className="size-3" aria-hidden="true" />
            )}
            {capability.label}
          </span>
        ))}
      </div>
      {/*
        The reason a capability is missing is the half a user can act on, so it
        is stated rather than left to a hover. "Figures: no" on its own is a
        dead end.
      */}
      {unsupported.map((capability) =>
        capability.reason === null ? null : (
          <p
            className="mt-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400"
            key={capability.label}
          >
            {capability.label}: {capability.reason}
          </p>
        ),
      )}
    </div>
  );
}

function LanguageCard({ card }: { readonly card: ComputeLanguageCard }) {
  const [enabled, setEnabled] = useState(card.enablement === "enabled");
  useEffect(() => setEnabled(card.enablement === "enabled"), [card.enablement]);

  const usable = card.candidates.filter((candidate) => candidate.readiness === "ready").length;

  return (
    <div className="mx-3 rounded-xl border border-border sm:mx-4">
      <SettingsRow
        control={
          <Button
            className="h-8 min-w-24 text-xs"
            onClick={() => setEnabled((value) => !value)}
            size="sm"
            variant={enabled ? "secondary" : "default"}
          >
            {enabled ? "Enabled" : "Off"}
          </Button>
        }
        description={
          enabled
            ? "Scient found these interpreters on this environment. It has not installed or changed anything."
            : "Enable to let Scient look for interpreters. It will not download or modify a runtime."
        }
        title={card.displayName}
      />

      {enabled ? (
        <div className="space-y-3 border-t border-border px-3 pt-3 pb-3 sm:px-4">
          {/*
            The proposal's hardest requirement, and the one most likely to be
            lost in implementation: when the configured executable is invalid,
            keep showing that exact choice. A page that silently reported the
            working fallback would let a user believe their configured runtime
            was fine, and every result after that is attributed to the wrong
            environment.
          */}
          {card.configuredProblem === null ? null : (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5">
              <TriangleAlert
                className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-red-600 dark:text-red-400">
                  Your configured interpreter cannot be used
                </p>
                <code className="mt-0.5 block wrap-anywhere text-[11px] text-red-600/90 dark:text-red-400/90">
                  {card.preferredExecutable}
                </code>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {card.configuredProblem} Scient has not switched to another interpreter — pick one
                  below, or set Preferred runtime back to Automatic.
                </p>
              </div>
            </div>
          )}

          <div>
            <p className="text-[12px] font-medium">Preferred runtime</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Button
                className="h-7 text-[11px]"
                size="sm"
                variant={card.preferredExecutable === null ? "secondary" : "ghost"}
              >
                Automatic
              </Button>
              {card.preferredExecutable === null ? (
                <span className="text-[11px] text-muted-foreground">
                  Configured runtime, then the project&apos;s <code>.venv</code>, then PATH.
                </span>
              ) : (
                <code className="wrap-anywhere text-[11px] text-muted-foreground">
                  {card.preferredExecutable}
                </code>
              )}
            </div>
          </div>

          <div>
            <p className="text-[12px] font-medium">Required components</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {card.requiredComponents.map((component) => (
                <code
                  className="rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  key={component}
                >
                  {component}
                </code>
              ))}
              <span className="text-[11px] text-muted-foreground">
                must already be installed in the interpreter you choose.
              </span>
            </div>
          </div>

          <div>
            <p className="text-[12px] font-medium">Supported here</p>
            <div className="mt-1.5">
              <CapabilityFacts card={card} />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-medium">
                Detected interpreters
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {card.candidates.length} found · {usable} usable
                </span>
              </p>
              <Button className="h-7 text-[11px]" size="sm" variant="ghost">
                <RefreshCw
                  className={`size-3 ${card.verifying ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                Verify again
              </Button>
            </div>

            {card.candidates.length === 0 ? (
              <p className="mt-2 rounded-lg border border-dashed border-border p-3 text-[11px] text-muted-foreground">
                No interpreters found on this environment.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {usable === 0 ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5">
                    <AlertTriangle
                      className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                      aria-hidden="true"
                    />
                    <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                      Nothing here can host a session yet. Each interpreter below says what it is
                      missing; install those components yourself and verify again.
                    </p>
                  </div>
                ) : null}
                {card.candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.profile.executable}
                    preferred={
                      card.preferredExecutable === null
                        ? candidate.readiness === "ready" &&
                          card.candidates.findIndex((entry) => entry.readiness === "ready") ===
                            card.candidates.indexOf(candidate)
                        : candidate.profile.executable === card.preferredExecutable
                    }
                    verification={candidate}
                  />
                ))}
              </div>
            )}

            {card.lastVerifiedAt === null ? null : (
              <p className="mt-2 text-[10px] text-muted-foreground">
                Last verified {new Date(card.lastVerifiedAt).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ScientComputeSettingsPanel() {
  const [scenario, setScenario] = useState<ComputeLabScenarioName>(readComputeLabScenario);

  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<ComputeLabScenarioName>).detail;
      if (typeof next === "string") setScenario(next);
    };
    window.addEventListener(COMPUTE_LAB_SCENARIO_EVENT, onChange);
    return () => window.removeEventListener(COMPUTE_LAB_SCENARIO_EVENT, onChange);
  }, []);

  const fixture: ComputeExperienceFixture = computeExperienceFixture(scenario);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="scientific-computing"
        title="Scientific Computing"
        headerAction={
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            <FlaskConical className="size-3" aria-hidden="true" />
            UX Lab
          </span>
        }
      >
        <p className="px-3 text-[13px] leading-relaxed text-muted-foreground/80 sm:px-4">
          Enable only the languages you use. Scient discovers what is already installed; it never
          downloads, installs, or modifies a runtime.{" "}
          <span className="text-muted-foreground/70">
            (This page is a UX Lab design proposition, not shipped behaviour.)
          </span>
        </p>

        <EnvironmentScope
          activeId={fixture.activeEnvironmentId}
          environments={fixture.environments}
        />

        {fixture.languages.map((card) => (
          <LanguageCard card={card} key={card.languageId} />
        ))}

        {/*
          The languages that are not here yet are stated rather than implied.
          Phase 4 ships Python only, and a page with a single card invites the
          reading that Scient only ever does Python -- while a greyed R card
          would invite the reading that R is one click away.
        */}
        <p className="px-3 text-[11px] leading-relaxed text-muted-foreground sm:px-4">
          R, Julia, and MATLAB will appear here as separate cards. Each is enabled on its own, and
          enabling one never installs or activates another.
        </p>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

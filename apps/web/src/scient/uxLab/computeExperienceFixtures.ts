import type { ComputeRuntimeVerification, ComputeSessionRecord } from "@scientfactory/compute";

import {
  computeLabFixture,
  computeLabScenarios,
  type ComputeLabFixture,
  type ComputeLabScenario,
} from "./computeFixtures";

/**
 * Experience-level compute fixtures.
 *
 * `computeFixtures.ts` models one session: its record, its executions, their
 * outputs. That is the right substrate for arguing about a transcript, and it is
 * not enough to argue about an *experience*. The proposal under review makes
 * claims that live outside a single session -- whether the capability is enabled
 * at all, which environment settings apply to, what happens to yesterday's
 * session, and what a `.py` editor shows before anything has run. None of those
 * are session fields, so they are added here rather than smuggled into the
 * session record where they would misrepresent the contract.
 *
 * Each scenario carries a `claim`: the specific proposal decision that state
 * exists to test. If a state cannot be tied to a claim it should not be in the
 * picker.
 */

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export type ComputeEnvironmentTarget = {
  readonly id: string;
  readonly label: string;
  readonly kind: "local" | "remote";
  readonly reachable: boolean;
};

const THIS_MAC: ComputeEnvironmentTarget = {
  id: "local",
  label: "This Mac",
  kind: "local",
  reachable: true,
};

const RESEARCH_SERVER: ComputeEnvironmentTarget = {
  id: "research-server",
  label: "Research Server",
  kind: "remote",
  reachable: true,
};

// ---------------------------------------------------------------------------
// Language cards (the Settings surface)
// ---------------------------------------------------------------------------

export type ComputeEnablement = "off" | "enabled";

/**
 * A declared capability, with the reason it is or is not available.
 *
 * The proposal asks the settings card to show "supported capabilities: execute,
 * interrupt, restart, figures" as displayed facts rather than toggles, which is
 * right. Worth noting for the ADR: the contract has no capability field. These
 * are properties of the transport plus the runtime, so whatever ships has to
 * derive them somewhere -- and a derived fact still needs a reason attached, or
 * "interrupt: no" is unactionable.
 */
export type ComputeCapabilityFact = {
  readonly label: string;
  readonly supported: boolean;
  readonly reason: string | null;
};

export type ComputeLanguageCard = {
  readonly languageId: string;
  readonly displayName: string;
  readonly enablement: ComputeEnablement;
  /** `null` means Automatic; a string is an explicitly configured executable. */
  readonly preferredExecutable: string | null;
  /**
   * Set when the configured executable cannot be used. The proposal is
   * explicit that Scient must keep showing the invalid choice rather than
   * quietly resolving to a working interpreter, so this is a first-class field
   * instead of an absence.
   */
  readonly configuredProblem: string | null;
  readonly candidates: readonly ComputeRuntimeVerification[];
  readonly capabilities: readonly ComputeCapabilityFact[];
  readonly requiredComponents: readonly string[];
  readonly lastVerifiedAt: string | null;
  readonly verifying: boolean;
};

const JUPYTER_CAPABILITIES: readonly ComputeCapabilityFact[] = [
  { label: "Execute", supported: true, reason: null },
  { label: "Interrupt", supported: true, reason: null },
  { label: "Restart", supported: true, reason: null },
  { label: "Figures", supported: true, reason: null },
];

const NO_MATPLOTLIB_CAPABILITIES: readonly ComputeCapabilityFact[] = [
  { label: "Execute", supported: true, reason: null },
  { label: "Interrupt", supported: true, reason: null },
  { label: "Restart", supported: true, reason: null },
  {
    label: "Figures",
    supported: false,
    reason: "matplotlib is not installed in this interpreter.",
  },
];

const PYTHON_REQUIREMENTS = ["jupyter_client", "ipykernel"] as const;

const REMOTE_CANDIDATES: readonly ComputeRuntimeVerification[] = [
  {
    profile: {
      languageId: "python" as ComputeRuntimeVerification["profile"]["languageId"],
      source: "configured",
      executable: "/opt/conda/envs/cohort/bin/python",
      languageVersion: "3.11.9",
      architecture: "x86_64",
      displayName: "conda env (cohort)",
    },
    readiness: "ready",
    missingRequirements: [],
    message: null,
  },
  {
    profile: {
      languageId: "python" as ComputeRuntimeVerification["profile"]["languageId"],
      source: "path",
      executable: "/usr/bin/python3",
      languageVersion: "3.10.12",
      architecture: "x86_64",
      displayName: "System Python",
    },
    readiness: "missing-requirement",
    missingRequirements: ["jupyter_client", "ipykernel"],
    message: "This interpreter is on PATH but cannot host a session yet.",
  },
];

const INVALID_CONFIGURED: ComputeRuntimeVerification = {
  profile: {
    languageId: "python" as ComputeRuntimeVerification["profile"]["languageId"],
    source: "configured",
    executable: "/Users/yaacov/.venvs/old-cohort/bin/python",
    languageVersion: "unknown",
    architecture: null,
    displayName: "Configured interpreter",
  },
  readiness: "unusable",
  missingRequirements: [],
  message: "No such file or directory. This interpreter was removed or renamed.",
};

// ---------------------------------------------------------------------------
// Session lifetimes
// ---------------------------------------------------------------------------

/**
 * A finished runtime lifetime.
 *
 * This exists because the proposal's main correction is right and the contract
 * already supports it: a restart is a new `generation` inside one `sessionId`,
 * and a new runtime lifetime is a new `sessionId`. Those are two different
 * boundaries and the proposal's copy runs them together ("Session restarted --
 * variables cleared" alongside "Previous session ended when Scient closed").
 * The transcript has to distinguish them, because one of them is a boundary
 * inside the thing you are reading and the other is a boundary around it.
 */
export type ComputeLifetime = {
  readonly sessionId: string;
  readonly label: string;
  readonly endedReason: string;
  readonly endedAt: string;
  readonly generationCount: number;
  readonly executionCount: number;
  readonly runtimeLabel: string;
};

const CLOSED_LIFETIME: ComputeLifetime = {
  sessionId: "cs_01J9H2K3M4N5P6Q7R8S9T0",
  label: "Cohort analysis",
  endedReason: "Ended when Scient closed",
  endedAt: "2026-08-19T18:41:07.000Z",
  generationCount: 2,
  executionCount: 14,
  runtimeLabel: "Project virtualenv (.venv) · Python 3.12.4",
};

const OOM_LIFETIME: ComputeLifetime = {
  sessionId: "cs_01J9F0A1B2C3D4E5F6G7H8",
  label: "Cohort analysis",
  endedReason: "Lost — interpreter killed (out of memory)",
  endedAt: "2026-08-19T11:02:55.000Z",
  generationCount: 1,
  executionCount: 6,
  runtimeLabel: "Homebrew Python 3.13 · Python 3.13.1",
};

// ---------------------------------------------------------------------------
// The editor surface
// ---------------------------------------------------------------------------

export type ComputeEditorAction = "run-selection" | "run-cell" | "run-file";

export type ComputeEditorLatest = {
  readonly executionId: string;
  readonly sourceLabel: string;
  readonly bufferState: "saved" | "dirty";
  readonly status: "running" | "succeeded" | "failed" | "queued";
  readonly detail: string;
  readonly elapsedLabel: string | null;
  readonly figure: boolean;
};

export type ComputeEditorContext = {
  readonly relativePath: string;
  readonly languageLabel: string;
  readonly bufferState: "saved" | "dirty";
  /** What the primary button does right now, from caret and selection. */
  readonly primaryAction: ComputeEditorAction;
  readonly availableActions: readonly ComputeEditorAction[];
  readonly caretCellLabel: string | null;
  readonly selectionLabel: string | null;
  readonly latest: ComputeEditorLatest | null;
};

const SAVED_EDITOR: ComputeEditorContext = {
  relativePath: "analysis.py",
  languageLabel: "Python 3.12",
  bufferState: "saved",
  primaryAction: "run-cell",
  availableActions: ["run-cell", "run-file"],
  caretCellLabel: "cell 3 of 7",
  selectionLabel: null,
  latest: null,
};

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

export type ComputeConsoleState = {
  readonly draft: string;
  readonly historyDepth: number;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
};

const CONSOLE_READY: ComputeConsoleState = {
  draft: "",
  historyDepth: 12,
  enabled: true,
  disabledReason: null,
};

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export type ComputeExperienceFixture = ComputeLabFixture & {
  readonly enablement: ComputeEnablement;
  readonly environments: readonly ComputeEnvironmentTarget[];
  readonly activeEnvironmentId: string;
  readonly languages: readonly ComputeLanguageCard[];
  readonly priorLifetimes: readonly ComputeLifetime[];
  readonly editor: ComputeEditorContext;
  readonly console: ComputeConsoleState;
  /** Which proposal decision this state exists to test. */
  readonly claim: string;
};

export const computeExperienceScenarios = [
  ...computeLabScenarios,
  { value: "compute-off", label: "Off · capability not enabled" },
  { value: "enabled-not-started", label: "Enabled · no session yet" },
  { value: "prior-lifetime", label: "Reopened · yesterday's session" },
  { value: "two-lifetimes", label: "History · two ended lifetimes" },
  { value: "console-exploration", label: "Console · queued behind a cell" },
  { value: "invalid-configured", label: "Settings · configured path is gone" },
  { value: "missing-requirements", label: "Settings · requirements missing" },
  { value: "remote-environment", label: "Settings · Research Server" },
  { value: "editor-dirty-selection", label: "Editor · unsaved selection run" },
] as const;

export type ComputeExperienceScenario = (typeof computeExperienceScenarios)[number]["value"];

export const DEFAULT_COMPUTE_EXPERIENCE_SCENARIO: ComputeExperienceScenario = "ready-idle";

export function normalizeComputeExperienceScenario(
  value: string | null,
): ComputeExperienceScenario {
  return computeExperienceScenarios.some((scenario) => scenario.value === value)
    ? (value as ComputeExperienceScenario)
    : DEFAULT_COMPUTE_EXPERIENCE_SCENARIO;
}

function isSessionScenario(scenario: ComputeExperienceScenario): scenario is ComputeLabScenario {
  return computeLabScenarios.some((entry) => entry.value === scenario);
}

function pythonCard(overrides: Partial<ComputeLanguageCard> = {}): ComputeLanguageCard {
  return {
    languageId: "python",
    displayName: "Python",
    enablement: "enabled",
    preferredExecutable: null,
    configuredProblem: null,
    candidates: computeLabFixture("no-session").discovered,
    capabilities: JUPYTER_CAPABILITIES,
    requiredComponents: [...PYTHON_REQUIREMENTS],
    lastVerifiedAt: "2026-08-20T09:13:58.000Z",
    verifying: false,
    ...overrides,
  };
}

/** The session the editor dock and the panel share, when one is running. */
function readySession(): ComputeSessionRecord {
  return computeLabFixture("ready-idle").session!;
}

const EMPTY_FIXTURE = {
  session: null,
  executions: [],
  outputs: {},
} as const;

export function computeExperienceFixture(
  scenario: ComputeExperienceScenario,
): ComputeExperienceFixture {
  const base: Omit<
    ComputeExperienceFixture,
    keyof ComputeLabFixture | "claim" | "enablement" | "priorLifetimes"
  > = {
    environments: [THIS_MAC, RESEARCH_SERVER],
    activeEnvironmentId: THIS_MAC.id,
    languages: [pythonCard()],
    editor: SAVED_EDITOR,
    console: CONSOLE_READY,
  };

  // The eight session states keep their existing transcripts and gain the
  // experience frame around them, so the panel work already reviewed stays
  // comparable rather than being replaced.
  if (isSessionScenario(scenario)) {
    const fixture = computeLabFixture(scenario);
    return {
      ...fixture,
      ...base,
      enablement: "enabled",
      priorLifetimes: [],
      editor: {
        ...SAVED_EDITOR,
        latest:
          scenario === "running-queue"
            ? {
                executionId: "ce_0004_fit",
                sourceLabel: "analysis.py · lines 18–26",
                bufferState: "saved",
                status: "running",
                detail: "Sampling 4 chains…",
                elapsedLabel: "12.4 s",
                figure: false,
              }
            : scenario === "traceback"
              ? {
                  executionId: "ce_0004_merge",
                  sourceLabel: "analysis.py · lines 31–34",
                  bufferState: "dirty",
                  status: "failed",
                  detail: "KeyError: 'subject_id'",
                  elapsedLabel: "0.21 s",
                  figure: false,
                }
              : scenario === "ready-idle"
                ? {
                    executionId: "ce_0003_figure",
                    sourceLabel: "analysis.py · lines 12–17",
                    bufferState: "saved",
                    status: "succeeded",
                    detail: "1 figure",
                    elapsedLabel: "0.84 s",
                    figure: true,
                  }
                : null,
      },
      claim: fixture.note,
    };
  }

  switch (scenario) {
    case "compute-off":
      return {
        ...EMPTY_FIXTURE,
        ...base,
        discovered: [],
        enablement: "off",
        languages: [
          pythonCard({
            enablement: "off",
            candidates: [],
            lastVerifiedAt: null,
          }),
        ],
        priorLifetimes: [],
        editor: { ...SAVED_EDITOR, latest: null },
        console: {
          draft: "",
          historyDepth: 0,
          enabled: false,
          disabledReason: "Enable Python compute to use the console.",
        },
        note: "Opening a project must not probe Python or start a kernel. Off is a calm state, not a blocked one.",
        claim:
          "Decision 1 — no compute onboarding on launch. Tests whether the off state reads as calm rather than broken, and whether the editor strip is discoverable without nagging.",
      };

    case "enabled-not-started": {
      const discovered = computeLabFixture("no-session").discovered;
      return {
        ...EMPTY_FIXTURE,
        ...base,
        discovered,
        enablement: "enabled",
        priorLifetimes: [],
        editor: { ...SAVED_EDITOR, latest: null },
        note: "Discovery has run and resolved a runtime; nothing has started. The exact path is shown before the first execution, and is still changeable here.",
        claim:
          "Decision 3 — no kernel starts on project open. Tests the resolved-runtime header and the visible priority order (configured → project .venv → PATH).",
      };
    }

    case "prior-lifetime": {
      const previous = computeLabFixture("ready-idle");
      return {
        session: null,
        executions: previous.executions,
        outputs: previous.outputs,
        discovered: previous.discovered,
        ...base,
        enablement: "enabled",
        priorLifetimes: [CLOSED_LIFETIME],
        editor: { ...SAVED_EDITOR, latest: null },
        console: {
          ...CONSOLE_READY,
          enabled: false,
          disabledReason: "Start a session to run code.",
        },
        note: "The transcript is real and inspectable; the variables are not. Nothing restarts or replays on its own.",
        claim:
          "The proposal's main correction — a new durable session identity per runtime lifetime, no permanent `default`. Tests whether history stays useful when nothing is live.",
      };
    }

    case "two-lifetimes": {
      const current = computeLabFixture("restarted");
      return {
        ...current,
        ...base,
        enablement: "enabled",
        priorLifetimes: [OOM_LIFETIME, CLOSED_LIFETIME],
        note: "Two boundaries at once: generations inside this session, and two earlier lifetimes around it. They must not look the same.",
        claim:
          "The distinction the proposal blurs — a restart (new generation, same session) versus a new lifetime (new session id). Tests whether one transcript can carry both without lying.",
      };
    }

    case "console-exploration": {
      const running = computeLabFixture("running-queue");
      return {
        ...running,
        ...base,
        enablement: "enabled",
        priorLifetimes: [],
        console: { ...CONSOLE_READY, draft: "cohort.groupby('arm').week12.describe()" },
        editor: {
          ...SAVED_EDITOR,
          latest: {
            executionId: "ce_0004_fit",
            sourceLabel: "analysis.py · lines 18–26",
            bufferState: "saved",
            status: "running",
            detail: "Sampling 4 chains…",
            elapsedLabel: "12.4 s",
            figure: false,
          },
        },
        note: "Console code has no file to point at, and it queues behind the cell that is already running.",
        claim:
          "Decision 4 — the console belongs to the full surface. Tests queue position, per-execution Cancel, and that Cancel is not confused with Interrupt.",
      };
    }

    case "invalid-configured":
      return {
        ...EMPTY_FIXTURE,
        ...base,
        discovered: [INVALID_CONFIGURED, ...computeLabFixture("no-session").discovered],
        enablement: "enabled",
        languages: [
          pythonCard({
            preferredExecutable: INVALID_CONFIGURED.profile.executable,
            configuredProblem: INVALID_CONFIGURED.message,
            candidates: [INVALID_CONFIGURED, ...computeLabFixture("no-session").discovered],
          }),
        ],
        priorLifetimes: [],
        editor: { ...SAVED_EDITOR, latest: null },
        console: {
          ...CONSOLE_READY,
          enabled: false,
          disabledReason: "The configured interpreter is unavailable.",
        },
        note: "The configured choice is broken and stays visible. Silently succeeding with a different Python would be the worse bug.",
        claim:
          "Decision 2 — settings hold the default, the project resolves the exact runtime. Tests the proposal's explicit rule against quiet fallback.",
      };

    case "missing-requirements": {
      const candidates = computeLabFixture("no-session").discovered.filter(
        (candidate) => candidate.readiness !== "ready",
      );
      return {
        ...EMPTY_FIXTURE,
        ...base,
        discovered: candidates,
        enablement: "enabled",
        languages: [
          pythonCard({
            candidates,
            capabilities: NO_MATPLOTLIB_CAPABILITIES,
          }),
        ],
        priorLifetimes: [],
        editor: { ...SAVED_EDITOR, latest: null },
        console: {
          ...CONSOLE_READY,
          enabled: false,
          disabledReason: "No usable interpreter.",
        },
        note: "Enabled, discovered, and nothing usable. Scient will not install anything, so the remedy has to be a sentence the user can act on.",
        claim:
          "Decision 2 — enabling performs discovery only, never installation. Tests required components and per-candidate remedies with zero usable runtimes.",
      };
    }

    case "remote-environment":
      return {
        ...EMPTY_FIXTURE,
        ...base,
        discovered: REMOTE_CANDIDATES,
        activeEnvironmentId: RESEARCH_SERVER.id,
        enablement: "enabled",
        languages: [
          pythonCard({
            preferredExecutable: REMOTE_CANDIDATES[0]!.profile.executable,
            candidates: REMOTE_CANDIDATES,
          }),
        ],
        priorLifetimes: [],
        editor: { ...SAVED_EDITOR, latest: null },
        note: "The same settings page, a different machine. x86_64, conda instead of .venv, and a runtime set with nothing in common with the local one.",
        claim:
          "Decision 2 — settings are per server environment. Tests whether 'Applies to' is enough to stop a user editing the wrong machine's defaults.",
      };

    case "editor-dirty-selection": {
      const fixture = computeLabFixture("ready-idle");
      return {
        ...fixture,
        session: readySession(),
        ...base,
        enablement: "enabled",
        priorLifetimes: [],
        editor: {
          relativePath: "analysis.py",
          languageLabel: "Python 3.12",
          bufferState: "dirty",
          primaryAction: "run-selection",
          availableActions: ["run-selection", "run-cell", "run-file"],
          caretCellLabel: "cell 3 of 7",
          selectionLabel: "lines 31–38",
          latest: {
            executionId: "ce_0003_figure",
            sourceLabel: "analysis.py · lines 31–38",
            bufferState: "dirty",
            status: "succeeded",
            detail: "1 figure",
            elapsedLabel: "0.84 s",
            figure: true,
          },
        },
        note: "A selection in an unsaved buffer. The run uses the buffer, nothing is force-saved, and the record has to say so.",
        claim:
          "Decision 5 — selection, caret cell, and current-buffer file execution without autosaving. Tests whether 'Unsaved buffer' is legible at strip density.",
      };
    }
  }
}

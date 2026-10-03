import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  DroidSettings,
  GrokSettings,
  OpenCodeSettings,
  PiSettings,
  OmpSettings,
  ScientAgentSettings,
  compareProviderDriverKinds,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  DroidIcon,
  GrokIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
  OhMyPiIcon,
  ScientAgentIcon,
} from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema: ProviderSettingsSchema;
  /** False when model definitions must come from the native provider catalog. */
  readonly supportsCustomModels?: boolean;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. The flag is a property of the driver kind (not a
   * specific instance), so every instance of that driver — built-in default
   * or custom — advertises the same marker.
   */
  readonly badgeLabel?: string;
  /**
   * Company behind the provider, shown beside its product name so people who
   * know "ChatGPT" or "Gemini" but not "Codex" or "Antigravity" can find it.
   */
  readonly vendorLabel?: string;
  /** The account people sign in with, named the way they know it. */
  readonly accountLabel?: string;
  /** Extra lowercase terms provider search should match, e.g. "chatgpt". */
  readonly searchAliases?: ReadonlyArray<string>;
}

const PROVIDER_CLIENT_DEFINITIONS_UNORDERED: readonly ProviderClientDefinition[] = [
  {
    value: ProviderDriverKind.make("pi"),
    label: "Pi",
    icon: PiIcon,
    settingsSchema: PiSettings,
    supportsCustomModels: false,
  },
  {
    value: ProviderDriverKind.make("omp"),
    label: "Oh My Pi",
    icon: OhMyPiIcon,
    settingsSchema: OmpSettings,
    supportsCustomModels: false,
  },
  {
    value: ProviderDriverKind.make("scient"),
    label: "Scient",
    icon: ScientAgentIcon,
    settingsSchema: ScientAgentSettings,
    supportsCustomModels: false,
  },
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    vendorLabel: "OpenAI",
    accountLabel: "ChatGPT subscription",
    searchAliases: ["openai", "chatgpt", "gpt"],
    icon: OpenAI,
    settingsSchema: CodexSettings,
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    vendorLabel: "Anthropic",
    accountLabel: "Claude subscription",
    searchAliases: ["anthropic"],
    icon: ClaudeAI,
    settingsSchema: ClaudeSettings,
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    icon: CursorIcon,
    settingsSchema: CursorSettings,
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    vendorLabel: "xAI",
    searchAliases: ["xai"],
    icon: GrokIcon,
    settingsSchema: GrokSettings,
  },
  {
    value: ProviderDriverKind.make("droid"),
    label: "Droid",
    vendorLabel: "Factory",
    searchAliases: ["factory"],
    icon: DroidIcon,
    settingsSchema: DroidSettings,
    supportsCustomModels: false,
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    icon: OpenCodeIcon,
    settingsSchema: OpenCodeSettings,
  },
  {
    value: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    vendorLabel: "Google",
    accountLabel: "Gemini subscription",
    searchAliases: ["google", "gemini"],
    icon: AntigravityIcon,
    settingsSchema: AntigravitySettings,
    supportsCustomModels: false,
  },
];

const PROVIDER_CLIENT_DEFINITIONS = PROVIDER_CLIENT_DEFINITIONS_UNORDERED.toSorted((left, right) =>
  compareProviderDriverKinds(left.value, right.value),
);

const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/** Whether a provider search query matches its name, company, or aliases. */
export function driverOptionMatchesQuery(definition: DriverOption, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [definition.label, definition.vendorLabel ?? "", ...(definition.searchAliases ?? [])].some(
    (term) => term.toLocaleLowerCase().includes(normalized),
  );
}

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}

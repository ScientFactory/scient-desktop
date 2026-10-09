import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  DroidSettings,
  OmpSettings,
  ScientAgentSettings,
  compareProviderDriverKinds,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import type { ProviderClientDefinition as CoreProviderClientDefinition } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import type * as Schema from "effect/Schema";

import {
  ACPRegistryIcon,
  AntigravityIcon,
  ClaudeAI,
  DroidIcon,
  type Icon,
  OpenAI,
  OhMyPiIcon,
  ScientAgentIcon,
} from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/** One dedicated credential row rendered inside the instance's environment section. */
export interface ProviderEnvironmentFieldDefinition {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly sensitive?: boolean;
}

/** React-facing metadata retained for Scient onboarding and provider settings. */
export interface DriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  /** The schema and generic fields owned by the provider package. */
  readonly clientDefinition: CoreProviderClientDefinition;
  readonly settingsSchema: ProviderSettingsSchema;
  readonly supportsCustomModels?: boolean;
  readonly environmentFields?: readonly ProviderEnvironmentFieldDefinition[];
  readonly hasDefaultInstance?: boolean;
  readonly badgeLabel?: string;
  readonly vendorLabel?: string;
  readonly accountLabel?: string;
  readonly searchAliases?: ReadonlyArray<string>;
}

/**
 * The browser-safe provider packages own their schemas and plain-data icons.
 * These local entries retain Scient providers that upstream does not ship.
 */
const localProviderClients: ReadonlyArray<CoreProviderClientDefinition> = [
  {
    driverKind: ProviderDriverKind.make("droid"),
    label: "Droid",
    settingsSchema: DroidSettings,
  },
  {
    driverKind: ProviderDriverKind.make("omp"),
    label: "Oh My Pi",
    settingsSchema: OmpSettings,
  },
  {
    driverKind: ProviderDriverKind.make("scient"),
    label: "Scient",
    settingsSchema: ScientAgentSettings,
  },
];

/** The provider client definitions this web build supports. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
  ...localProviderClients,
]);

const metadataByDriver: Readonly<
  Record<
    string,
    Omit<Partial<DriverOption>, "value" | "label" | "clientDefinition" | "settingsSchema" | "icon">
  >
> = {
  codex: {
    vendorLabel: "OpenAI",
    accountLabel: "ChatGPT subscription",
    searchAliases: ["openai", "chatgpt", "gpt"],
  },
  claudeAgent: {
    vendorLabel: "Anthropic",
    accountLabel: "Claude subscription",
    searchAliases: ["anthropic"],
  },
  grok: { vendorLabel: "xAI", searchAliases: ["xai"] },
  droid: { vendorLabel: "Factory", searchAliases: ["factory"], supportsCustomModels: false },
  antigravity: {
    vendorLabel: "Google",
    accountLabel: "Gemini subscription",
    searchAliases: ["google", "gemini"],
    supportsCustomModels: false,
  },
  pi: { supportsCustomModels: false },
  omp: { supportsCustomModels: false },
  scient: { supportsCustomModels: false },
  acpRegistry: { hasDefaultInstance: false, supportsCustomModels: false },
  muse: { badgeLabel: "Beta" },
};

const providerOptionsUnordered: readonly DriverOption[] = providerClients.definitions.map(
  (definition) => {
    const metadata = metadataByDriver[String(definition.driverKind)];
    const icon =
      PROVIDER_ICON_BY_PROVIDER[definition.driverKind] ??
      (definition.driverKind === "acpRegistry" ? ACPRegistryIcon : undefined);
    if (!icon) {
      throw new Error(`Provider '${definition.driverKind}' has no client icon.`);
    }
    return {
      value: definition.driverKind,
      label: definition.label,
      icon,
      clientDefinition: definition,
      settingsSchema: definition.settingsSchema,
      ...(definition.environmentFields ? { environmentFields: definition.environmentFields } : {}),
      ...(definition.hasDefaultInstance === undefined
        ? {}
        : { hasDefaultInstance: definition.hasDefaultInstance }),
      ...(definition.badgeLabel === undefined ? {} : { badgeLabel: definition.badgeLabel }),
      ...metadata,
    };
  },
);

const PROVIDER_CLIENT_DEFINITIONS = providerOptionsUnordered.toSorted((left, right) =>
  compareProviderDriverKinds(left.value, right.value),
);

const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<Record<ProviderDriverKind, DriverOption>> =
  Object.fromEntries(
    PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
  );

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;

/** Whether a provider search query matches its name, company, or aliases. */
export function driverOptionMatchesQuery(definition: DriverOption, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [definition.label, definition.vendorLabel ?? "", ...(definition.searchAliases ?? [])].some(
    (term) => term.toLocaleLowerCase().includes(normalized),
  );
}

/** Look up the presentation metadata for a driver's settings or onboarding row. */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}

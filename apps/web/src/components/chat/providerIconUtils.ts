import { createElement, type SVGProps } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";
import { providerClients, resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { ProviderPackageIcon } from "./ProviderPackageIcon";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  DroidIcon,
  PiIcon,
  OhMyPiIcon,
  ScientAgentIcon,
  OpenAI,
} from "../Icons";
import type { Icon } from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

function iconFromPackage(driverKind: ProviderDriverKind): Icon {
  const icon = providerClients.get(driverKind)?.icon;
  return (props: SVGProps<SVGSVGElement>) =>
    icon ? createElement(ProviderPackageIcon, { icon, ...props }) : null;
}

const GrokPackageIcon = iconFromPackage(ProviderDriverKind.make("grok"));
const MusePackageIcon = iconFromPackage(ProviderDriverKind.make("muse"));
const OpenCodePackageIcon = iconFromPackage(ProviderDriverKind.make("opencode"));

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodePackageIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokPackageIcon,
  [ProviderDriverKind.make("muse")]: MusePackageIcon,
  [ProviderDriverKind.make("droid")]: DroidIcon,
  [ProviderDriverKind.make("pi")]: PiIcon,
  [ProviderDriverKind.make("omp")]: OhMyPiIcon,
  [ProviderDriverKind.make("scient")]: ScientAgentIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  /** Provider-reported compact cost label (e.g. `"0.5×"`); absent when unknown. */
  providerCostLabel?: string | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getProviderRowLabel(
  providerDisplayName: string,
  subProvider: string | undefined,
): string {
  const provider = providerDisplayName.trim();
  const sub = subProvider?.trim();
  if (!sub) {
    return providerDisplayName;
  }
  if (provider && new RegExp(`^${escapeRegExp(provider)}\\s+\\S`, "i").test(sub)) {
    return sub;
  }
  return `${providerDisplayName} · ${sub}`;
}

export function getTriggerDisplayModelName(
  model: ModelEsque,
  driverKind: ProviderDriverKind | null | undefined,
): string {
  const shortName = resolveModelShortName(model, driverKind);
  return getDisplayModelName({ ...model, shortName }, { preferShortName: true });
}

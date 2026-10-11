import { createElement, type SVGProps } from "react";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderIcon } from "@t3tools/provider-core/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
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

function iconFromPackage(icon: ProviderIcon): Icon {
  return (props: SVGProps<SVGSVGElement>) => createElement(ProviderPackageIcon, { icon, ...props });
}

const GrokPackageIcon = iconFromPackage(grokClient.icon);
const MusePackageIcon = iconFromPackage(museClient.icon);
const OpenCodePackageIcon = iconFromPackage(openCodeClient.icon);

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

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}

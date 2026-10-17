import {
  buildNewThreadLink,
  parseNewThreadLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
  type PromptLinkRepository,
} from "./promptLinks.ts";
import { SCIENT_DESKTOP_IDENTITY } from "./scientDesktopIdentity.ts";

const APP_PROTOCOLS = [
  `${SCIENT_DESKTOP_IDENTITY.productionScheme}:`,
  `${SCIENT_DESKTOP_IDENTITY.developmentScheme}:`,
];

/** Keep draft text in the installed app's link; Scient has no published hosted prompt service. */
export function buildScientNewThreadLink(input: {
  readonly prompt: string;
  readonly repository?: PromptLinkRepository | null;
  readonly provider?: string | null;
  readonly model?: string | null;
}): string {
  const url = new URL(buildNewThreadLink({ ...input, origin: "https://app.invalid" }));
  return scientPromptLinkDeepLink(`${url.pathname}${url.search}`);
}

/** A web origin is accepted only when the owning surface supplies its actual origin. */
export function scientPromptLinkAppPath(value: string, hostedAppUrl = ""): string | null {
  return promptLinkAppPath(value, hostedAppUrl, APP_PROTOCOLS);
}

export function scientPromptLinkDeepLink(appPath: string): string {
  return promptLinkDeepLink(appPath, SCIENT_DESKTOP_IDENTITY.productionScheme);
}

export const parseScientNewThreadLink = (search: string) =>
  parseNewThreadLink(search, SCIENT_DESKTOP_IDENTITY.baseName);
export const parseScientThreadLinkPrompt = (search: string) =>
  parseThreadLinkPrompt(search, SCIENT_DESKTOP_IDENTITY.baseName);

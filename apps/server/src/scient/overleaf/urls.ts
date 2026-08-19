import { ScientOverleafOperationError } from "@t3tools/contracts";

const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) <= 0x1f);

export interface ParsedOverleafProject {
  readonly host: string;
  readonly projectId: string;
  readonly projectUrl: string;
  readonly gitUrl: string;
  readonly kind: "cloud" | "server-pro";
}

function invalid(message: string): never {
  throw new ScientOverleafOperationError({
    code: "invalid_request",
    message,
    retryable: false,
  });
}

function extractUrl(input: string): string {
  const trimmed = input.trim();
  if (!/^git\s+clone(?:\s|$)/iu.test(trimmed)) return trimmed;
  const matches = [...trimmed.matchAll(/https:\/\/[^\s"']+/giu)];
  if (matches.length !== 1) invalid("Paste a clone command containing exactly one HTTPS URL.");
  const before = trimmed.slice(0, matches[0]!.index).trim();
  if (!/^git\s+clone$/iu.test(before)) {
    invalid("Clone options and embedded shell syntax are not supported.");
  }
  const after = trimmed.slice((matches[0]!.index ?? 0) + matches[0]![0].length).trim();
  if (after.length > 0 && !/^[A-Za-z0-9._/-]+$/u.test(after)) {
    invalid("Clone options and shell syntax are not supported.");
  }
  return matches[0]![0];
}

export function parseOverleafProjectInput(input: string): ParsedOverleafProject {
  const raw = extractUrl(input);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("Enter an Overleaf project URL or HTTPS Git URL.");
  }
  if (url.protocol !== "https:") invalid("Overleaf synchronization requires HTTPS.");
  if (url.password || (url.username && url.username !== "git"))
    invalid("Embedded credentials are not accepted.");
  if (url.search || url.hash) invalid("Query strings and fragments are not accepted.");
  const host = url.hostname.toLowerCase();
  const cloudGit = host === "git.overleaf.com";
  const match = url.pathname.match(
    cloudGit ? /^\/(?:git\/)?([A-Za-z0-9_-]+)\/?$/u : /^\/(?:project|git)\/([A-Za-z0-9_-]+)\/?$/u,
  );
  if (!match) invalid("The URL is not a supported Overleaf project or Git URL.");
  const projectId = match[1]!;
  const kind = host === "www.overleaf.com" || host === "git.overleaf.com" ? "cloud" : "server-pro";
  const projectHost = kind === "cloud" ? "www.overleaf.com" : url.host;
  const gitHost = kind === "cloud" ? "git.overleaf.com" : url.host;
  return {
    host: gitHost.toLowerCase(),
    projectId,
    projectUrl: `https://${projectHost}/project/${projectId}`,
    gitUrl:
      kind === "cloud"
        ? `https://git@${gitHost}/${projectId}`
        : `https://git@${gitHost}/git/${projectId}`,
    kind,
  };
}

export function normalizeRelativeFolder(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (normalized === "." || normalized === "") return "";
  const parts = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.length > 4_096 ||
    parts.some((part) => part.length === 0 || part === ".." || part === "." || part === ".git")
  ) {
    invalid("The selected folder must stay inside the workspace and cannot contain .git.");
  }
  for (const part of parts) {
    if (/^[ .]|[ .]$/u.test(part) || /[<>:"|?*]/u.test(part) || hasControlCharacter(part))
      invalid("The selected folder contains a name that is invalid on a supported platform.");
    const stem = part.split(".")[0]!.toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem))
      invalid("The selected folder contains a Windows-reserved name.");
  }
  return normalized;
}

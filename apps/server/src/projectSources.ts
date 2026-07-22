import fs from "node:fs/promises";
import path from "node:path";

import type {
  CloneProjectSourceInput,
  CloneProjectSourceResult,
  RepositoryProvider,
  RepositorySourceStatus,
  RepositorySourceStatusesResult,
} from "@synara/contracts";

import { runProcess } from "./processRunner";

const SOURCE_PROBE_TIMEOUT_MS = 10_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const CLONE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
};

function setupMessage(provider: RepositoryProvider): string {
  return provider === "github"
    ? "Install GitHub CLI and sign in with `gh auth login`."
    : "Install GitLab CLI and sign in with `glab auth login`.";
}

async function probeRepositoryProvider(
  provider: RepositoryProvider,
): Promise<RepositorySourceStatus> {
  const command = provider === "github" ? "gh" : "glab";
  const args =
    provider === "github" ? ["auth", "status", "--hostname", "github.com"] : ["auth", "status"];
  try {
    await runProcess(command, args, {
      env: CLONE_ENV,
      timeoutMs: SOURCE_PROBE_TIMEOUT_MS,
      maxBufferBytes: 256 * 1024,
    });
    return {
      provider,
      status: "available",
      message: provider === "github" ? "GitHub CLI is ready." : "GitLab CLI is ready.",
    };
  } catch {
    return { provider, status: "setup-required", message: setupMessage(provider) };
  }
}

export async function getRepositorySourceStatuses(): Promise<RepositorySourceStatusesResult> {
  const sources = await Promise.all([
    probeRepositoryProvider("github"),
    probeRepositoryProvider("gitlab"),
  ]);
  return { sources };
}

function stripRepositorySuffix(value: string): string {
  return value.replace(/\/+$/, "").replace(/\.git$/i, "");
}

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || character.trim().length === 0;
  });
}

export function normalizeRepositoryReference(
  provider: RepositoryProvider,
  rawValue: string,
): string {
  const value = rawValue.trim();
  if (!value || hasWhitespaceOrControl(value) || value.startsWith("-")) {
    throw new Error("Enter a repository as owner/name or group/project.");
  }

  let reference = value;
  const scpMatch = /^git@([^:]+):(.+)$/.exec(value);
  if (scpMatch) {
    const expectedHost = provider === "github" ? "github.com" : "gitlab.com";
    if (scpMatch[1]?.toLowerCase() !== expectedHost) {
      throw new Error(`Enter a ${provider === "github" ? "GitHub" : "GitLab"} repository.`);
    }
    reference = scpMatch[2] ?? "";
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Enter a valid repository URL or repository name.");
    }
    const expectedHost = provider === "github" ? "github.com" : "gitlab.com";
    if (parsed.hostname.toLowerCase() !== expectedHost || parsed.username || parsed.password) {
      throw new Error(`Enter a ${provider === "github" ? "GitHub" : "GitLab"} repository.`);
    }
    reference = parsed.pathname;
  }

  const normalized = stripRepositorySuffix(reference).replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  const hasValidSegments = segments.every(
    (segment) => segment !== "." && segment !== ".." && /^[A-Za-z0-9_.-]+$/.test(segment),
  );
  const hasValidDepth = provider === "github" ? segments.length === 2 : segments.length >= 2;
  if (!hasValidSegments || !hasValidDepth) {
    throw new Error(
      provider === "github"
        ? "Enter a GitHub repository as owner/name."
        : "Enter a GitLab repository as group/project.",
    );
  }
  return segments.join("/");
}

export function validateGitRemoteUrl(rawValue: string): string {
  const value = rawValue.trim();
  if (!value || hasWhitespaceOrControl(value) || value.startsWith("-")) {
    throw new Error("Enter a valid Git remote URL.");
  }
  if (/^[^/@:]+@[^/:]+:.+/.test(value)) {
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Use an HTTPS, SSH, or Git remote URL.");
  }
  if (!new Set(["https:", "http:", "ssh:", "git:"]).has(parsed.protocol)) {
    throw new Error("Use an HTTPS, SSH, or Git remote URL.");
  }
  const hasEmbeddedHttpCredentials =
    (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.username);
  if (!parsed.hostname || hasEmbeddedHttpCredentials || parsed.password) {
    throw new Error("Remote URLs with embedded credentials are not supported.");
  }
  return value;
}

export function resolveCloneDestination(rawValue: string, homeDir: string): string {
  const value = rawValue.trim();
  const expanded =
    value === "~"
      ? homeDir
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(homeDir, value.slice(2))
        : value;
  if (!path.isAbsolute(expanded)) {
    throw new Error("Choose an absolute destination path or start it with ~/.");
  }
  const resolved = path.resolve(expanded);
  if (resolved === path.parse(resolved).root) {
    throw new Error("The filesystem root cannot be used as a clone destination.");
  }
  return resolved;
}

function cloneCommand(input: CloneProjectSourceInput): {
  command: string;
  args: string[];
} {
  if (input.source === "git-url") {
    if (!input.remoteUrl) {
      throw new Error("Enter a Git remote URL.");
    }
    return {
      command: "git",
      args: ["clone", validateGitRemoteUrl(input.remoteUrl), "."],
    };
  }
  if (!input.repository) {
    throw new Error("Enter a repository as owner/name or group/project.");
  }
  const repository = normalizeRepositoryReference(input.source, input.repository);
  return {
    command: input.source === "github" ? "gh" : "glab",
    args: ["repo", "clone", repository, "."],
  };
}

export async function cloneProjectSource(
  input: CloneProjectSourceInput,
  homeDir: string,
): Promise<CloneProjectSourceResult> {
  // Validate the source before touching the filesystem. Invalid input must not leave
  // behind an empty destination that looks like a failed or partial clone.
  const command = cloneCommand(input);
  const requestedDestinationPath = resolveCloneDestination(input.destinationPath, homeDir);
  const parentPath = path.dirname(requestedDestinationPath);
  const canonicalParentPath = await fs.realpath(parentPath).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The clone destination parent folder does not exist.", { cause });
    }
    throw new Error("Unable to inspect the clone destination parent folder.", { cause });
  });
  const parent = await fs.stat(canonicalParentPath).catch((cause) => {
    throw new Error("Unable to inspect the clone destination parent folder.", { cause });
  });
  if (!parent.isDirectory()) {
    throw new Error("The clone destination parent is not a folder.");
  }
  const destinationPath = path.join(canonicalParentPath, path.basename(requestedDestinationPath));
  try {
    // Reserve the exact target atomically. Every clone runs inside this empty directory,
    // so failure cleanup can never delete a folder that existed before this request.
    await fs.mkdir(destinationPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("The clone destination already exists. Choose a new folder.", { cause });
    }
    throw new Error("Unable to create the clone destination.", { cause });
  }

  try {
    await runProcess(command.command, command.args, {
      cwd: destinationPath,
      env: CLONE_ENV,
      timeoutMs: CLONE_TIMEOUT_MS,
      maxBufferBytes: 2 * 1024 * 1024,
    });
    const canonicalPath = await fs.realpath(destinationPath);
    return { path: canonicalPath };
  } catch (cause) {
    await fs.rm(destinationPath, { recursive: true, force: true }).catch(() => undefined);
    const detail =
      cause instanceof Error && cause.name === "AbortError" ? "Clone cancelled." : null;
    throw new Error(detail ?? "Unable to clone the repository. Check access and try again.", {
      cause,
    });
  }
}

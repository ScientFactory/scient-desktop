const OMP_SESSION_MUTATOR_COMMANDS = [
  "new",
  "fresh",
  "clear",
  "delete",
  "resume",
  "fork",
  "tree",
  "branch",
  "handoff",
  "pin",
  "login",
  "logout",
  "restart",
  "export",
  "dump",
  "share",
  "model",
  "provider",
  "thinking",
  "fast",
  "tools",
  "config",
  "settings",
  "permissions",
  "approval",
] as const;

/**
 * Only commands whose effects are understood by this provider are eligible.
 * Discovery is not permission: an extension, skill, or user command is not
 * trusted merely because OMP reports it.
 */
const OMP_QUALIFIED_COMMANDS = ["help", "status", "compact"] as const;

const mutators = new Set<string>(OMP_SESSION_MUTATOR_COMMANDS);
const qualified = new Set<string>(OMP_QUALIFIED_COMMANDS);

export interface OmpCatalogCommand {
  readonly name: string;
  readonly source?: string | undefined;
  readonly description?: string | undefined;
  readonly aliases?: ReadonlyArray<string> | undefined;
}

export interface OmpCommandCatalog {
  readonly advertised: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  readonly allowed: ReadonlySet<string>;
  readonly known: ReadonlySet<string>;
}

export const emptyOmpCommandCatalog = (): OmpCommandCatalog => ({
  advertised: [],
  allowed: new Set(),
  known: new Set(),
});

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Advertise only the qualified command set. Aliases are included only when
 * their canonical command is qualified; an alias can never bypass a blocked
 * canonical command.
 */
export const compileOmpCommandCatalog = (
  commands: ReadonlyArray<OmpCatalogCommand>,
): OmpCommandCatalog => {
  const allowed = new Set<string>();
  const known = new Set<string>();
  const advertised: Array<{ name: string; description?: string }> = [];
  for (const command of commands) {
    const name = clean(command.name);
    if (!name) continue;
    known.add(name);
    for (const alias of command.aliases ?? []) {
      const trimmed = clean(alias);
      if (trimmed) known.add(trimmed);
    }
    if (
      !qualified.has(name) ||
      mutators.has(name) ||
      name === "session" ||
      command.source !== "builtin"
    ) {
      continue;
    }
    allowed.add(name);
    for (const alias of command.aliases ?? []) {
      const trimmed = clean(alias);
      if (trimmed && !mutators.has(trimmed) && !qualified.has(trimmed)) {
        allowed.add(trimmed);
      }
    }
    const description = clean(command.description);
    advertised.push(description ? { name, description } : { name });
  }
  return { advertised, allowed, known };
};

interface OmpSlashInvocation {
  /** The builtin name: up to the first whitespace or ":" (OMP `parseSlashCommand`). */
  readonly builtin: string;
  /** The builtin's arguments after that separator. */
  readonly args: string;
  /** The extension and custom command name: up to the first space. */
  readonly extension: string;
}

/**
 * OMP builtins split slash commands at whitespace or colon, while extensions/custom commands split
 * only at space. Check every resolved name so neither parser can hide a disallowed command.
 */
const parseOmpSlashInvocation = (input: string): OmpSlashInvocation | undefined => {
  if (!input.startsWith("/")) return undefined;
  const body = input.slice(1);
  const separator = body.search(/[\s:]/u);
  const space = body.indexOf(" ");
  return {
    builtin: separator === -1 ? body : body.slice(0, separator),
    args: separator === -1 ? "" : body.slice(separator + 1).trim(),
    extension: space === -1 ? body : body.slice(0, space),
  };
};

export type OmpCommandDecision = "not-a-command" | "allowed" | "mutator" | "unavailable";

export const ompCommandDecision = (
  input: string,
  catalog: OmpCommandCatalog,
): OmpCommandDecision => {
  const invocation = parseOmpSlashInvocation(input);
  if (!invocation) return "not-a-command";
  const { builtin, args, extension } = invocation;
  // "/" followed by whitespace names nothing; OMP sends it as text.
  if (!builtin && !extension.trim()) return "not-a-command";
  if (mutators.has(builtin) || mutators.has(extension)) return "mutator";
  if (builtin === "session") {
    if (!catalog.known.has("session")) return "unavailable";
    return args === "info" || /^info\s/u.test(args) ? "allowed" : "mutator";
  }
  for (const name of [builtin, extension]) {
    if (catalog.known.has(name) && !catalog.allowed.has(name)) return "mutator";
  }
  if (catalog.allowed.has(builtin)) return "allowed";
  // No command name contains "/", so a first word like /Users/alice/notes.md
  // is a pasted path and reaches OMP as text, even when discovery failed.
  if (builtin.includes("/")) return "not-a-command";
  // Forward unknown slash text only after successful discovery. Failed discovery leaves an empty
  // fail-closed catalog because unseen extensions/skills cannot be forwarded safely.
  if (catalog.known.size === 0) return "unavailable";
  return "not-a-command";
};

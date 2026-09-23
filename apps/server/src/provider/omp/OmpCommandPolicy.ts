export const OMP_SESSION_MUTATOR_COMMANDS = [
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
] as const;

const mutators = new Set<string>(OMP_SESSION_MUTATOR_COMMANDS);

export interface OmpCatalogCommand {
  readonly name: string;
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
 * Advertise every discovered command except ones that replace, delete, fork,
 * or authenticate the Oh My Pi session. `/session info` stays available.
 * Other `/session` forms are rejected at send time.
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
    if (mutators.has(name) || name === "session") continue;
    allowed.add(name);
    for (const alias of command.aliases ?? []) {
      const trimmed = clean(alias);
      if (trimmed && !mutators.has(trimmed)) allowed.add(trimmed);
    }
    const description = clean(command.description);
    advertised.push(description ? { name, description } : { name });
  }
  return { advertised, allowed, known };
};

export const ompSlashCommandName = (input: string): string | undefined => {
  if (!input.startsWith("/")) return undefined;
  return clean(input.slice(1).split(" ", 1)[0]);
};

export type OmpCommandDecision = "not-a-command" | "allowed" | "mutator" | "unavailable";

export const ompCommandDecision = (
  input: string,
  catalog: OmpCommandCatalog,
): OmpCommandDecision => {
  const name = ompSlashCommandName(input);
  if (!name) return "not-a-command";
  if (name === "session") {
    if (!catalog.known.has("session")) return "unavailable";
    const rest = input.slice("/session".length).trim();
    return rest === "info" || rest.startsWith("info ") ? "allowed" : "mutator";
  }
  if (mutators.has(name)) return "mutator";
  if (catalog.allowed.has(name)) return "allowed";
  if (catalog.known.has(name)) return "mutator";
  return "unavailable";
};

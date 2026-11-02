// @effect-diagnostics nodeBuiltinImport:off -- Effect's symlink cannot request a Windows junction, which needs no privilege.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

/**
 * Scient keeps conversations in its own state folder and passes `--session-dir`,
 * but the agent's stats dashboard reads `<root>/agent/sessions`. A link lets the
 * dashboard count them. A junction needs no privilege on Windows; other systems
 * ignore the type. Without the link the dashboard is empty and nothing else changes.
 */
export const linkScientAgentSessions = (input: {
  readonly agentRoot: string;
  readonly sessionsRoot: string;
}): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const link = NodePath.join(input.agentRoot, "agent", "sessions");
    await NodeFSP.mkdir(NodePath.dirname(link), { recursive: true, mode: 0o700 });
    await NodeFSP.symlink(input.sessionsRoot, link, "junction");
  }).pipe(Effect.ignore);

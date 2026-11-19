// @effect-diagnostics nodeBuiltinImport:off -- Effect's symlink cannot request a Windows junction, which needs no privilege.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

/**
 * The agent's dashboard reads `<root>/agent/sessions`; Scient keeps conversations elsewhere, so a
 * link (a junction on Windows, which needs no privilege) lets the dashboard count them. Returns the
 * link when it leads to `sessionsRoot`, since the dashboard accepts files only through it.
 */
export const linkScientAgentSessions = (input: {
  readonly agentRoot: string;
  readonly sessionsRoot: string;
}): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    try {
      const link = NodePath.join(input.agentRoot, "agent", "sessions");
      await NodeFSP.mkdir(NodePath.dirname(link), { recursive: true, mode: 0o700 });
      await NodeFSP.symlink(input.sessionsRoot, link, "junction").catch(() => undefined);
      const [reached, sessions] = await Promise.all([
        NodeFSP.realpath(link),
        NodeFSP.realpath(input.sessionsRoot),
      ]);
      return reached === sessions ? link : undefined;
    } catch {
      return undefined;
    }
  });

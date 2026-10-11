import type { ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

interface AvailableCommand {
  readonly name: string;
  readonly description?: string;
  readonly input?: { readonly type?: string; readonly hint?: string | undefined };
}

/** Session command catalogs stay scoped to their workspace across health refreshes. */
export const makeCursorCommandCatalog = Effect.fn("makeCursorCommandCatalog")(function* (
  provider: ManagedServerProvider,
) {
  const workspaces = yield* SubscriptionRef.make<NonNullable<ServerProvider["workspaceSnapshots"]>>(
    [],
  );
  const getSnapshot = Effect.all([provider.getSnapshot, SubscriptionRef.get(workspaces)]).pipe(
    Effect.map(([snapshot, workspaceSnapshots]) =>
      workspaceSnapshots.length > 0 ? { ...snapshot, workspaceSnapshots } : snapshot,
    ),
  );
  const snapshotForCwd = Effect.fn("CursorCommandCatalog.snapshotForCwd")(function* (
    cwd: string,
    skills: ServerProvider["skills"],
  ) {
    const machineSnapshot = yield* provider.getSnapshot;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) =>
      [
        ...entries.filter((entry) => entry.cwd !== cwd),
        {
          cwd,
          checkedAt,
          slashCommands:
            entries.find((entry) => entry.cwd === cwd)?.slashCommands ??
            machineSnapshot.slashCommands,
          skills,
        },
      ].slice(-16),
    );
    const snapshot = yield* getSnapshot;
    return {
      ...snapshot,
      checkedAt,
      slashCommands:
        snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.slashCommands ??
        snapshot.slashCommands,
      skills,
    };
  });
  const onAvailableCommands = Effect.fn("CursorCommandCatalog.onAvailableCommands")(function* (
    commands: ReadonlyArray<AvailableCommand>,
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    const seen = new Set([COMPACT_SLASH_COMMAND.name]);
    const slashCommands = [
      COMPACT_SLASH_COMMAND,
      ...commands.flatMap((command) => {
        const name = command.name.trim();
        if (!name || seen.has(name)) return [];
        seen.add(name);
        const description = command.description?.trim();
        const hint = command.input?.hint?.trim();
        return [
          {
            name,
            ...(description ? { description } : {}),
            ...(hint ? { input: { hint } } : {}),
          },
        ];
      }),
    ];
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(workspaces, (entries) => {
      const previous = entries.find((entry) => entry.cwd === cwd);
      const currentSkills = skills ?? previous?.skills;
      if (currentSkills === undefined) return entries;
      return [
        ...entries.filter((entry) => entry.cwd !== cwd),
        { cwd, checkedAt, slashCommands, skills: currentSkills },
      ].slice(-16);
    });
  });
  return {
    onAvailableCommands,
    snapshotForCwd,
    snapshot: {
      ...provider,
      getSnapshot,
      refresh: provider.refresh.pipe(Effect.andThen(getSnapshot)),
      streamChanges: Stream.merge(
        provider.streamChanges.pipe(Stream.map(() => undefined)),
        SubscriptionRef.changes(workspaces).pipe(Stream.map(() => undefined)),
      ).pipe(Stream.mapEffect(() => getSnapshot)),
    } satisfies ManagedServerProvider,
  };
});

import type { RoomPerson } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { roomPersonClass } from "./RoomMessageRow";

const FACES_SHOWN = 3;

const initialsOf = (name: string) =>
  name
    .split(/\s+/u)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/**
 * The people in a shared thread, one small face each in their message colour; faded while away.
 * Decorative: the control or row around it names them.
 */
export function RoomFaces({
  people,
  online,
  size = "md",
}: {
  readonly people: ReadonlyArray<RoomPerson>;
  /** Who is here now; without it, nobody is shown as away. */
  readonly online?: ReadonlySet<string>;
  readonly size?: "sm" | "md";
}) {
  if (people.length === 0) return null;
  const face = cn(
    "flex items-center justify-center rounded-full font-medium",
    size === "sm"
      ? "size-4 border border-background text-[7px]"
      : "size-5 border-2 border-background text-[9px]",
  );
  return (
    <span aria-hidden className="flex shrink-0 -space-x-1">
      {people.slice(0, FACES_SHOWN).map((person) => (
        <span
          key={person.id}
          className={cn(
            face,
            "bg-guest-surface text-guest-foreground",
            roomPersonClass(person.id),
            online !== undefined && !online.has(person.id) && "opacity-45",
          )}
        >
          {initialsOf(person.name)}
        </span>
      ))}
      {people.length > FACES_SHOWN ? (
        <span className={cn(face, "bg-muted text-muted-foreground")}>
          +{people.length - FACES_SHOWN}
        </span>
      ) : null}
    </span>
  );
}

import type { ImportableSkill, PersonalSkillCandidate } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";

const displayName = (name: string) =>
  name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** Can be added as is: ready, and no skill built into Scient or a plugin has its name. */
export const canAddCandidate = (candidate: PersonalSkillCandidate) =>
  candidate.status === "ready" && candidate.conflict === undefined;

/**
 * Skills found in what the user gave: ready ones are added in one click (Replace when one of
 * theirs has the name), and rough material goes to an agent to finish.
 */
export function SkillCandidateRows({
  candidates,
  busy,
  onAdd,
  onFinish,
}: {
  readonly candidates: ReadonlyArray<PersonalSkillCandidate>;
  readonly busy: string | null;
  readonly onAdd: (candidate: PersonalSkillCandidate) => void;
  /** Absent when this connection cannot start chats. */
  readonly onFinish: ((candidate: PersonalSkillCandidate) => void) | undefined;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {candidates.map((candidate) => {
        const title = candidate.name ? displayName(candidate.name) : "Untitled notes";
        return (
          <li key={candidate.key} className="flex items-start gap-3 px-3 py-2">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <p className="truncate text-sm font-medium">{title}</p>
              {candidate.status === "ready" ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {candidate.description}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Not a complete skill yet. {candidate.reason}
                </p>
              )}
              {candidate.notes.map((note) => (
                <p key={note} className="text-xs text-muted-foreground">
                  {note}
                </p>
              ))}
              {candidate.conflict ? (
                <p className="text-xs text-destructive-foreground">
                  {candidate.conflict} Rename it, or finish it with an agent under another name.
                </p>
              ) : null}
            </div>
            {canAddCandidate(candidate) ? (
              <Button
                size="xs"
                variant="outline"
                aria-label={`${candidate.exists ? "Replace" : "Add"} ${title}`}
                disabled={busy !== null}
                onClick={() => onAdd(candidate)}
              >
                {busy === candidate.key ? "Adding…" : candidate.exists ? "Replace" : "Add"}
              </Button>
            ) : onFinish ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => onFinish(candidate)}
              >
                Finish with an agent
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Skills the user's other agents have; one click copies one into Scient. */
export function ImportableSkillRows({
  skills,
  busy,
  onAdd,
}: {
  readonly skills: ReadonlyArray<ImportableSkill>;
  readonly busy: string | null;
  readonly onAdd: (skill: ImportableSkill) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {skills.map((skill) => {
        const key = `${skill.app}:${skill.folder}`;
        return (
          <li key={key} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{displayName(skill.name)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {skill.appLabel}
                {skill.description ? ` · ${skill.description}` : ""}
              </p>
            </div>
            {skill.added ? (
              <span className="text-xs text-muted-foreground">Added</span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                aria-label={`Add ${skill.name} from ${skill.appLabel}`}
                disabled={busy !== null}
                onClick={() => onAdd(skill)}
              >
                {busy === key ? "Adding…" : "Add"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

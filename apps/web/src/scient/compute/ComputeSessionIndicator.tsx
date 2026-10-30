import {
  TERMINAL_COMPUTE_SESSION_STATUSES,
  type ComputeSessionRecord,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ChevronDown, LoaderCircle } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatDateTimeTimestamp } from "~/timestampFormat";

import { computeSessionOwnerLabel } from "./computeContextStore";
import { computeRuntimeVersionLabel } from "./computeFileSurfaceModel";

function busy(session: ComputeSessionRecord): boolean {
  return (
    !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status) &&
    (session.status !== "ready" || session.activity === "busy")
  );
}

/** "Python 3.14" with a spinner while busy; the session switcher when there is more than one. */
export function ComputeSessionIndicator(props: {
  readonly sessions: ReadonlyArray<ComputeSessionRecord>;
  readonly selected: ComputeSessionRecord;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly onChoose: (sessionId: string) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { selected } = props;
  const content = (
    <>
      {busy(selected) ? <LoaderCircle className="animate-spin" aria-label="Busy" /> : null}
      <span
        className={cn(
          "truncate font-normal",
          TERMINAL_COMPUTE_SESSION_STATUSES.has(selected.status) && "text-muted-foreground/70",
        )}
      >
        {computeRuntimeVersionLabel(selected.label, selected.runtime?.languageVersion)}
      </span>
    </>
  );
  if (props.sessions.length < 2) {
    return (
      <span className="flex min-w-0 items-center gap-1 px-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {content}
      </span>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost-muted" className="min-w-0" aria-label="Choose session" />
        }
      >
        {content}
        <ChevronDown className="size-3.5 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="max-h-72 min-w-56 overflow-y-auto">
        <MenuRadioGroup value={selected.sessionId} onValueChange={props.onChoose}>
          {props.sessions.map((session) => (
            <MenuRadioItem key={session.sessionId} value={session.sessionId} size="compact">
              {computeSessionOwnerLabel(session, props.environmentId, props.cwd)} ·{" "}
              {formatDateTimeTimestamp(session.createdAt, timestampFormat)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

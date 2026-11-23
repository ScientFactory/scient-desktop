// The Voice settings card for dictation with ChatGPT, beside this computer's Whisper models.
import { Link } from "@tanstack/react-router";
import { T } from "gt-react";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

export function ChatGptDictationCard({
  selected,
  signedIn,
  offeredOnFirstUse,
  onSelect,
}: {
  readonly selected: boolean;
  /** Whether a Scient Agent or Codex here is signed in to ChatGPT. */
  readonly signedIn: boolean;
  /** No engine is chosen yet, so the microphone offers ChatGPT first the next time it is used. */
  readonly offeredOnFirstUse: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 p-4">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-sm">ChatGPT</h3>
          {selected ? (
            <Badge variant="success" size="sm">
              <CheckIcon /> <T context="this dictation engine is the one in use">In use</T>
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          <T>
            Accurate in many languages, with nothing to download. Uses your ChatGPT sign-in in
            Scient Agent or Codex.
          </T>
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {signedIn ? (
          <>
            {!selected ? (
              <Button size="xs" onClick={onSelect}>
                <T>Use ChatGPT</T>
              </Button>
            ) : null}
            {offeredOnFirstUse ? (
              <span className="text-muted-foreground text-xs">
                <T>Offered the first time you dictate.</T>
              </span>
            ) : null}
          </>
        ) : (
          <>
            <Button size="xs" render={<Link to="/settings/providers" />}>
              <T>Sign in to ChatGPT</T>
            </Button>
            {selected ? (
              <span className="text-muted-foreground text-xs">
                <T>Dictation waits for the sign-in.</T>
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

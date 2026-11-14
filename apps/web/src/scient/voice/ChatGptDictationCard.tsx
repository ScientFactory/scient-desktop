// The Voice settings card for dictation with ChatGPT, beside this computer's Whisper models.
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";

export function ChatGptDictationCard({
  selected,
  signedIn,
  onSelect,
}: {
  readonly selected: boolean;
  /** Whether a Scient Agent on this computer is signed in to ChatGPT. */
  readonly signedIn: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <div className="rounded-xl border border-border/70 bg-card/50 p-4">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-sm">ChatGPT</h3>
          {selected ? (
            <Badge variant="success" size="sm">
              <CheckIcon /> In use
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          Accurate in many languages, with nothing to download. Uses your ChatGPT sign-in in Scient
          Agent.
        </p>
        <p className="text-muted-foreground/70 text-xs">
          Recordings go to OpenAI, which keeps them for 30 days.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {signedIn ? (
          <Button
            size="xs"
            variant={selected ? "outline" : "default"}
            disabled={selected}
            onClick={onSelect}
          >
            {selected ? "In use" : "Use ChatGPT"}
          </Button>
        ) : (
          <>
            <Button size="xs" render={<Link to="/settings/providers" />}>
              Sign in to ChatGPT
            </Button>
            {selected ? (
              <span className="text-muted-foreground text-xs">
                Dictation waits for the sign-in.
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

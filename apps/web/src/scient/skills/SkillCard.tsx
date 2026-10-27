import type { EnvironmentId } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { BookOpenIcon, EllipsisIcon, MessageCircleIcon } from "lucide-react";
import { useState } from "react";
import ChatMarkdown from "../../components/ChatMarkdown";
import { Button } from "../../components/ui/button";
import { DialogFooter } from "../../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { ExtensionContentDialog } from "../extensions/ExtensionContentDialog";

export function SkillCard({
  name,
  displayName,
  iconUrl,
  description,
  environmentId,
  instructions,
  error,
  onOpenChange,
  onTry,
}: {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly iconUrl?: string | undefined;
  readonly description: string;
  readonly environmentId: EnvironmentId;
  readonly instructions: string | null;
  readonly error?: string | null | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onTry?: (() => Promise<void>) | undefined;
}) {
  const [trying, setTrying] = useState(false);
  const [tryError, setTryError] = useState<string | null>(null);
  return (
    <ExtensionContentDialog
      name={formatProviderSkillDisplayName({ name, displayName })}
      kind="Skill"
      glyph={BookOpenIcon}
      iconUrl={iconUrl}
      description={description}
      onOpenChange={onOpenChange}
      actions={
        <Menu>
          <MenuTrigger
            render={<Button size="icon-sm" variant="ghost-muted" aria-label={`More for ${name}`} />}
          >
            <EllipsisIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={!instructions}
              onClick={() => {
                if (instructions) void navigator.clipboard.writeText(instructions);
              }}
            >
              Copy instructions
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
      footer={
        <>
          {tryError ? (
            <p role="alert" className="px-4 text-sm text-destructive-foreground">
              {tryError}
            </p>
          ) : null}
          {onTry ? (
            <DialogFooter variant="bare" padding="compact">
              <Button
                disabled={trying}
                onClick={() => {
                  setTrying(true);
                  setTryError(null);
                  void onTry().then(
                    () => onOpenChange(false),
                    (cause: unknown) => {
                      setTrying(false);
                      setTryError(
                        cause instanceof Error ? cause.message : "Could not start a draft.",
                      );
                    },
                  );
                }}
              >
                <MessageCircleIcon aria-hidden />
                {trying ? "Opening…" : "Try now"}
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter variant="bare" padding="compact">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          )}
        </>
      }
    >
      {instructions === null ? (
        <p className="p-4 text-sm text-muted-foreground">{error ?? "Loading skill…"}</p>
      ) : (
        <ChatMarkdown
          text={instructions}
          cwd={undefined}
          environmentId={environmentId}
          contentDirection="auto"
          className="p-4"
        />
      )}
    </ExtensionContentDialog>
  );
}

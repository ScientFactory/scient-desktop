import type { EnvironmentId } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { BookOpenIcon, EllipsisIcon, MessageCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import ChatMarkdown from "../../components/ChatMarkdown";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { ExtensionIcon } from "../extensions/ExtensionRow";

export function SkillCard({
  name,
  description,
  environmentId,
  instructions,
  error,
  onOpenChange,
  onTry,
}: {
  readonly name: string;
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup
        layout="visual"
        className="max-w-3xl"
        showCloseButton={false}
        padding="none"
        gap="none"
      >
        <DialogHeader>
          <div className="flex items-start justify-between gap-4">
            <ExtensionIcon name={name} glyph={BookOpenIcon} size="large" />
            <div className="flex items-center gap-1">
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="icon-sm" variant="ghost-muted" aria-label={`More for ${name}`} />
                  }
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
              <DialogClose
                render={<Button size="icon-sm" variant="ghost-muted" aria-label="Close skill" />}
              >
                <XIcon aria-hidden />
              </DialogClose>
            </div>
          </div>
          <DialogTitle>
            {formatProviderSkillDisplayName({ name })}{" "}
            <span className="font-normal text-muted-foreground">Skill</span>
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="mx-6 mb-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background">
          <DialogPanel padding="none" scrollFade={false}>
            {instructions === null ? (
              <p className="p-6 text-sm text-muted-foreground">{error ?? "Loading skill…"}</p>
            ) : (
              <ChatMarkdown
                text={instructions}
                cwd={undefined}
                environmentId={environmentId}
                contentDirection="auto"
                className="p-6"
              />
            )}
          </DialogPanel>
        </div>
        {tryError ? (
          <p role="alert" className="px-6 text-sm text-destructive-foreground">
            {tryError}
          </p>
        ) : null}
        {onTry ? (
          <DialogFooter variant="bare">
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
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

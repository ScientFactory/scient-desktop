import { ChevronDownIcon, FolderInputIcon, PlusIcon, PlugIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { AddConnectorDialog } from "./AddConnectorDialog";
import { AddLocalConnectorDialog } from "./AddLocalConnectorDialog";
import { MAKE_CONNECTOR_PROMPT, useConnectorAgentChat } from "./connectorAgentChat";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import type { ExtensionKind } from "./extensionsView";

type Shown = { readonly step: "choose" } | { readonly step: "web"; readonly url: string };

/**
 * The one way in for anything not in the catalog. As a button it is a small "Add" menu: create a
 * connector with an agent, or bring a skill, connector or plugin from a file, a folder, a web
 * address, pasted text or another app. On Skills, and wherever no agent can make one, the button
 * opens the second straight away. The link sits under Discover search results.
 */
export function AddYourOwn({
  variant = "button",
  kind,
}: {
  readonly variant?: "button" | "link";
  /** The tab it is on: Skills offers other agents' skills first. */
  readonly kind?: ExtensionKind | undefined;
}) {
  const { environmentId, canWrite, callbackOrigin } = useExtensionsEnvironment();
  const startChat = useConnectorAgentChat(environmentId);
  const create =
    variant === "button" && kind !== "skills" && startChat !== undefined
      ? () => void startChat(MAKE_CONNECTOR_PROMPT, "make")
      : undefined;
  const [shown, setShown] = useState<Shown | null>(null);
  const onOpenChange = (open: boolean) => {
    if (!open) setShown(null);
  };
  const open = () => setShown({ step: "choose" });
  return (
    <>
      {variant === "button" && create ? (
        <Menu>
          <MenuTrigger
            render={<Button size="sm" variant="outline" disabled={!canWrite} aria-label="Add" />}
          >
            <PlusIcon aria-hidden />
            Add
            <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="end" className="w-max">
            <MenuItem onClick={create}>
              <PlugIcon aria-hidden />
              Create a connector with an agent
            </MenuItem>
            <MenuItem onClick={open}>
              <FolderInputIcon aria-hidden />
              Add from a file, folder or link
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : variant === "button" ? (
        <Button size="sm" variant="outline" disabled={!canWrite} onClick={open} aria-label="Add">
          <PlusIcon aria-hidden />
          Add
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost-muted"
          className="-ms-2"
          disabled={!canWrite}
          onClick={open}
        >
          Not here? Add your own
        </Button>
      )}
      {shown?.step === "choose" ? (
        <AddLocalConnectorDialog
          open
          onOpenChange={onOpenChange}
          environmentId={environmentId}
          entry={null}
          kind={kind}
          onWebAddress={(url) => setShown({ step: "web", url })}
        />
      ) : null}
      {shown?.step === "web" ? (
        <AddConnectorDialog
          open
          onOpenChange={onOpenChange}
          environmentId={environmentId}
          entry={null}
          callbackOrigin={callbackOrigin}
          initialUrl={shown.url}
          onBack={open}
        />
      ) : null}
    </>
  );
}

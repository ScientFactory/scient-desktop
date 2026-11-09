import { PlusIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { AddConnectorDialog } from "./AddConnectorDialog";
import { AddLocalConnectorDialog } from "./AddLocalConnectorDialog";
import { MAKE_CONNECTOR_PROMPT, useConnectorAgentChat } from "./connectorAgentChat";
import { useExtensionsEnvironment } from "./ExtensionsPage";
import type { ExtensionKind } from "./extensionsView";

type Shown = { readonly step: "choose" } | { readonly step: "web"; readonly url: string };

/**
 * The one way in for anything not in the catalog: a skill, connector or plugin from a file, a
 * folder, a web address, pasted text, or another app. Shown on Discover and Installed alike, and under Discover search results.
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
  const [shown, setShown] = useState<Shown | null>(null);
  const onOpenChange = (open: boolean) => {
    if (!open) setShown(null);
  };
  const open = () => setShown({ step: "choose" });
  return (
    <>
      {variant === "button" ? (
        <Button size="sm" variant="outline" disabled={!canWrite} onClick={open}>
          <PlusIcon aria-hidden />
          Add your own
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

/** Opens a chat where an agent makes a connector with the user; shown with the plugins. */
export function MakeConnector({ kind }: { readonly kind?: ExtensionKind | undefined }) {
  const { environmentId, canWrite } = useExtensionsEnvironment();
  const startChat = useConnectorAgentChat(environmentId);
  if (kind === "skills" || startChat === undefined) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!canWrite}
      onClick={() => void startChat(MAKE_CONNECTOR_PROMPT, "make")}
    >
      <SparklesIcon aria-hidden />
      Make a connector
    </Button>
  );
}

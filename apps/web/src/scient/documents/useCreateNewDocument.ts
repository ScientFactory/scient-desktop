import type { EnvironmentId } from "@t3tools/contracts";

import { setProjectFileQueryData } from "~/components/files/projectFilesQueryState";
import { toastManager } from "~/components/ui/toast";

import { readNewDocumentDefaults } from "./documentPreferences";
import { createNewDocumentSource, type NewDocumentFormat } from "./documentTemplates";
import { focusNewDocumentWhenOpen } from "./focusNewDocument";
import { placeNewDocument, untitledStem } from "./newDocumentPlacement";
import { newDocuments, pathHasLeftoverDrafts } from "./newDocuments";
import { useNewDocumentFiles } from "./useNewDocumentFiles";
import { userTemplates } from "./userTemplates";

/**
 * A document started by hand: `untitled` is created in `base` and opens in its
 * editor, where it takes its title's name once the title is written. `base` is
 * "" for the project's top folder, otherwise a folder path ending in "/".
 */
export function useCreateNewDocument() {
  const documentFiles = useNewDocumentFiles();
  return (input: {
    readonly format: NewDocumentFormat;
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly base: string;
    readonly open: (relativePath: string) => void;
  }) => {
    const { format, environmentId, cwd } = input;
    void (async () => {
      // A default the person chose from their own templates needs those read.
      await userTemplates.ready();
      const { template, language, compiler } = readNewDocumentDefaults();
      const contents = createNewDocumentSource({ format, template, language, compiler });
      const placed = await placeNewDocument({
        format,
        base: input.base,
        stem: untitledStem(format, template),
        template,
        source: contents,
        commands: documentFiles.commandsFor({ environmentId, cwd }),
        // A name still holding an earlier document's unsaved work is passed over.
        skip: (relativePath) => pathHasLeftoverDrafts({ environmentId, cwd, relativePath }),
      });
      if (!placed) {
        toastManager.add({ type: "error", title: "The document could not be created." });
        return;
      }
      const { relativePath } = placed;
      setProjectFileQueryData(environmentId, cwd, relativePath, contents, placed.revision);
      newDocuments.set(
        { environmentId, cwd, relativePath },
        {
          format,
          template,
          language,
          seenUntouched: false,
          settled: format === "markdown",
          companions: placed.companions,
        },
      );
      input.open(relativePath);
      focusNewDocumentWhenOpen("title");
    })();
  };
}

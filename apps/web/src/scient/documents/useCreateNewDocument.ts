import type { EnvironmentId } from "@t3tools/contracts";

import { setProjectFileQueryData } from "~/components/files/projectFilesQueryState";
import { toastManager } from "~/components/ui/toast";

import type { NewDocumentChoice } from "./NewDocumentMenuItems";
import { readNewDocumentDefaults } from "./documentPreferences";
import { createNewDocumentSource } from "./documentTemplates";
import { focusNewDocumentWhenOpen } from "./focusNewDocument";
import { placeNewDocument, untitledStem } from "./newDocumentPlacement";
import { newDocuments, pathHasLeftoverDrafts } from "./newDocuments";
import { useNewDocumentFiles } from "./useNewDocumentFiles";
import { userTemplates } from "./userTemplates";

/** One empty code cell, the way Jupyter writes a new notebook. */
const newNotebook = (language: string) =>
  `${JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          id: "first",
          metadata: {},
          outputs: [],
          source: [],
        },
      ],
      metadata: { language_info: { name: language } },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`;
const NOTEBOOK_NAME_ATTEMPTS = 50;

/**
 * A document started by hand: `untitled` is created in `base` and opens in its
 * editor, where it takes its title's name once the title is written. `base` is
 * "" for the project's top folder, otherwise a folder path ending in "/".
 */
export function useCreateNewDocument() {
  const documentFiles = useNewDocumentFiles();
  return (input: {
    readonly format: NewDocumentChoice;
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly base: string;
    readonly open: (relativePath: string) => void;
    readonly notebookLanguage?: string;
  }) => {
    const { format, environmentId, cwd } = input;
    if (format === "notebook") {
      void (async () => {
        const commands = documentFiles.commandsFor({ environmentId, cwd });
        for (let attempt = 1; attempt <= NOTEBOOK_NAME_ATTEMPTS; attempt += 1) {
          const name = attempt === 1 ? "untitled.ipynb" : `untitled-${attempt}.ipynb`;
          const created = await commands.create(
            `${input.base}${name}`,
            newNotebook(input.notebookLanguage ?? "python"),
          );
          if (created === "exists") continue;
          if (created === null) break;
          input.open(`${input.base}${name}`);
          return;
        }
        toastManager.add({ type: "error", title: "The notebook could not be created." });
      })();
      return;
    }
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

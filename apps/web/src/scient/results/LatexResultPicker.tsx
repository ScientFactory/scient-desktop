import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { RESULTS_PLACED_EVENT } from "./LatexResultsStatus";
import { ResultPicker, resultErrorMessage, type ResultChoice } from "./ResultPicker";

/**
 * Insert ▸ Result for a LaTeX paper. Scient writes plain files under `results/<script>/` beside the
 * root document; the paper gets a macro, or a `table`/`figure` environment that includes them.
 */
export function LatexResultPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** The root document, whose folder LaTeX resolves paths from. */
  readonly rootPath: string;
  /** The editor's preamble with its included files, so new macro names avoid every one in use. */
  readonly setup: () => string;
  /** Reads the placed files into the editor before an insertion includes them. */
  readonly prepareFiles: (paths: ReadonlyArray<string>) => Promise<boolean>;
  /** Adds a preamble line unless `present` finds it in the setup already; false when it cannot. */
  readonly ensurePreambleLine: (line: string, present: RegExp) => boolean;
  readonly insertMacro: (macro: { name: string; definition: string; source: string }) => boolean;
  readonly insertBlock: (source: string) => boolean;
  readonly onClose: () => void;
}) {
  const canPlace = useAtomValue(
    computeEnvironment.resultsPlaceLatex.permissionAtom(props.environmentId),
  );
  const place = useAtomCommand(computeEnvironment.resultsPlaceLatex, { reportFailure: false });
  // A picker closed while its result was being placed must not edit the document afterwards.
  const open = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the picker closed on unmount so a pending placement does not edit the document
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const pick = async (choice: ResultChoice): Promise<string | null> => {
    if (!canPlace) return "You don't have permission to add files to this project.";
    const result = await place({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        documentPath: props.rootPath,
        setup: props.setup().slice(0, 512 * 1024),
        revision: choice.script.latest.revision,
        output: choice.kind === "value" ? choice.value.output : choice.output,
        pointer: choice.kind === "value" ? choice.value.pointer : null,
      },
    });
    if (result._tag !== "Success")
      return resultErrorMessage(result, "The result could not be placed in the project.");
    const placed = result.value;
    window.dispatchEvent(new Event(RESULTS_PLACED_EVENT));
    if (!(await props.prepareFiles(placed.files)))
      return "The placed files could not be read yet. Try again in a moment.";
    if (!open.current) return null;
    for (const name of placed.packages)
      if (
        !props.ensurePreambleLine(
          `\\usepackage{${name}}`,
          new RegExp(String.raw`\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b${name}\b`, "u"),
        )
      )
        return `The preamble could not be changed. Add \\usepackage{${name}} before \\begin{document}, then try again.`;
    if (placed.insert.kind === "block")
      return props.insertBlock(placed.insert.source)
        ? null
        : "This spot cannot take a block. Place the cursor between paragraphs, then try again.";
    if (placed.macro === null) return "The result could not be placed in the project.";
    if (
      placed.preambleInput !== null &&
      // Its own definition shows the values file is included; any other use of the name does not.
      !props.ensurePreambleLine(
        placed.preambleInput,
        new RegExp(String.raw`\\newcommand\s*\{\s*\\${placed.macro.name}\s*\}`, "u"),
      )
    )
      return `The preamble could not be changed. Add ${placed.preambleInput} before \\begin{document}, then try again.`;
    return props.insertMacro({ ...placed.macro, source: placed.insert.source })
      ? null
      : "Place the cursor in ordinary text, then try again.";
  };

  return (
    <ResultPicker
      environmentId={props.environmentId}
      cwd={props.cwd}
      figures={(output) => !/\.svg$/iu.test(output)}
      tables={() => true}
      onPick={pick}
      onClose={props.onClose}
    />
  );
}

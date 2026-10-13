import { useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";

import "~/index.css";
import "../scient-latex.css";
import { LatexVisualEditor } from "../LatexVisualEditor";
import { useLatexVisualTestOwner } from "../latexVisualTestOwner";
import { clearVisualDraft } from "../visualDrafts";
import { latexBenchmarkDocument } from "./latexBenchmarkDocument";

/** Production-build page driven by `scripts/latex-visual-benchmark.ts`. */
function BenchmarkEditor(props: { source: string; draftKey: string }) {
  const [value, setValue] = useState(props.source);
  const owner = useLatexVisualTestOwner(value);
  useLayoutEffect(() => {
    benchmark.published = value;
  }, [value]);
  return (
    <LatexVisualEditor
      draftKey={props.draftKey}
      fileRevision="r1"
      rootRelativePath="main.tex"
      relativePath="main.tex"
      cwd="/synthetic/benchmark"
      source={value}
      sourceSnapshot={owner.snapshot}
      disabled={false}
      onEditingChange={() => {}}
      onOpenSource={() => {}}
      onEdit={(request) => {
        const outcome = owner.edit(request, request.edit.source === value);
        if (outcome.accepted) setValue(outcome.snapshot.source);
        return outcome;
      }}
    />
  );
}

let root: Root | null = null;
let draftKeys: readonly string[] = [];
const benchmark = {
  published: "",
  open(source: string, key: string) {
    benchmark.close();
    draftKeys = [key];
    clearVisualDraft(key);
    benchmark.published = source;
    const host = document.getElementById("root")!;
    root = createRoot(host);
    root.render(<BenchmarkEditor source={source} draftKey={key} />);
  },
  /** Several documents open at once, each in its own pane. */
  openMany(source: string, keys: readonly string[]) {
    benchmark.close();
    draftKeys = keys;
    keys.forEach(clearVisualDraft);
    const host = document.getElementById("root")!;
    root = createRoot(host);
    root.render(
      <>
        {keys.map((key) => (
          <div key={key} style={{ display: "flex", flexDirection: "column", height: 300 }}>
            <BenchmarkEditor source={source} draftKey={key} />
          </div>
        ))}
      </>,
    );
  },
  close() {
    root?.unmount();
    root = null;
    draftKeys.forEach(clearVisualDraft);
    draftKeys = [];
  },
  editor(): Editor | null {
    return (
      (document.querySelector(".scient-latex-visual-document") as HTMLElement & { editor?: Editor })
        ?.editor ?? null
    );
  },
  synthetic: latexBenchmarkDocument,
};
Object.assign(window, { latexBenchmark: benchmark });

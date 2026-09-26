import { describe, expect, it } from "vite-plus/test";
import {
  editVisualRun,
  encodeVisualText,
  matchVisualRun,
  visualCharacters,
  visualRuns,
} from "@t3tools/shared/latexVisual";

const document = (body: string) =>
  `\\documentclass{article}\n% private comment stays\n\\begin{document}\n${body}\n\\end{document}\n`;

describe("lossless visual LaTeX prose projection", () => {
  it("edits prose without serializing surrounding syntax or comments", () => {
    const source = document(
      "Hello  beautiful\nworld. % untouched\n\n\\section{Results}\nMeasured \\textbf{strong} effects.",
    );
    const match = matchVisualRun(source, "Hello beautiful world.", 6, 4)!;
    expect(match.offset).toBe(6);
    expect(
      editVisualRun(source, match.run, match.run.text.replace("beautiful", "remarkable")),
    ).toBe(source.replace("beautiful", "remarkable"));
    for (const run of visualRuns(source)) expect(editVisualRun(source, run, run.text)).toBe(source);
    expect(visualRuns(source).map((run) => run.text.trim())).toContain("Results");
  });

  it("maps TeX escapes, whitespace, punctuation and ligatures without losing source offsets", () => {
    const source = document("An efficient office: 50\\% \\& reliable---always.");
    const match = matchVisualRun(source, "An eﬃcient oﬃce: 50% & reliable—always.", 3, 4)!;
    expect(match).not.toBeNull();
    expect(editVisualRun(source, match.run, match.run.text.replace("50%", "80%"))).toBe(
      source.replace("50", "80"),
    );
    expect(visualCharacters("a😀 ﬃ").offsets).toEqual([0, 1, 1, 4, 4, 4, 5]);
  });

  it("refuses duplicate matches and wrong SyncTeX lines", () => {
    expect(
      matchVisualRun(document("Repeated words. Repeated words."), "Repeated words.", 2, 4),
    ).toBeNull();
    expect(matchVisualRun(document("A unique sentence."), "A unique sentence.", 2, 40)).toBeNull();
    expect(matchVisualRun(document("A unique sentence."), "A", 0, 4)).toBeNull();
  });

  it.each([
    "\\unknown{Hidden text}\nmore opaque text",
    "\\begin{tikzpicture}Hidden text\\end{tikzpicture}",
    "\\begin{verbatim}Hidden text\\end{verbatim}",
    "\\begin{tabular}{cc}Hidden & text\\end{tabular}",
    "$Hidden text$",
    "$$Hidden text$$",
    "\\[Hidden text\\]",
  ])("keeps unsupported regions opaque: %s", (body) => {
    expect(visualRuns(document(body))).toEqual([]);
  });

  it("blocks syntax-changing primitives and excessive source sizes", () => {
    expect(visualRuns(document("\\catcode`\\%=12\n\nSome text."))).toEqual([]);
    expect(visualRuns("a".repeat(1_000_001))).toEqual([]);
  });

  it.each([
    "\\[first\n\nHidden text\\]",
    "$x \\$ Hidden text$",
    "\\opaque{first\n\nHidden text}",
    "\\opaque {first\n\nHidden text}",
    "\\begin{tabular}first\\begin{tabular}nested\\end{tabular}Hidden text\\end{tabular}",
  ])("does not leak opaque nested or multiline syntax into editable runs: %s", (body) => {
    expect(visualRuns(document(body))).toEqual([]);
  });

  it.each([
    "\\begin{verbatim}\n% \\end{verbatim}\nHidden text\n\\end{verbatim}\nVisible prose.",
    "\\begin{verbatim*}\n% \\end{verbatim*}\nHidden text\n\\end{verbatim*}\nVisible prose.",
    "\\begin{tabular}{c}\n% \\end{tabular}\nHidden text\\\\\n\\end{tabular}\nVisible prose.",
    "\\begin{tikzpicture}\n% \\end{tikzpicture}\n\\node {Hidden text};\n\\end{tikzpicture}\nVisible prose.",
    "\\begin{opaque}\n% \\end{opaque}\nHidden text\n\\end{opaque}\nVisible prose.",
    "\\begin{tabular}{c}\\verb|\\end{tabular}| Hidden text\\end{tabular}\nVisible prose.",
    "\\begin{minipage}{.8\\linewidth}\n\\begin{verbatim}\n\\end{minipage}\nHidden text\n\\end{verbatim}\n\\end{minipage}\nVisible prose.",
  ])("ignores fake opaque-environment closers: %s", (body) => {
    const runs = visualRuns(document(body)).map((run) => run.text);
    expect(runs).toEqual(["Visible prose."]);
    expect(runs.join(" ")).not.toContain("Hidden text");
  });

  it("fails closed when an opaque environment has no provable closing delimiter", () => {
    expect(
      visualRuns(document("\\begin{verbatim}\n% \\end{verbatim}\nHidden text\nVisible prose.")),
    ).toEqual([]);
  });

  it("escapes pasted TeX syntax and encodes paragraph breaks", () => {
    expect(encodeVisualText("\\input{secret} % & _ # $ ~ ^\r\nnext")).toBe(
      "\\textbackslash{}input\\{secret\\} \\% \\& \\_ \\# \\$ \\textasciitilde{} \\textasciicircum{}\n\nnext",
    );
  });

  it.each(["\\", "~", "^", "%", "&", "_", "#", "$", "{", "}"])(
    "round-trips serializer-owned literal %s back into an editable run",
    (literal) => {
      const source = document("Replace this prose.");
      const replacement = `left${literal}right`;
      const edited = editVisualRun(source, visualRuns(source)[0]!, replacement);
      const reparsed = visualRuns(edited);
      expect(reparsed.map((run) => run.text)).toEqual([replacement]);
      expect(editVisualRun(edited, reparsed[0]!, "Settled prose.")).toBe(
        document("Settled prose."),
      );
    },
  );

  it("stress-tests 2500 minimal splices and byte preservation", () => {
    let seed = 431;
    const random = (limit: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % limit;
    };
    for (let i = 0; i < 2500; i++) {
      const plain =
        Array.from({ length: 10 + random(80) }, () => "abc xyz"[random(7)])
          .join("")
          .trim() || "word";
      const source = document(`\\section{Title}\n${plain}\n% trailing note`);
      const run = visualRuns(source).find((entry) => entry.text === plain.replace(/\s+/gu, " "))!;
      const at = random(run.text.length + 1);
      const count = random(run.text.length - at + 1);
      const insert = ["Q", "50%", "{safe}", "😀", "", "A&B"][random(6)]!;
      const next = run.text.slice(0, at) + insert + run.text.slice(at + count);
      const edited = editVisualRun(source, run, next);
      expect(edited.startsWith(source.slice(0, run.from))).toBe(true);
      expect(edited.endsWith(source.slice(run.to))).toBe(true);
      expect(edited).not.toContain("\\input{secret}");
      expect(editVisualRun(source, run, run.text)).toBe(source);
    }
  });
});

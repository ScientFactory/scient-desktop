import { describe, expect, it } from "vite-plus/test";

import { splitRunOutputLinks } from "./computeRunOutputLinks";

const place = { cwd: "/home/ada/lab", relativePath: "src/a.java" };
const links = (text: string, at = place) =>
  splitRunOutputLinks(text, at).flatMap((piece) => (piece.link === undefined ? [] : [piece.link]));

describe("links in a program's output", () => {
  it.each([
    ["javac", "/home/ada/lab/src/a.java:12: error: ';' expected", 12],
    ["clang and gfortran", "/home/ada/lab/src/a.java:12:5: error: bad", 12],
    ["rustc", "  --> /home/ada/lab/src/a.java:12:5", 12],
    ["node", "    at f (/home/ada/lab/src/a.java:12:5)", 12],
    ["node modules", "    at f (file:///home/ada/lab/src/a.java:12:5)", 12],
    ["msvc", "/home/ada/lab/src/a.java(12): error C2143", 12],
    ["python", 'File "/home/ada/lab/src/a.java", line 12, in f', 12],
    ["perl", "Died at /home/ada/lab/src/a.java line 12.", 12],
    ["bash", "/home/ada/lab/src/a.java: line 12: nope: command not found", 12],
    ["ruby", "/home/ada/lab/src/a.java:12:in 'f': boom", 12],
    ["tcl", '(file "/home/ada/lab/src/a.java" line 12)', 12],
  ])("finds the line in %s output", (_tool, text, line) => {
    expect(links(text)).toEqual([{ relativePath: "src/a.java", line }]);
  });

  it("links another file in the project", () => {
    expect(links("/home/ada/lab/lib/b.h:3:1: note: here")).toEqual([
      { relativePath: "lib/b.h", line: 3 },
    ]);
  });

  it("finds the file that ran when its path holds spaces", () => {
    const spaced = { cwd: "/home/ada/my lab", relativePath: "my file.c" };
    expect(links("/home/ada/my lab/my file.c:7:2: error: x", spaced)).toEqual([
      { relativePath: "my file.c", line: 7 },
    ]);
  });

  it("reads Windows paths", () => {
    const windows = { cwd: "C:\\lab", relativePath: "src/a.c" };
    expect(links("C:\\lab\\src\\a.c(4): error C2143", windows)).toEqual([
      { relativePath: "src/a.c", line: 4 },
    ]);
  });

  it("shows project paths relative to the project, and keeps every other word", () => {
    const text = "first\n/home/ada/lab/src/a.java:12: error: x\nlast\n";
    const pieces = splitRunOutputLinks(text, place);
    expect(pieces.map((piece) => piece.text).join("")).toBe(
      "first\nsrc/a.java:12: error: x\nlast\n",
    );
  });

  it("shortens a project path that has no line, without linking it", () => {
    expect(splitRunOutputLinks("wrote /home/ada/lab/out.txt", place)).toEqual([
      { text: "wrote " },
      { text: "out.txt" },
    ]);
  });

  it("leaves paths outside the project alone", () => {
    const text = "/usr/include/stdio.h:1:1: note";
    expect(splitRunOutputLinks(text, place)).toEqual([{ text }]);
  });

  it("does not mistake a sibling folder for the project", () => {
    const text = "/home/ada/lab2/a.c:1:1: note";
    expect(splitRunOutputLinks(text, place)).toEqual([{ text }]);
  });

  it("does not link line zero", () => {
    expect(links("/home/ada/lab/src/a.java:0: note")).toEqual([]);
  });
});

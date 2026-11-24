// Tests the word and selection rules shared by both editors' font commands.
import { describe, expect, it } from "vite-plus/test";
import { holdsFont, sharedValue, wordAround } from "./fontTarget";

describe("wordAround", () => {
  it("covers letters, digits, accents and an apostrophe between letters", () => {
    expect(wordAround("I don't know", 4)).toEqual({ start: 2, end: 7 });
    expect(wordAround("l’arbre vert", 0)).toEqual({ start: 0, end: 7 });
    expect(wordAround("café x", 5)).toEqual({ start: 0, end: 5 });
    expect(wordAround("שלום עולם", 2)).toEqual({ start: 0, end: 4 });
  });

  it("is null between words and stops at a quote that ends a word", () => {
    expect(wordAround("a  b", 2)).toBeNull();
    expect(wordAround("'quoted' x", 3)).toEqual({ start: 1, end: 7 });
  });
});

describe("holdsFont and sharedValue", () => {
  it("ignores whitespace and code, and reports a mix", () => {
    expect(holdsFont(" \n", false)).toBe(false);
    expect(holdsFont("x", true)).toBe(false);
    expect(holdsFont(" x ", false)).toBe(true);
    expect(sharedValue(new Set([14]))).toEqual({ value: 14, mixed: false });
    expect(sharedValue(new Set([14, null]))).toEqual({ value: null, mixed: true });
    expect(sharedValue(new Set())).toEqual({ value: null, mixed: false });
  });
});

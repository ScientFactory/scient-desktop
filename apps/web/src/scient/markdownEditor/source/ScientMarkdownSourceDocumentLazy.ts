import { lazy } from "react";

export const LazyScientMarkdownSourceDocument = lazy(async () => {
  const module = await import("./ScientMarkdownSourceDocument");
  return { default: module.ScientMarkdownSourceDocument };
});

import { lazy } from "react";

export const LazyScientMarkdownDocument = lazy(async () => {
  const module = await import("./ScientMarkdownDocument");
  return { default: module.ScientMarkdownDocument };
});

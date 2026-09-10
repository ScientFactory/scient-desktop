export type ScientMarkdownExternalPresentationChange = "appearance" | "workspace" | "mode";

export type ScientMarkdownExternalPresentationRefresh = (
  change: ScientMarkdownExternalPresentationChange,
) => void;

export type ScientMarkdownExternalPresentationRegistrar = (
  refresh: ScientMarkdownExternalPresentationRefresh,
) => () => void;

export type ScientMarkdownTheme = "light" | "dark";
export type ScientMarkdownThemeResolver = () => ScientMarkdownTheme;

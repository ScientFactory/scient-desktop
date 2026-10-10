import type { File as FileInstance, PostRenderPhase } from "@pierre/diffs";
import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { FILE_LINK_REVEAL_UNSAFE_CSS } from "~/components/files/fileSurfaceChrome";
import { projectFileCacheKey } from "~/components/files/fileContentRevision";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { scientificSourceLanguageOverride } from "~/scient/analysis/sourceLanguage";

export const FILE_ACTIVE_RANGE_ATTRIBUTE = "data-scient-active-range";
export const SCIENT_FILE_UNSAFE_CSS = `
  ${FILE_LINK_REVEAL_UNSAFE_CSS}
  :host([${FILE_ACTIVE_RANGE_ATTRIBUTE}]) [data-line][data-selected-line] {
    background-color: light-dark(
      color-mix(in srgb, var(--primary) 8%, transparent),
      color-mix(in srgb, var(--primary) 12%, transparent)
    ) !important;
  }

  :host([${FILE_ACTIVE_RANGE_ATTRIBUTE}]) [data-column-number][data-selected-line] {
    background-color: light-dark(
      color-mix(in srgb, var(--primary) 13%, transparent),
      color-mix(in srgb, var(--primary) 18%, transparent)
    ) !important;
    color: var(--diffs-fg-number) !important;
  }
`;
export type FilePostRender = <Annotation>(
  container: HTMLElement,
  instance: FileInstance<Annotation, undefined>,
  phase: PostRenderPhase,
) => void;

export function StaticTextFileSurface(props: {
  readonly contents: string;
  readonly cwd: string;
  readonly onPostRender: FilePostRender;
  readonly relativePath: string;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
}) {
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={{
            name: props.relativePath,
            contents: props.contents,
            ...scientificSourceLanguageOverride(props.relativePath),
            cacheKey: projectFileCacheKey(props.cwd, props.relativePath, props.contents),
          }}
          options={{
            disableFileHeader: true,
            overflow: props.wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(props.resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: props.resolvedTheme,
            unsafeCSS: SCIENT_FILE_UNSAFE_CSS,
            onPostRender: props.onPostRender,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}

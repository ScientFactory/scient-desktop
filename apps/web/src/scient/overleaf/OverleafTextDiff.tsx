import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

import { useTheme } from "~/hooks/useTheme";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";

export function OverleafTextDiff(props: {
  readonly path: string;
  readonly overleaf: string;
  readonly local: string;
  readonly overleafHash: string | null;
  readonly localHash: string | null;
}) {
  const { resolvedTheme } = useTheme();
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        {
          name: props.path,
          contents: props.overleaf,
          cacheKey: `overleaf:${props.path}:${props.overleafHash ?? props.overleaf}`,
        },
        {
          name: props.path,
          contents: props.local,
          cacheKey: `local:${props.path}:${props.localHash ?? props.local}`,
        },
      ),
    [props.local, props.localHash, props.overleaf, props.overleafHash, props.path],
  );

  return (
    <div className="max-h-[26rem] overflow-auto rounded-lg border">
      <FileDiff
        fileDiff={fileDiff}
        options={{
          collapsed: false,
          diffStyle: "split",
          disableFileHeader: true,
          overflow: "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          themeType: resolvedTheme,
          unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
        }}
      />
    </div>
  );
}

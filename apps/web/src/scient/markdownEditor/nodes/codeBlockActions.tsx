import { type ComponentProps, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";

import { CodeBlockActions, useCodeBlockWordWrap } from "~/scient/presentation/CodeBlockActions";
import { CodeBlockTitle } from "~/scient/presentation/CodeBlockTitle";

function EditorCodeBlockActions({
  readCode,
  onWrapChange,
}: {
  readonly readCode: () => string;
  readonly onWrapChange: (wrapped: boolean) => void;
}) {
  const [wrapped, setWrapped] = useCodeBlockWordWrap();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the persisted word-wrap state to the code block node's onWrapChange handler
  useLayoutEffect(() => onWrapChange(wrapped), [onWrapChange, wrapped]);
  return <CodeBlockActions wrapped={wrapped} onWrapChange={setWrapped} readCode={readCode} />;
}

export function mountCodeBlockActions(
  host: HTMLElement,
  readCode: () => string,
  onWrapChange: (wrapped: boolean) => void,
): () => void {
  const root = createRoot(host);
  root.render(<EditorCodeBlockActions readCode={readCode} onWrapChange={onWrapChange} />);
  return () => root.unmount();
}

export function mountCodeBlockHeader(
  host: HTMLElement,
  readCode: () => string,
  onWrapChange: (wrapped: boolean) => void,
) {
  const root = createRoot(host);
  let previousTitle: ComponentProps<typeof CodeBlockTitle> | undefined;
  return {
    updateTitle: (title: ComponentProps<typeof CodeBlockTitle>) => {
      if (
        previousTitle?.language === title.language &&
        previousTitle.fenceTitle === title.fenceTitle &&
        previousTitle.theme === title.theme
      ) {
        return;
      }
      previousTitle = title;
      root.render(
        <>
          <span className="scient-markdown-code-language inline-flex min-w-0 items-center gap-[0.4rem]">
            <CodeBlockTitle {...title} />
          </span>
          <EditorCodeBlockActions readCode={readCode} onWrapChange={onWrapChange} />
        </>,
      );
    },
    destroy: () => root.unmount(),
  };
}

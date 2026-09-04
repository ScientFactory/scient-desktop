import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";

import { CodeBlockActions, useCodeBlockWordWrap } from "~/scient/presentation/CodeBlockActions";

function EditorCodeBlockActions({
  readCode,
  onWrapChange,
}: {
  readonly readCode: () => string;
  readonly onWrapChange: (wrapped: boolean) => void;
}) {
  const [wrapped, setWrapped] = useCodeBlockWordWrap();
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

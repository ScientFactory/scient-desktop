import { afterChatInputQuiet, chatInputQuietDelay } from "./inputPriority";

export function prioritizeChatOverScroll(container: HTMLElement): () => void {
  const pending = new Set<Element>();
  let cancel: (() => void) | undefined;
  const scroll = (event: Event) => {
    if (chatInputQuietDelay() === 0 || !(event.target instanceof Element)) return;
    event.stopImmediatePropagation();
    pending.add(event.target);
    cancel ??= afterChatInputQuiet(() => {
      cancel = undefined;
      const targets = [...pending];
      pending.clear();
      for (const target of targets) {
        if (container.contains(target)) target.dispatchEvent(new Event("scroll"));
      }
    });
  };
  container.addEventListener("scroll", scroll, true);
  return () => {
    container.removeEventListener("scroll", scroll, true);
    cancel?.();
    pending.clear();
  };
}

// FILE: imeComposition.ts
// Purpose: Detect keyboard events fired while an IME (input method editor) is
//          mid-composition, so Enter-to-send handlers do not submit a
//          half-composed message when the keypress is really confirming a
//          CJK/Japanese/Korean candidate.
// Layer: Web input utility
// Exports: isImeCompositionKeyEvent

// While an IME is composing, pressing Enter commits the highlighted candidate
// rather than the message. `isComposing` covers modern browsers; `keyCode ===
// 229` is the legacy signal some IMEs still emit on the confirming keydown,
// where `isComposing` can already read false. Guard on both so composer send
// paths never fire during composition.
export function isImeCompositionKeyEvent(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}

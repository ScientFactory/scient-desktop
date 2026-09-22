// Compatibility exports for existing math hosts. Ownership is editor-neutral.
export {
  registerShortcutClaim as registerMathClaim,
  surfaceOwnsShortcut as mathInputOwnsEvent,
} from "../../keyboard/ownership";

// Renderer compatibility barrel. Shortcut semantics live in the shared
// package so main-side validation and every renderer surface consume the same
// explicit platform model.

export {
  acceleratorToAccessibleText,
  acceleratorToDisplay,
  acceleratorToDisplayKeys,
  acceleratorToDisplayText,
  normalizeAccelerator,
  parseAccelerator,
  shortcutPlatformFromString
} from "@pwrsnap/shared";
export type {
  AcceleratorDisplay,
  AcceleratorNormalizationErrorCode,
  AcceleratorNormalizationResult,
  ShortcutModifier,
  ShortcutPlatform
} from "@pwrsnap/shared";

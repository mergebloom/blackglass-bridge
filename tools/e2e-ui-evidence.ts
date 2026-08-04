export const E2E_UI_EVIDENCE_SCHEMA_VERSION = 3 as const;

export function isBoundE2EUiSnapshotPage(
  state: Record<string, unknown>,
  debugTargetUrl: string,
): boolean {
  if (state.boundRendererUrl !== debugTargetUrl) return false;
  if (state.foregroundPageKind === "bound-renderer") {
    return state.url === debugTargetUrl;
  }
  return state.foregroundPageKind === "settings-auxiliary" &&
    state.url === "about:blank" &&
    typeof state.title === "string" &&
    /^Settings(?:\s|\s+-)/u.test(state.title);
}

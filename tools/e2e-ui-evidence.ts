export const E2E_UI_EVIDENCE_SCHEMA_VERSION = 4 as const;

export function e2eUiSnapshotText(state: Record<string, unknown>): {
  bodyText: string;
  accessibleText: string[];
  combined: string;
} | undefined {
  if (
    typeof state.bodyText !== "string" ||
    typeof state.boundRendererBodyText !== "string" ||
    !Array.isArray(state.accessibleText) ||
    state.accessibleText.some((value) => typeof value !== "string") ||
    !Array.isArray(state.boundRendererAccessibleText) ||
    state.boundRendererAccessibleText.some((value) => typeof value !== "string")
  ) return undefined;
  const bodyText = [state.bodyText, state.boundRendererBodyText].join("\n");
  const accessibleText = [
    ...state.accessibleText as string[],
    ...state.boundRendererAccessibleText as string[],
  ];
  return { bodyText, accessibleText, combined: [bodyText, ...accessibleText].join("\n") };
}

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

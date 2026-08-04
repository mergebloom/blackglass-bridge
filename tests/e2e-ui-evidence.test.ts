import { describe, expect, test } from "bun:test";
import {
  E2E_UI_EVIDENCE_SCHEMA_VERSION,
  e2eUiSnapshotText,
  isBoundE2EUiSnapshotPage,
} from "../tools/e2e-ui-evidence";

describe("E2E UI evidence contract", () => {
  test("uses the current bound snapshot schema", () => {
    expect(E2E_UI_EVIDENCE_SCHEMA_VERSION).toBe(4);
  });

  test("combines a Settings renderer with its bound vault renderer", () => {
    expect(e2eUiSnapshotText({
      bodyText: "E2E Vault",
      accessibleText: [],
      boundRendererBodyText: "E2E Sync Proof",
      boundRendererAccessibleText: ["Fully synced"],
    })?.combined).toContain("E2E Vault\nE2E Sync Proof\nFully synced");
    expect(e2eUiSnapshotText({
      bodyText: "E2E Vault",
      accessibleText: [],
      boundRendererBodyText: "E2E Sync Proof",
      boundRendererAccessibleText: [3],
    })).toBeUndefined();
  });

  test("binds the main renderer while allowing the 1.13 Settings window", () => {
    const debugTargetUrl = "app://obsidian.md/index.html";
    expect(isBoundE2EUiSnapshotPage({
      boundRendererUrl: debugTargetUrl,
      foregroundPageKind: "bound-renderer",
      url: debugTargetUrl,
      title: "Vault",
    }, debugTargetUrl)).toBe(true);
    expect(isBoundE2EUiSnapshotPage({
      boundRendererUrl: debugTargetUrl,
      foregroundPageKind: "settings-auxiliary",
      url: "about:blank",
      title: "Settings - vault - Obsidian 1.13.4",
    }, debugTargetUrl)).toBe(true);
    expect(isBoundE2EUiSnapshotPage({
      boundRendererUrl: "app://attacker.invalid/index.html",
      foregroundPageKind: "settings-auxiliary",
      url: "about:blank",
      title: "Settings - vault - Obsidian 1.13.4",
    }, debugTargetUrl)).toBe(false);
    expect(isBoundE2EUiSnapshotPage({
      boundRendererUrl: debugTargetUrl,
      foregroundPageKind: "settings-auxiliary",
      url: "about:blank",
      title: "Unrelated window",
    }, debugTargetUrl)).toBe(false);
  });
});

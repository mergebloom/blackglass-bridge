import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const publisherPath = resolve(root, "scripts/publish-tooling-release.sh");
const publisher = readFileSync(publisherPath, "utf8");
const artifactBuilder = readFileSync(
  resolve(root, "scripts/build-release-artifacts.sh"),
  "utf8",
);
const releaseWorkflow = readFileSync(
  resolve(root, ".github/workflows/release.yml"),
  "utf8",
);

describe("tooling release publisher", () => {
  test("is syntactically valid and protects immutable published assets", () => {
    const syntax = Bun.spawnSync(["bash", "-n", publisherPath]);
    expect(syntax.exitCode, syntax.stderr.toString()).toBe(0);
    expect(publisher).toContain("release asset basenames must be unique");
    expect(publisher).toContain('[[ "$state" == "starter" && "$size" == "0" ]]');
    expect(publisher).toContain("releases/assets/${asset_id}");
    expect(publisher).toContain("published release has a missing or mismatched asset");
    expect(publisher).not.toContain("--clobber");
    expect(publisher).toContain("published release contains unexpected or missing assets");
    expect(publisher).toContain("shasum -a 256");
    expect(publisher).toContain("stat -f '%z'");
  });

  test("binds semantic version state and verifies eventual consistency", () => {
    expect(publisher).toContain("release tag is not a supported semantic version");
    expect(publisher).toContain("release_prerelease=true");
    expect(publisher).toContain(".name == $title");
    expect(publisher).toContain(".prerelease == $prerelease");
    expect(publisher).toContain("releases?per_page=100");
    expect(publisher).toContain("--paginate");
    expect(publisher).not.toContain("releases/tags/${tag}");
    expect(publisher.match(/--latest=false/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(publisher).toContain("wait_for_release_state");
    expect(publisher).toContain("wait_for_asset");
    expect(publisher).toContain("verify_not_latest");
    expect(publisher).toContain("promote_latest");
    expect(publisher).toContain('gh release edit "$tag" --latest');
    expect(publisher.lastIndexOf('verify_asset "$asset"')).toBeLessThan(
      publisher.lastIndexOf("promote_latest"),
    );
    expect(publisher).toContain("1 2 3 4 5 6 7 8 9 10");
    expect(releaseWorkflow).toContain("group: release-${{ github.repository }}");
    expect(releaseWorkflow).toContain("needs: [release-static-gate, macos-gate]");
  });

  test("routes both release shell entry points through the strict grammar", () => {
    expect(publisher).toContain('source "${script_directory}/semver.sh"');
    expect(publisher).toContain('is_supported_release_tag "$tag"');
    expect(artifactBuilder).toContain('source "${script_directory}/semver.sh"');
    expect(artifactBuilder).toContain('is_supported_semver "$version"');
    for (const tag of [
      "v01.2.3",
      "v1.02.3",
      "v1.2.03",
      "v1.2.3-alpha..1",
      "v1.2.3-alpha.",
      "v1.2.3-.alpha",
      "v1.2.3-alpha.01",
      "v1.2.3+build",
    ]) {
      const result = Bun.spawnSync(
        ["bash", publisherPath, tag, "invalid release", "missing.zip"],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode, tag).not.toBe(0);
      expect(result.stderr.toString(), tag).toContain(
        "release tag is not a supported semantic version",
      );
    }
  });
});

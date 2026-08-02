import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadCompatibilityBaseline } from "../tools/release-compatibility";

const root = resolve(import.meta.dir, "..");
const versions = ["1.12.7", "1.13.4"] as const;
const syncShapes = [
  "deleted(op,suppressrenames)",
  "history(op,path,last)",
  "init(op,token,id,keyhash,version,initial,device,encryption_version)",
  "ping(op)",
  "pull(op,uid)",
  "purge(op)",
  "push(op,path,relatedpath,extension,hash,ctime,mtime,folder,deleted)",
  "push(op,path,relatedpath,extension,hash,ctime,mtime,folder,deleted,size,pieces)",
  "restore(op,uid)",
  "size(op)",
  "usernames(op)",
];

for (const version of versions) {
  const id = version.replaceAll(".", "");

  describe(`Obsidian ${version} stock client contract`, () => {
    test(`CLIENT-${id}-SHARE-SHAPE`, async () => {
      const { baseline } = await loadCompatibilityBaseline(
        resolve(root, `compatibility/obsidian-${version}.json`),
      );
      expect(
        Object.keys(baseline.controlPlaneRoutes).filter((route) =>
          route.startsWith("/vault/share/"),
        ),
      ).toEqual([
        "/vault/share/invite",
        "/vault/share/list",
        "/vault/share/remove",
      ]);
      expect(baseline.controlPlaneRoutes["/vault/list"]).toBeGreaterThanOrEqual(1);
    });

    test(`CLIENT-${id}-IDENTITY`, async () => {
      const { baseline } = await loadCompatibilityBaseline(
        resolve(root, `compatibility/obsidian-${version}.json`),
      );
      expect(
        Object.keys(baseline.syncMessageShapes)
          .filter((shape) => syncShapes.includes(shape))
          .sort(),
      ).toEqual([...syncShapes].sort());
      expect(baseline.syncInboundOperations).toEqual({
        "app.js:pong": 1,
        "app.js:push": 1,
        "app.js:ready": 1,
      });
    });

    test(`CLIENT-${id}-OWNED-SHARED-UI`, async () => {
      const { baseline } = await loadCompatibilityBaseline(
        resolve(root, `compatibility/obsidian-${version}.json`),
      );
      expect(baseline.controlPlaneRoutes).toMatchObject({
        "/vault/list": expect.any(Number),
        "/vault/rename": 1,
        "/vault/delete": 1,
        "/vault/share/list": 1,
        "/vault/share/invite": 1,
        "/vault/share/remove": 1,
      });
      expect(baseline.controlPlaneRoutes["/vault/share/accept"]).toBeUndefined();
    });

    test(`CLIENT-${id}-NO-ROLE`, async () => {
      const { baseline } = await loadCompatibilityBaseline(
        resolve(root, `compatibility/obsidian-${version}.json`),
      );
      expect(Object.keys(baseline.syncMessageShapes).some((shape) => shape.includes("role"))).toBe(
        false,
      );
    });
  });
}

test("CLIENT-1134-POW-UNSUPPORTED", async () => {
  const floor = await loadCompatibilityBaseline(
    resolve(root, "compatibility/obsidian-1.12.7.json"),
  );
  const candidate = await loadCompatibilityBaseline(
    resolve(root, "compatibility/obsidian-1.13.4.json"),
  );
  expect(floor.baseline.controlPlaneRoutes["/user/pow-challenge"]).toBeUndefined();
  expect(candidate.baseline.controlPlaneRoutes["/user/pow-challenge"]).toBe(1);
});

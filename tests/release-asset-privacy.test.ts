import { expect, test } from "bun:test";
import { assertPublicReleaseAsset } from "../tools/release-asset-privacy";

test("standalone release assets reject local source and private deployment material", () => {
  const root = ["", "Users", "example", "project"].join("/");
  expect(() => assertPublicReleaseAsset(Buffer.from(`module=${root}/tools/main.ts`), [root]))
    .toThrow("local source path");
  expect(() => assertPublicReleaseAsset(Buffer.from(["bea", "ini"].join("")), []))
    .toThrow("forbidden private identifier");
  expect(() => assertPublicReleaseAsset(Buffer.from(["sync", "mkna", "ca"].join(".")), []))
    .toThrow("forbidden private identifier");
  const token = `${["github", "pat"].join("_")}_abcdefghijklmnopqrstuvwxyz_123456789`;
  expect(() => assertPublicReleaseAsset(Buffer.from(token), []))
    .toThrow("forbidden private identifier");
});

test("standalone release assets accept neutral deterministic build paths", () => {
  expect(() => assertPublicReleaseAsset(
    Buffer.from("/private/tmp/blackglass-bridge-standalone-source/node_modules/example"),
    [["", "Users", "example", "project"].join("/")],
  )).not.toThrow();
});

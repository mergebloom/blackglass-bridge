import { inspectReleaseRuntimeDependencies } from "./packaging-toolchain";

const dependencies = await inspectReleaseRuntimeDependencies();
console.log(JSON.stringify({
  passed: true,
  dependencies: dependencies.map(({ name, version, lockIntegrity, entrySha256, tree }) => ({
    name, version, lockIntegrity, entrySha256, treeSha256: tree.sha256,
  })),
}, null, 2));

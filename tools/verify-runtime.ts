import { assertPinnedBunVersion, PINNED_BUN_VERSION } from "./packaging-toolchain";

assertPinnedBunVersion();
console.log(`Bun ${PINNED_BUN_VERSION} verified`);

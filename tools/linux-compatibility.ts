import type { TreeIdentity } from "./tree-identity";

export const LINUX_CLIENT_COMPATIBILITY_SCHEMA_VERSION = 1;

export interface LinuxClientCompatibility {
  schemaVersion: typeof LINUX_CLIENT_COMPATIBILITY_SCHEMA_VERSION;
  rendererVersion: "1.13.4";
  architecture: "amd64" | "arm64";
  upstreamArchive: {
    fileName: string;
    rootDirectory: string;
    sha256: string;
  };
  runtimeTree: TreeIdentity;
  rendererAsarSha256: string;
  wrapperAsarSha256: string;
  executableSha256: string;
  cliExecutableSha256: string;
}

const common = {
  schemaVersion: LINUX_CLIENT_COMPATIBILITY_SCHEMA_VERSION,
  rendererVersion: "1.13.4",
  rendererAsarSha256: "51218495ad940a8515b202d380bde638be6570a198e121f7ca6d484a8a158917",
  wrapperAsarSha256: "b03a1a57dc8e1816332a01416b8e8a6657578745957a376b31c66342569f8835",
} as const;

export const LINUX_CLIENT_COMPATIBILITY: Record<"amd64" | "arm64", LinuxClientCompatibility> = {
  amd64: {
    ...common,
    architecture: "amd64",
    upstreamArchive: {
      fileName: "obsidian-1.13.4.tar.gz",
      rootDirectory: "obsidian-1.13.4",
      sha256: "ebac249f949b6894819fbb4bc5657ec8892f006cefed955d34a6c1ffe262f16b",
    },
    runtimeTree: {
      formatVersion: 1,
      sha256: "8d5bc99994c2a74feb4456b47cb79a2a1e7e4fdf63e1d01f459c762ce6145b86",
      entries: 89,
      files: 83,
      directories: 6,
      symlinks: 0,
      fileBytes: 352_380_378,
    },
    executableSha256: "65c6f106efc985a902b75fab26b2537d9a49d2536ca2e14d0d1009fb1851ab41",
    cliExecutableSha256: "55593b4a4da034b73a3678de1aed4dba7a7f24b86adae592ef4cdbcc5ebc905b",
  },
  arm64: {
    ...common,
    architecture: "arm64",
    upstreamArchive: {
      fileName: "obsidian-1.13.4-arm64.tar.gz",
      rootDirectory: "obsidian-1.13.4-arm64",
      sha256: "e2d44d26369bd035e1ad58f63113073fb791b52f4c26cce22ced63b492a7136e",
    },
    runtimeTree: {
      formatVersion: 1,
      sha256: "2cc3947bde5ab806e3b75b988b8623a11c638e793844906ff16f455296935d72",
      entries: 89,
      files: 83,
      directories: 6,
      symlinks: 0,
      fileBytes: 353_874_890,
    },
    executableSha256: "ec57bae645ff346e00bb680f75ade96cc201cb1a22b14ed9ade64ce7e71b0b37",
    cliExecutableSha256: "8b83fd6d81945cf53909a5f78608da105f9cd0de1d568c2d1270670e07505347",
  },
};

export function linuxArchitecture(): "amd64" | "arm64" {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`Unsupported Linux client architecture: ${process.arch}`);
}

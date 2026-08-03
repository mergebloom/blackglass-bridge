const forbiddenIdentity = ["bea", "ini"].join("");
const forbiddenDomain = ["mkna", "ca"].join(".");
const privateWorkspace = ["", "Users", "m", "Software", ""].join("/");

export function assertPublicReleaseAsset(
  bytes: Uint8Array,
  forbiddenSourceRoots: readonly string[],
): void {
  const text = Buffer.from(bytes).toString("latin1");
  const forbidden = [
    new RegExp(forbiddenIdentity, "iu"),
    new RegExp(`(?:[a-z0-9-]+\\.)*${forbiddenDomain.replace(".", "\\.")}`, "iu"),
    new RegExp(escapeRegExp(privateWorkspace), "u"),
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) {
    throw new Error("Standalone release asset contains a forbidden private identifier or secret");
  }
  for (const root of forbiddenSourceRoots) {
    if (root.length > 1 && text.includes(root)) {
      throw new Error("Standalone release asset contains its local source path");
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

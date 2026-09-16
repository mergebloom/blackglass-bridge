export async function embeddedAssetBytes(path: string): Promise<Buffer> {
  const asset = Bun.file(path);
  if (!await asset.exists()) throw new Error(`Embedded release asset is unavailable: ${path}`);
  return Buffer.from(await asset.arrayBuffer());
}

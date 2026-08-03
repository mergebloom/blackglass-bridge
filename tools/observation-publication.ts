import { readdir } from "node:fs/promises";
import { join } from "node:path";

export async function assertNoObservationPublicationResidue(root: string): Promise<void> {
  const directory = join(root, "observations");
  const residues = (await readdir(directory, { withFileTypes: true }))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".intent") || name.endsWith(".next"))
    .sort();
  if (residues.length > 0) {
    throw new Error(`Unpublished Sync observation evidence remains: ${residues.join(", ")}`);
  }
}

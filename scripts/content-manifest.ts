import "dotenv/config";
import {
  assertManifestEqual,
  buildContentManifest,
  readManifest,
  writeManifest,
} from "./lib/content-manifest";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const manifest = await buildContentManifest({ blobDir: option("--blob-dir") });
  if (manifest.blobs.missingReferencedKeys.length > 0) {
    throw new Error(`Missing referenced blobs: ${manifest.blobs.missingReferencedKeys.join(", ")}`);
  }
  const compare = option("--compare");
  if (compare) assertManifestEqual(manifest, await readManifest(compare));
  const output = option("--output");
  if (output) await writeManifest(output, manifest);
  else process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`manifest OK: ${Object.keys(manifest.tables).length} tables, ${Object.keys(manifest.blobs.files).length} blobs`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

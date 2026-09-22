// Fails (non-zero exit) unless an Android `generate --files` bundle contains
// exactly the previews declared in the file that was asked for.
//
// The regression this guards: harvesting copies the module's whole Roborazzi
// output directory, so PNGs a *previous* `generate` left there used to be
// copied into the new bundle and listed in the manifest as if this run had
// just rendered them. They were byte-identical to the earlier run's images and
// the manifest schema has no timestamp, run id, or other freshness signal — so
// nothing downstream could tell a stale entry from a fresh one. The CI job
// that calls this seeds a stale PNG first; if any of it survives into the
// bundle, the component/state set below will not match.
//
// Usage: node scripts/verify-fresh-android-manifest.mjs <manifest.json> <Component> <State>...
import { readFileSync } from 'node:fs';

const [manifestPath, wantComponent, ...wantStates] = process.argv.slice(2);
if (!manifestPath || !wantComponent || wantStates.length === 0) {
  console.error('usage: verify-fresh-android-manifest.mjs <manifest.json> <Component> <State>...');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = manifest.entries ?? [];

const got = entries.map((e) => `${e.component}/${e.state}`).sort();
const want = wantStates.map((s) => `${wantComponent}/${s}`).sort();

const problems = [];
if (got.length !== want.length) {
  problems.push(`expected exactly ${want.length} entries, got ${got.length}`);
}
for (const w of want) {
  if (!got.includes(w)) problems.push(`missing "${w}"`);
}
for (const g of got) {
  if (!want.includes(g)) {
    problems.push(`unexpected "${g}" — a stale PNG from an earlier run, or the filter widened`);
  }
}

if (problems.length > 0) {
  console.error('Android --files bundle is not exactly this run\'s output:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n  wanted: ${want.join(', ')}`);
  console.error(`  got:    ${got.join(', ')}`);
  console.error('\nFull manifest:', JSON.stringify(manifest, null, 2));
  process.exit(1);
}

console.log(`OK: bundle holds exactly this run's previews (${got.join(', ')}).`);

// Fails (non-zero exit) unless the manifest is exactly what a correctly
// narrowed --files render of Components/UserCard.swift should produce: the
// two named previews declared in that one file, and nothing from the other
// components in the sample app. A manifest with more than two entries would
// mean the filter silently fell back to rendering everything — the exact
// failure this regression test exists to catch.
import { readFileSync } from 'node:fs';

const manifestPath = process.argv[2];
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = manifest.entries ?? [];

const wantStates = new Set(['Default', 'Dark']);
const gotStates = new Set(entries.map((e) => e.state));
const gotComponents = new Set(entries.map((e) => e.component));

const problems = [];
if (entries.length !== 2) {
  problems.push(`expected exactly 2 entries (UserCard's two named previews), got ${entries.length}`);
}
if (gotComponents.size !== 1 || !gotComponents.has('User Card')) {
  problems.push(`expected every entry's component to be "User Card" (Phonebook's humanized form of the UserCard struct name), got: ${[...gotComponents].join(', ')}`);
}
for (const want of wantStates) {
  if (!gotStates.has(want)) problems.push(`missing the "${want}" state`);
}

if (problems.length > 0) {
  console.error('--files did not narrow to the requested file\'s named previews:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nFull manifest:', JSON.stringify(manifest, null, 2));
  process.exit(1);
}

console.log(`OK: --files narrowed correctly to UserCard's 2 named previews (${[...gotStates].sort().join(', ')}).`);

#!/usr/bin/env node
// The version is written in three places: package.json, and server.json twice
// (once for the server, once for the npm package it points at). They are only
// meaningful if they agree — a stale server.json publishes fine to npm and is
// then rejected by the MCP registry as a duplicate, which is how 0.1.2 failed.
//
// Run by CI on every push, and by the release workflow after it bumps.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

const found = [
  ['package.json version', pkg.version],
  ['server.json version', server.version],
  ...(server.packages ?? []).map((p, i) => [`server.json packages[${i}].version`, p.version]),
];

const disagree = found.filter(([, value]) => value !== pkg.version);
if (disagree.length > 0) {
  console.error(`Version mismatch. package.json says ${pkg.version}, but:`);
  for (const [where, value] of disagree) console.error(`  ${where} = ${value}`);
  console.error('\nRelease with the Release workflow, which writes all three together.');
  process.exit(1);
}

console.log(`All ${found.length} version fields agree: ${pkg.version}`);

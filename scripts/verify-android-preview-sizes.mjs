#!/usr/bin/env node
// Renders the Android sample (with PreviewSizeProbe.kt copied in) and checks
// each probe's image size. Usage:
//   node scripts/verify-android-preview-sizes.mjs <outDir> <defaultW>x<defaultH> [configuredW]x[configuredH]
// With a configured size, it is set as android.defaultPreviewSize and the
// full-screen probe must render at it; otherwise at the expected default.
import { loadConfig } from '../dist/config.js';
import { generateAndroid } from '../dist/engines/android.js';

const [outDir, expectedArg, configuredArg] = process.argv.slice(2);
const parse = (s) => s.split('x').map(Number);
const [fullW, fullH] = parse(expectedArg);

const { config, projectDir } = await loadConfig('samples/android');
if (configuredArg) {
  const [widthDp, heightDp] = parse(configuredArg);
  config.android = { ...config.android, defaultPreviewSize: { widthDp, heightDp } };
}
const manifest = await generateAndroid(config, projectDir, outDir);

const sizeOf = (name) => {
  const entry = manifest.entries.find((e) => e.previewName.includes(name));
  if (!entry) throw new Error(`Missing ${name} preview`);
  return [entry.width, entry.height];
};

const failures = [];
for (const [name, expected] of [
  ['DefaultViewportProbe', [fullW, fullH]],
  ['SizeViewportProbe', [240, 400]],
  ['DeviceViewportProbe', [240, 400]],
]) {
  const actual = sizeOf(name);
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
    failures.push(`${name}: expected ${expected.join('x')}, got ${actual.join('x')}`);
  }
}
// A wrap-content preview keeps its own size, as in Android Studio.
const [badgeW, badgeH] = sizeOf('StatusBadgeSuccess');
if (badgeW >= fullW || badgeH >= fullH) {
  failures.push(`StatusBadgeSuccess should wrap its content, got ${badgeW}x${badgeH}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`OK: full-screen preview ${fullW}x${fullH}, explicit sizes kept, badge ${badgeW}x${badgeH}.`);

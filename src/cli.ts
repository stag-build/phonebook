#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { generateAndroid } from './engines/android.js';
import { generateIos } from './engines/ios.js';
import { buildSite } from './site/build.js';

const program = new Command();

program
  .name('phonebook')
  .description('Static component gallery generated from native preview screenshots');

program
  .command('generate')
  .description('Render all previews and produce a bundle (manifest + images)')
  .option('-C, --dir <dir>', 'project directory containing phonebook.config.json', '.')
  .option('-o, --output <dir>', 'bundle output directory (default from config, else phonebook-out)')
  .action(async (opts: { dir: string; output?: string }) => {
    const { config, projectDir } = await loadConfig(opts.dir);
    const outputDir = resolve(projectDir, opts.output ?? config.output ?? 'phonebook-out');
    const generate = config.platform === 'android' ? generateAndroid : generateIos;
    const manifest = await generate(config, projectDir, outputDir);
    console.log(`Recorded ${manifest.entries.length} previews -> ${outputDir}`);
  });

program
  .command('build')
  .description('Build the static gallery site from a bundle')
  .argument('<bundle>', 'bundle directory produced by `phonebook generate`')
  .option('-o, --output <dir>', 'site output directory', 'phonebook-site')
  .action(async (bundle: string, opts: { output: string }) => {
    const outDir = resolve(opts.output);
    const count = await buildSite(resolve(bundle), outDir);
    console.log(`Built gallery with ${count} screenshots -> ${outDir}/index.html`);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

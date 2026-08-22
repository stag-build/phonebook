#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { generateAndroid } from './engines/android.js';
import { generateIos } from './engines/ios.js';
import { buildSite } from './site/build.js';
import { runMcpServer } from './mcp/server.js';

const program = new Command();

program
  .name('phonebook')
  .description('Static component gallery generated from native preview screenshots');

program
  .command('generate')
  .description('Render all previews and produce a bundle (manifest + images)')
  .option('-C, --dir <dir>', 'project directory containing phonebook.config.json', '.')
  .option('-o, --output <dir>', 'bundle output directory (default from config, else phonebook-out)')
  .option(
    '--allow-empty',
    'write an empty manifest (with a warning) instead of failing when no previews are recorded',
    false,
  )
  .action(async (opts: { dir: string; output?: string; allowEmpty: boolean }) => {
    const { config, projectDir } = await loadConfig(opts.dir);
    const outputDir = resolve(projectDir, opts.output ?? config.output ?? 'phonebook-out');
    const generate = config.platform === 'android' ? generateAndroid : generateIos;
    const manifest = await generate(config, projectDir, outputDir, { allowEmpty: opts.allowEmpty });
    console.log(`Recorded ${manifest.entries.length} previews -> ${outputDir}`);
  });

program
  .command('build')
  .description('Build the static gallery site from a bundle')
  .argument(
    '[bundle]',
    'bundle directory produced by `phonebook generate` (default: the output dir from phonebook.config.json)',
  )
  .option('-C, --dir <dir>', 'project directory containing phonebook.config.json', '.')
  .option('-o, --output <dir>', 'site output directory (default: <project>/phonebook-site)')
  .action(async (bundle: string | undefined, opts: { dir: string; output?: string }) => {
    // Running `phonebook build` with no argument in a project directory is the
    // common case right after `generate`: fall back to that project's bundle.
    let bundleDir: string;
    let siteDefaultBase = process.cwd();
    if (bundle) {
      bundleDir = resolve(bundle);
    } else {
      const { config, projectDir } = await loadConfig(opts.dir);
      bundleDir = resolve(projectDir, config.output ?? 'phonebook-out');
      siteDefaultBase = projectDir;
      if (!existsSync(join(bundleDir, 'manifest.json'))) {
        throw new Error(
          `No bundle found at ${bundleDir}. Run \`phonebook generate\` first, ` +
            'or pass a bundle directory explicitly.',
        );
      }
    }
    const outDir = opts.output ? resolve(opts.output) : join(siteDefaultBase, 'phonebook-site');
    const count = await buildSite(bundleDir, outDir);
    console.log(`Built gallery with ${count} screenshots -> ${outDir}/index.html`);
  });

program
  .command('init')
  .description('Detect the platform and scaffold phonebook.config.json')
  .option('-C, --dir <dir>', 'project directory to initialize', '.')
  .action(async (opts: { dir: string }) => {
    await runInit(opts.dir);
  });

program
  .command('doctor')
  .description('Check that the project is correctly set up for `phonebook generate`')
  .option('-C, --dir <dir>', 'project directory containing phonebook.config.json', '.')
  .option('--deep', 'also compile the test sources (slower, catches build-time errors)', false)
  .action(async (opts: { dir: string; deep: boolean }) => {
    const ok = await runDoctor(opts.dir, { deep: opts.deep });
    if (!ok) process.exit(1);
  });

program
  .command('mcp')
  .description('Run the Phonebook MCP server (stdio)')
  .action(async () => {
    await runMcpServer();
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

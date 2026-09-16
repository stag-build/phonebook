import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIos } from './ios.js';
import { changedFiles, scopeReport } from './scope.js';

const run = promisify(execFile);

describe('scopeReport', () => {
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'phonebook-scope-'));
    await mkdir(join(projectDir, 'Sources', 'Cards'), { recursive: true });
    await mkdir(join(projectDir, 'Sources', 'Rows'), { recursive: true });

    await writeFile(
      join(projectDir, 'Sources', 'Cards', 'Card.swift'),
      'import SwiftUI\n\nstruct Card: View {\n  let title: String\n  var body: some View { Text(title) }\n}\n',
    );
    await writeFile(
      join(projectDir, 'Sources', 'Rows', 'Row.swift'),
      'import SwiftUI\n\nstruct Row: View {\n  let title: String\n  var body: some View { Text(title) }\n}\n',
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('reports only the components in the given files', async () => {
    const report = scopeReport(await scanIos(projectDir), ['Sources/Cards/Card.swift']);

    expect(report.components.map((c) => c.name)).toEqual(['Card']);
    expect(report.stats.components).toBe(1);
    expect(report.scope?.componentsScanned).toBe(2);
  });

  it('takes a directory as a prefix', async () => {
    const report = scopeReport(await scanIos(projectDir), ['Sources/Rows']);
    expect(report.components.map((c) => c.name)).toEqual(['Row']);
  });

  // The whole project is still scanned; only the report is narrowed. Enum
  // types, preview helpers and locales are project-wide facts, and a scan
  // that walked only the changed files would get every one of them wrong.
  it('reports the whole project when nothing is named', async () => {
    const report = scopeReport(await scanIos(projectDir), []);
    expect(report.components.map((c) => c.name).sort()).toEqual(['Card', 'Row']);
    expect(report.scope).toBeUndefined();
  });
});

describe('changedFiles', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'phonebook-changed-'));
    await mkdir(join(repoDir, 'Sources'), { recursive: true });
    await writeFile(join(repoDir, 'Sources', 'Kept.swift'), 'struct Kept {}\n');
    await writeFile(join(repoDir, 'Sources', 'Edited.swift'), 'struct Edited {}\n');

    await run('git', ['init', '-q'], { cwd: repoDir });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await run('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    await run('git', ['add', '-A'], { cwd: repoDir });
    await run('git', ['commit', '-qm', 'first'], { cwd: repoDir });

    await appendFile(join(repoDir, 'Sources', 'Edited.swift'), 'struct More {}\n');
    await writeFile(join(repoDir, 'Sources', 'Added.swift'), 'struct Added {}\n');
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('lists edited and untracked files and nothing else', async () => {
    expect((await changedFiles(repoDir)).sort()).toEqual([
      'Sources/Added.swift',
      'Sources/Edited.swift',
    ]);
  });

  it('is empty rather than an error outside a repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'phonebook-norepo-'));
    expect(await changedFiles(plain)).toEqual([]);
    await rm(plain, { recursive: true, force: true });
  });
});

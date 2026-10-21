import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildSettingsError, moduleForFile, workspaceProjects } from './snapshotTestClass.js';

function project(target: string, folder: string): string {
  return `// !$*UTF8*$!
{
	objects = {
		AAAAAAAAAAAAAAAAAAAAAAAA /* target */ = {
			isa = PBXNativeTarget;
			fileSystemSynchronizedGroups = (BBBBBBBBBBBBBBBBBBBBBBBB,);
			name = "${target}";
		};
		BBBBBBBBBBBBBBBBBBBBBBBB /* sources */ = {
			isa = PBXFileSystemSynchronizedRootGroup;
			path = "${folder}";
			sourceTree = "<group>";
		};
	};
}
`;
}

describe('moduleForFile build settings', () => {
  let root: string;
  const app = project('App', 'App');
  const framework = project('DesignKit', 'DesignKit');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phonebook-module-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'xcodebuild'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.PHONEBOOK_TEST_ROOT + '/calls', JSON.stringify(process.argv.slice(2)) + '\\n');
const response = JSON.parse(fs.readFileSync(process.env.PHONEBOOK_TEST_ROOT + '/response', 'utf8'));
process.stdout.write(response.stdout);
process.stderr.write(response.stderr || '');
process.exit(response.code || 0);
`);
    await chmod(join(bin, 'xcodebuild'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('PHONEBOOK_TEST_ROOT', root);
    await mkdir(join(root, 'App.xcworkspace'));
    await mkdir(join(root, 'App.xcodeproj'));
    await mkdir(join(root, 'Libraries', 'DesignKit.xcodeproj'), { recursive: true });
    await writeFile(join(root, 'App.xcodeproj', 'project.pbxproj'), app);
    await writeFile(join(root, 'Libraries', 'DesignKit.xcodeproj', 'project.pbxproj'), framework);
    await writeFile(join(root, 'App.xcworkspace', 'contents.xcworkspacedata'), `<Workspace>
  <FileRef location="group:App.xcodeproj"/>
  <Group location="group:Libraries"><FileRef location="group:DesignKit.xcodeproj"/></Group>
</Workspace>`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function respond(settings: unknown, code = 0, stderr = ''): Promise<void> {
    await writeFile(join(root, 'response'), JSON.stringify({ stdout: typeof settings === 'string' ? settings : JSON.stringify(settings), code, stderr }));
  }

  async function calls(): Promise<string[][]> {
    return (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  }

  it('queries the workspace app through its explicitly resolved project', async () => {
    await respond([{ target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'App', CONFIGURATION: 'Debug' } }]);
    expect(await moduleForFile(app, root, 'App/Card.swift', { workspace: 'App.xcworkspace', scheme: 'App' })).toBe('App');
    expect(await calls()).toEqual([
      ['test', '-showBuildSettings', '-json', '-sdk', 'iphonesimulator', '-workspace', 'App.xcworkspace', '-scheme', 'App'],
      ['-showBuildSettings', '-json', '-sdk', 'iphonesimulator', '-project', join(root, 'App.xcodeproj'), '-target', 'App', '-configuration', 'Debug'],
    ]);
  });

  it('resolves a framework outside the scheme build entries and uses its custom module', async () => {
    await respond([
      { target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'WrongFirstModule', CONFIGURATION: 'Testing' } },
      { target: 'DesignKit', buildSettings: { PRODUCT_MODULE_NAME: 'My_Custom_Module', CONFIGURATION: 'Testing' } },
      { target: 'DesignKitTests', buildSettings: { PRODUCT_MODULE_NAME: 'WrongTestsModule', CONFIGURATION: 'Testing' } },
    ]);
    expect(await moduleForFile(app, root, 'Libraries/DesignKit/Card.swift', { workspace: 'App.xcworkspace', scheme: 'App' })).toBe('My_Custom_Module');
    expect(await calls()).toEqual([
      ['test', '-showBuildSettings', '-json', '-sdk', 'iphonesimulator', '-workspace', 'App.xcworkspace', '-scheme', 'App'],
      ['-showBuildSettings', '-json', '-sdk', 'iphonesimulator', '-project', join(root, 'Libraries', 'DesignKit.xcodeproj'), '-target', 'DesignKit', '-configuration', 'Testing'],
    ]);
  });

  it('keeps project-based selection scoped to the named target', async () => {
    await respond([
      { target: 'Dependency', buildSettings: { PRODUCT_MODULE_NAME: 'WrongFirstModule' } },
      { target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'Renamed_App' } },
    ]);
    expect(await moduleForFile(app, root, 'App/Card.swift', { project: 'App.xcodeproj' })).toBe('Renamed_App');
    expect(await calls()).toEqual([['-showBuildSettings', '-json', '-sdk', 'iphonesimulator', '-project', 'App.xcodeproj', '-target', 'App']]);
  });

  it('resolves files relative to a nested configured project, including spaces', async () => {
    await respond([{ target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'Nested_App' } }]);
    expect(await moduleForFile(app, root, 'Nested App/App/Card.swift', { project: 'Nested App/App.xcodeproj' })).toBe('Nested_App');
    expect(await calls()).toEqual([['-showBuildSettings', '-json', '-sdk', 'iphonesimulator', '-project', 'Nested App/App.xcodeproj', '-target', 'App']]);
  });

  it('caches by owning project and target without running another command', async () => {
    await respond([{ target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'App', CONFIGURATION: 'Debug' } }]);
    const cache = new Map<string, string | undefined>();
    for (const file of ['App/Card.swift', 'App/Button.swift']) {
      expect(await moduleForFile(app, root, file, { workspace: 'App.xcworkspace', scheme: 'App' }, cache)).toBe('App');
    }
    expect(await calls()).toHaveLength(2);
  });

  it.each([
    [[{ target: 'App', buildSettings: {} }], 'configuration-not-found'],
    [[{ target: 'App', buildSettings: { CONFIGURATION: 'Debug' } }, { target: 'AppTests', buildSettings: { CONFIGURATION: 'Testing' } }], 'ambiguous-configuration'],
  ])('rejects missing or inconsistent Test-action configuration', async (settings, reason) => {
    await respond(settings);
    await expect(moduleForFile(app, root, 'App/Card.swift', { workspace: 'App.xcworkspace', scheme: 'App' })).rejects.toMatchObject({ reason });
    expect(await calls()).toHaveLength(1);
  });

  it('does not reuse settings for an identically named target in another project', async () => {
    await writeFile(join(root, 'Libraries', 'DesignKit.xcodeproj', 'project.pbxproj'), project('App', 'DesignKit'));
    const cache = new Map<string, string | undefined>();
    await respond([{ target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'Main_App' } }]);
    expect(await moduleForFile(app, root, 'App/Card.swift', { workspace: 'App.xcworkspace' }, cache)).toBe('Main_App');
    await respond([{ target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'Kit_App' } }]);
    expect(await moduleForFile(app, root, 'Libraries/DesignKit/Card.swift', { workspace: 'App.xcworkspace' }, cache)).toBe('Kit_App');
    expect(await calls()).toHaveLength(2);
  });

  it('preserves a rejected command, status, stdout, stderr, and cause', async () => {
    await respond('partial output\n', 64, 'xcodebuild: error: broken project\n');
    const error = await moduleForFile(app, root, 'App/Card.swift', { project: 'App.xcodeproj' }).catch((error) => error);
    expect(error).toBeInstanceOf(BuildSettingsError);
    expect(error).toMatchObject({ reason: 'command-failed', target: 'App', cwd: root, exitCode: 64, stdout: 'partial output\n', stderr: 'xcodebuild: error: broken project\n' });
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain('"-project" "App.xcodeproj" "-target" "App"');
    expect(error.message).toContain('partial output\n');
    expect(error.message).toContain('xcodebuild: error: broken project\n');
  });

  it('abridges long output in the message but keeps it whole on the error', async () => {
    const stdout = 'x'.repeat(8000);
    await respond(stdout);
    const error = await moduleForFile(app, root, 'App/Card.swift', { project: 'App.xcodeproj' }).catch((error) => error);
    expect(error).toMatchObject({ reason: 'invalid-response', stdout });
    expect(error.message.length).toBeLessThan(5000);
    expect(error.message).toContain('4000 characters omitted');
  });

  it.each([
    ['invalid JSON', 'not JSON', 'invalid-response'],
    ['a non-array response', {}, 'invalid-response'],
    ['a missing target', [{ target: 'Another', buildSettings: { PRODUCT_MODULE_NAME: 'Wrong' } }], 'target-not-found'],
    ['duplicate matching targets', [{ target: 'App' }, { target: 'App' }], 'ambiguous-target'],
    ['a missing module name', [{ target: 'App', buildSettings: {} }], 'module-name-missing'],
    ['an empty module name', [{ target: 'App', buildSettings: { PRODUCT_MODULE_NAME: ' ' } }], 'module-name-missing'],
  ])('fails explicitly for %s', async (_label, settings, reason) => {
    await respond(settings);
    await expect(moduleForFile(app, root, 'App/Card.swift', { project: 'App.xcodeproj' })).rejects.toMatchObject({ reason, exitCode: 0 });
  });

  it('rejects a file compiled by two workspace projects instead of choosing one', async () => {
    await writeFile(join(root, 'Libraries', 'DesignKit.xcodeproj', 'project.pbxproj'), project('OtherApp', '../App'));
    await expect(moduleForFile(app, root, 'App/Card.swift', { workspace: 'App.xcworkspace' })).rejects.toThrow('More than one workspace project compiles');
    await expect(readFile(join(root, 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps missing ownership distinct from build-settings failures', async () => {
    expect(await moduleForFile(app, root, 'Unowned/Card.swift', { workspace: 'App.xcworkspace' })).toBeUndefined();
    await expect(readFile(join(root, 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips a missing or out-of-root workspace project when a readable one owns the file', async () => {
    const external = await mkdtemp(join(tmpdir(), 'phonebook-external-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mkdir(join(external, 'Shared.xcodeproj'));
      await writeFile(join(external, 'Shared.xcodeproj', 'project.pbxproj'), project('Shared', 'Shared'));
      await writeFile(join(root, 'App.xcworkspace', 'contents.xcworkspacedata'), `<Workspace>
  <FileRef location="group:App.xcodeproj"/>
  <FileRef location="group:Pods/Pods.xcodeproj"/>
  <FileRef location="absolute:${join(external, 'Shared.xcodeproj')}"/>
</Workspace>`);
      await respond([{ target: 'App', buildSettings: { PRODUCT_MODULE_NAME: 'App', CONFIGURATION: 'Debug' } }]);
      const cache = new Map<string, string | undefined>();
      for (const file of ['App/Card.swift', 'App/Button.swift']) {
        expect(await moduleForFile(app, root, file, { workspace: 'App.xcworkspace', scheme: 'App' }, cache)).toBe('App');
      }
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        expect.stringContaining('Pods.xcodeproj'),
        expect.stringContaining('outside the selected project directory'),
      ]);
      const commands = (await calls()).map((call) => call.join(' ')).join('\n');
      expect(commands).not.toContain(external);
      expect(commands).not.toContain('Pods');
    } finally {
      warn.mockRestore();
      await rm(external, { recursive: true, force: true });
    }
  });

  it('reports the unreadable project instead of "unowned" when no readable project owns the file', async () => {
    await writeFile(join(root, 'App.xcworkspace', 'contents.xcworkspacedata'), `<Workspace>
  <FileRef location="group:App.xcodeproj"/>
  <FileRef location="group:Pods/Pods.xcodeproj"/>
</Workspace>`);
    await expect(moduleForFile(app, root, 'Unowned/Card.swift', { workspace: 'App.xcworkspace' })).rejects.toThrow(/ENOENT.*Pods\.xcodeproj/);
    await expect(readFile(join(root, 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses project files read earlier in the same run', async () => {
    await respond([{ target: 'DesignKit', buildSettings: { PRODUCT_MODULE_NAME: 'Kit', CONFIGURATION: 'Debug' } }]);
    const selection = { workspace: 'App.xcworkspace', scheme: 'App' };
    const cache = new Map<string, string | undefined>();
    expect(await moduleForFile(app, root, 'Libraries/DesignKit/Card.swift', selection, cache)).toBe('Kit');
    await writeFile(join(root, 'Libraries', 'DesignKit.xcodeproj', 'project.pbxproj'), project('Other', 'Other'));
    expect(await moduleForFile(app, root, 'Libraries/DesignKit/Button.swift', selection, cache)).toBe('Kit');
    expect(await moduleForFile(app, root, 'Libraries/DesignKit/Button.swift', selection)).toBeUndefined();
  });

  it('rejects project metadata symlinks outside the selected root before running commands', async () => {
    const external = await mkdtemp(join(tmpdir(), 'phonebook-external-'));
    try {
      await writeFile(join(external, 'project.pbxproj'), app);
      await rm(join(root, 'App.xcodeproj'), { recursive: true });
      await symlink(external, join(root, 'App.xcodeproj'));
      await expect(moduleForFile(app, root, 'App/Card.swift', { workspace: 'App.xcworkspace' })).rejects.toThrow('outside the selected project directory');
      await expect(readFile(join(root, 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});

describe('workspaceProjects', () => {
  it('handles nested groups, container roots, escaped names, comments, and duplicate refs', () => {
    expect(workspaceProjects(`<Workspace>
      <!-- <FileRef location="group:Ignored.xcodeproj"/> -->
      <Group location="group:Libraries &amp; Kits">
        <FileRef location="group:DesignKit.xcodeproj"/>
        <FileRef location="container:App.xcodeproj"/>
      </Group>
      <FileRef location="group:App.xcodeproj"/>
    </Workspace>`, '/repo')).toEqual([resolve('/repo/Libraries & Kits/DesignKit.xcodeproj'), resolve('/repo/App.xcodeproj')]);
  });
});

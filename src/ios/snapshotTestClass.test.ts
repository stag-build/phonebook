import { describe, expect, it } from 'vitest';
import { synchronizedGroupOwners, targetForFile } from './snapshotTestClass.js';

/**
 * Raw .pbxproj text, built the way Xcode writes it (tabs, 24-hex ids), since
 * the parser is regex-based and indentation-sensitive by design.
 */
function pbxproj(body: string): string {
  return `// !$*UTF8*$!\n{\n\tobjects = {${body}\n\t};\n}\n`;
}

const nativeTarget = (id: string, name: string, groupIds: string[]) =>
  `\n\t\t${id} /* ${name} */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tfileSystemSynchronizedGroups = (\n${groupIds
    .map((g) => `\t\t\t\t${g} /* group */,\n`)
    .join('')}\t\t\t);\n\t\t\tname = ${name};\n\t\t};`;

const syncGroup = (id: string, path: string, exceptionIds: string[] = []) =>
  `\n\t\t${id} /* ${path} */ = {\n\t\t\tisa = PBXFileSystemSynchronizedRootGroup;\n${
    exceptionIds.length > 0
      ? `\t\t\texceptions = (\n${exceptionIds.map((e) => `\t\t\t\t${e} /* exception */,\n`).join('')}\t\t\t);\n`
      : ''
  }\t\t\tpath = ${path};\n\t\t\tsourceTree = "<group>";\n\t\t};`;

const exceptionSet = (id: string, targetId: string, members: string[]) =>
  `\n\t\t${id} /* Exceptions */ = {\n\t\t\tisa = PBXFileSystemSynchronizedBuildFileExceptionSet;\n\t\t\tmembershipExceptions = (\n${members
    .map((m) => `\t\t\t\t${m},\n`)
    .join('')}\t\t\t);\n\t\t\ttarget = ${targetId} /* App */;\n\t\t};`;

const APP = 'AAAAAAAAAAAAAAAAAAAAAAAA';
const APP_GROUP = 'BBBBBBBBBBBBBBBBBBBBBBBB';
const KIT = 'CCCCCCCCCCCCCCCCCCCCCCCC';
const KIT_GROUP = 'DDDDDDDDDDDDDDDDDDDDDDDD';
const EXCEPTION = 'EEEEEEEEEEEEEEEEEEEEEEEE';

describe('targetForFile', () => {
  it('matches a file inside one target’s synchronized folder', () => {
    const project = pbxproj(nativeTarget(APP, 'App', [APP_GROUP]) + syncGroup(APP_GROUP, 'App'));
    expect(targetForFile(project, 'App/Views/UserCard.swift')).toBe('App');
  });

  it('prefers the longest matching folder when folders nest across targets', () => {
    const project = pbxproj(
      nativeTarget(APP, 'App', [APP_GROUP]) +
        nativeTarget(KIT, 'DesignKit', [KIT_GROUP]) +
        syncGroup(APP_GROUP, 'App') +
        syncGroup(KIT_GROUP, 'App/DesignKit'),
    );
    expect(targetForFile(project, 'App/DesignKit/Button.swift')).toBe('DesignKit');
    expect(targetForFile(project, 'App/Views/UserCard.swift')).toBe('App');
  });

  it('falls through a file excepted from the folder’s target', () => {
    const project = pbxproj(
      nativeTarget(APP, 'App', [APP_GROUP]) +
        syncGroup(APP_GROUP, 'App', [EXCEPTION]) +
        exceptionSet(EXCEPTION, APP, ['Views/UserCard.swift']),
    );
    expect(targetForFile(project, 'App/Views/UserCard.swift')).toBeUndefined();
    expect(targetForFile(project, 'App/Views/Other.swift')).toBe('App');
  });

  it('reports no target for a project without synchronized folders', () => {
    const project = pbxproj(
      '\n\t\t' + APP + ' /* App */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tname = App;\n\t\t};',
    );
    expect(synchronizedGroupOwners(project)).toEqual([]);
    expect(targetForFile(project, 'App/Views/UserCard.swift')).toBeUndefined();
  });
});

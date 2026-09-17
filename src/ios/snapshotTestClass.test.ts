import { describe, expect, it } from 'vitest';
import {
  fileReferencePaths,
  sourcesBuildPhaseOwner,
  synchronizedGroupOwners,
  targetForFile,
} from './snapshotTestClass.js';

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

/**
 * A classic project: no synchronized folders, files listed one by one through
 * PBXBuildFile entries in a target's sources phase.
 *
 * This is what XcodeGen and Tuist generate and what every project predating
 * Xcode 16 uses, so the layout below is copied from a real one rather than
 * idealized — in particular PBXFileReference and PBXBuildFile are written whole
 * on a single line while groups and targets get a line per field, which is the
 * detail that made the parser see a project with 28 groups and no files at all.
 */
const fileRef = (id: string, name: string) =>
  `\n\t\t${id} /* ${name} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${name}; sourceTree = "<group>"; };`;

const buildFile = (id: string, refId: string, name: string) =>
  `\n\t\t${id} /* ${name} in Sources */ = {isa = PBXBuildFile; fileRef = ${refId} /* ${name} */; };`;

const group = (id: string, path: string | undefined, childIds: string[]) =>
  `\n\t\t${id} /* ${path ?? 'root'} */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n${childIds
    .map((c) => `\t\t\t\t${c} /* child */,\n`)
    .join('')}\t\t\t);\n${path ? `\t\t\tpath = ${path};\n` : ''}\t\t\tsourceTree = "<group>";\n\t\t};`;

const sourcesPhase = (id: string, buildFileIds: string[]) =>
  `\n\t\t${id} /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tfiles = (\n${buildFileIds
    .map((b) => `\t\t\t\t${b} /* file in Sources */,\n`)
    .join('')}\t\t\t);\n\t\t};`;

const classicTarget = (id: string, name: string, phaseIds: string[]) =>
  `\n\t\t${id} /* ${name} */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildPhases = (\n${phaseIds
    .map((p) => `\t\t\t\t${p} /* Sources */,\n`)
    .join('')}\t\t\t);\n\t\t\tname = ${name};\n\t\t};`;

const ROOT = '111111111111111111111111';
const SOURCES_GROUP = '222222222222222222222222';
const VIEWS_GROUP = '333333333333333333333333';
const CARD_REF = '444444444444444444444444';
const CARD_BUILD = '555555555555555555555555';
const PHASE = '666666666666666666666666';
const CLASSIC_APP = '777777777777777777777777';

/** One app target compiling Sources/Views/UserCard.swift, the classic way. */
function classicProject(): string {
  return pbxproj(
    group(ROOT, undefined, [SOURCES_GROUP]) +
      group(SOURCES_GROUP, 'Sources', [VIEWS_GROUP]) +
      group(VIEWS_GROUP, 'Views', [CARD_REF]) +
      fileRef(CARD_REF, 'UserCard.swift') +
      buildFile(CARD_BUILD, CARD_REF, 'UserCard.swift') +
      sourcesPhase(PHASE, [CARD_BUILD]) +
      classicTarget(CLASSIC_APP, 'App', [PHASE]),
  );
}

describe('fileReferencePaths', () => {
  // A file reference carries only its own last component; the rest comes from
  // the groups above it. Walking down is what makes a group with no path — a
  // navigator-only folder that is not on disk — contribute nothing.
  it('builds each file’s path from the groups above it', () => {
    expect([...fileReferencePaths(classicProject()).values()]).toEqual([
      'Sources/Views/UserCard.swift',
    ]);
  });

  // The detail that made this necessary: PBXFileReference is written on one
  // line, so a parser anchored on a newline before `isa` finds none of them.
  it('reads entries written on a single line', () => {
    expect(fileReferencePaths(classicProject()).size).toBe(1);
  });
});

describe('sourcesBuildPhaseOwner', () => {
  it('finds the target whose sources phase compiles the file', () => {
    expect(sourcesBuildPhaseOwner(classicProject(), 'Sources/Views/UserCard.swift')).toBe('App');
  });

  it('is undefined for a file no target compiles', () => {
    expect(sourcesBuildPhaseOwner(classicProject(), 'Sources/Views/Other.swift')).toBeUndefined();
  });
});

describe('targetForFile on a classic project', () => {
  // The whole point. A project with no synchronized folders used to resolve to
  // no target at all, which made every --files render widen to the entire
  // project — silently, on every XcodeGen and Tuist repository there is.
  it('resolves a file that no synchronized folder covers', () => {
    expect(targetForFile(classicProject(), 'Sources/Views/UserCard.swift')).toBe('App');
  });

  // Synchronized folders still win where they exist: they are the more
  // specific statement, and a project can carry both as it migrates.
  it('prefers a synchronized folder over the build phase', () => {
    const project = pbxproj(
      nativeTarget(APP, 'App', [APP_GROUP]) +
        syncGroup(APP_GROUP, 'Sources') +
        group(ROOT, undefined, [SOURCES_GROUP]) +
        group(SOURCES_GROUP, 'Sources', [VIEWS_GROUP]) +
        group(VIEWS_GROUP, 'Views', [CARD_REF]) +
        fileRef(CARD_REF, 'UserCard.swift') +
        buildFile(CARD_BUILD, CARD_REF, 'UserCard.swift') +
        sourcesPhase(PHASE, [CARD_BUILD]) +
        classicTarget(CLASSIC_APP, 'Legacy', [PHASE]),
    );
    expect(targetForFile(project, 'Sources/Views/UserCard.swift')).toBe('App');
  });
});

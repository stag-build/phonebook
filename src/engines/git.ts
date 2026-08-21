import { spawn } from 'node:child_process';

/** Best-effort git metadata for the manifest; absent outside a git repo. */
export async function gitInfo(projectDir: string): Promise<{ commit?: string }> {
  const commit = await new Promise<string | undefined>((res) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: projectDir });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => res(undefined));
    child.on('exit', (code) => res(code === 0 ? out.trim() : undefined));
  });
  return commit ? { commit } : {};
}

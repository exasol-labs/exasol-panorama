import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import type { ClaudeEnvironment } from './claude.js';

/**
 * The real machine.
 *
 * The one place in the agent interface that touches the user's own files and
 * starts their programs, kept apart from everything that decides *whether* to —
 * so that the deciding can be tested, and this cannot be reached by accident.
 */

const looked = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const runCommand = (
  command: string,
  args: readonly string[],
): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
        output: `${stdout}${stderr}`,
      });
    });
  });

export const nodeClaudeEnvironment = (): ClaudeEnvironment => ({
  platform: platform(),
  home: homedir(),
  /**
   * Where a command is, asked of the shell that would run it.
   *
   * `which` rather than walking the PATH here: a login shell has a PATH that a
   * development server started from an editor may not, and the answer wanted is
   * "could a person run this", not "could this process".
   */
  find: async (command): Promise<string | null> => {
    const result = await runCommand(platform() === 'win32' ? 'where' : 'which', [command]);
    const first = result.output.split('\n')[0]?.trim() ?? '';
    return result.code === 0 && first !== '' ? first : null;
  },
  exists: looked,
  readFile: async (path): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  writeFile: async (path, contents): Promise<void> => {
    await writeFile(path, contents, 'utf8');
  },
  run: runCommand,
  start: (command, args): Promise<void> => {
    // Detached and unreferenced: what is being started outlives the request
    // that asked for it, and must not keep the dev server alive either.
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
    child.unref();
    return Promise.resolve();
  },
});

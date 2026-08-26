import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeClaudeEnvironment } from '../src/node-environment.js';

/**
 * The adapter onto the real machine.
 *
 * Everything else about finding and starting Claude is tested against a machine
 * that is not this one — which leaves this file, whose whole job is to be the
 * real one. So it is exercised against things this machine certainly has: the
 * program running the test, a directory it may write to, and a command that
 * does not exist.
 */

const machine = nodeClaudeEnvironment();
let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'panorama-agent-env-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the real machine', () => {
  it('knows where it is and who it belongs to', () => {
    expect(machine.platform).not.toBe('');
    expect(machine.home).not.toBe('');
  });

  it('finds a command that is there, and does not invent one that is not', async () => {
    // Node is running this test, so it is certainly on the PATH.
    const found = await machine.find('node');
    expect(found).not.toBeNull();
    expect(found).toContain('node');
    expect(await machine.find('panorama-definitely-not-a-command')).toBeNull();
  });

  it('looks for a file without minding that it is missing', async () => {
    expect(await machine.exists(directory)).toBe(true);
    expect(await machine.exists(join(directory, 'nothing'))).toBe(false);
  });

  it('reads a file, and answers nothing for one that is not there', async () => {
    const path = join(directory, 'config.json');
    await machine.writeFile(path, '{"mcpServers":{}}\n');
    expect(await machine.readFile(path)).toBe('{"mcpServers":{}}\n');
    expect(await machine.readFile(join(directory, 'absent.json'))).toBeNull();
    // Written where it was asked, and readable by anything else too.
    expect(await readFile(path, 'utf8')).toContain('mcpServers');
  });

  it('runs a command and says how it went', async () => {
    const said = await machine.run('node', ['-e', 'process.stdout.write("paired")']);
    expect(said).toEqual({ code: 0, output: 'paired' });
    const failed = await machine.run('node', ['-e', 'process.stderr.write("no"); process.exit(3)']);
    expect(failed.code).toBe(3);
    expect(failed.output).toContain('no');
  });

  it('starts something and lets go of it', async () => {
    // Detached and unreferenced, so what it starts cannot keep this process — or
    // the development server — alive.
    const path = join(directory, 'started.txt');
    await machine.start('node', [
      '-e',
      `require("fs").writeFileSync(${JSON.stringify(path)}, "hi")`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await machine.readFile(path)).toBe('hi');
  });
});

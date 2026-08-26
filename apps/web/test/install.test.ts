import { describe, expect, it } from 'vitest';
import {
  SERVICE_WORKER_PATH,
  SERVICE_WORKER_SCOPE,
  registerShell,
} from '../src/panorama/install.js';

describe('registering the shell', () => {
  it('registers the worker at the root, so it controls the whole application', async () => {
    const calls: { path: string; scope: string }[] = [];
    const outcome = await registerShell({
      enabled: true,
      host: {
        serviceWorker: {
          async register(path, options) {
            calls.push({ path, scope: options.scope });
            return {};
          },
        },
      },
    });
    expect(outcome).toBe('registered');
    expect(calls).toEqual([{ path: SERVICE_WORKER_PATH, scope: SERVICE_WORKER_SCOPE }]);
  });

  it('does nothing in development, where a cache in front of the dev server lies', async () => {
    let asked = false;
    const outcome = await registerShell({
      enabled: false,
      host: {
        serviceWorker: {
          async register() {
            asked = true;
            return {};
          },
        },
      },
    });
    expect(outcome).toBe('disabled');
    expect(asked).toBe(false);
  });

  it('says so, quietly, where the browser has no service workers', async () => {
    expect(await registerShell({ enabled: true, host: {} })).toBe('unsupported');
    expect(await registerShell({ enabled: true })).toBe('unsupported');
  });

  /**
   * A refusal is normal: a private window, a policy, an origin that is not
   * secure. The application works without a worker, so the only thing that must
   * not happen is a rejected promise nobody is waiting on.
   */
  it('reports a refusal and carries on', async () => {
    const problems: unknown[] = [];
    const outcome = await registerShell({
      enabled: true,
      host: {
        serviceWorker: {
          register: async () => {
            throw new Error('The operation is insecure');
          },
        },
      },
      onProblem: (error) => problems.push(error),
    });
    expect(outcome).toBe('failed');
    expect((problems[0] as Error).message).toBe('The operation is insecure');
  });

  it('swallows a refusal nobody asked to hear about', async () => {
    const outcome = await registerShell({
      enabled: true,
      host: {
        serviceWorker: {
          register: async () => {
            throw new Error('blocked');
          },
        },
      },
    });
    expect(outcome).toBe('failed');
  });
});

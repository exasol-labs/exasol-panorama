import { describe, expect, it } from 'vitest';
import { SERVICE_WORKER_FILE, registerShell } from '../src/panorama/install.js';

describe('registering the shell', () => {
  const registrarRecording = (
    calls: { path: string; scope: string }[],
  ): {
    serviceWorker: { register: (path: string, options: { scope: string }) => Promise<object> };
  } => ({
    serviceWorker: {
      async register(path, options) {
        calls.push({ path, scope: options.scope });
        return {};
      },
    },
  });

  it('registers the worker beside the document, so it controls the whole application', async () => {
    const calls: { path: string; scope: string }[] = [];
    const outcome = await registerShell({ enabled: true, host: registrarRecording(calls) });
    expect(outcome).toBe('registered');
    expect(calls).toEqual([{ path: `/${SERVICE_WORKER_FILE}`, scope: '/' }]);
  });

  /**
   * A worker can only claim the directory it is served from. Registering `/` from
   * a page under a path is refused by the browser outright, and fetching
   * `/service-worker.js` there would fetch whatever is at the origin's root —
   * somebody else's application, on a host with more than one.
   */
  it('registers under the path the build was served from', async () => {
    const calls: { path: string; scope: string }[] = [];
    await registerShell({
      enabled: true,
      base: '/exasol-panorama/',
      host: registrarRecording(calls),
    });
    expect(calls).toEqual([
      { path: `/exasol-panorama/${SERVICE_WORKER_FILE}`, scope: '/exasol-panorama/' },
    ]);
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

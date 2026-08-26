import { describe, expect, it } from 'vitest';
import type { ConfigEnv, UserConfig } from 'vite';
import config from '../vite.config.js';

/**
 * The startup connection is injected at build time, which puts a password one
 * mistake away from a deployable artifact. The mistake is ruled out here rather
 * than remembered: a build is handed a literal `null`, whatever the environment
 * happens to hold.
 */

const resolve = (env: ConfigEnv, environment: Record<string, string>): UserConfig => {
  const previous = { ...process.env };
  Object.assign(process.env, environment);
  try {
    const factory = config as unknown as (given: ConfigEnv) => UserConfig;
    return factory(env);
  } finally {
    for (const key of Object.keys(environment)) delete process.env[key];
    Object.assign(process.env, previous);
  }
};

const SECRETS = {
  PANORAMA_EXASOL_URL: 'wss://db.internal:8563',
  PANORAMA_EXASOL_USER: 'analyst',
  PANORAMA_EXASOL_PASSWORD: 'hunter2',
};

describe('injecting the startup connection', () => {
  it('hands a build a literal null, secrets in the environment or not', () => {
    const built = resolve({ command: 'build', mode: 'production' }, SECRETS);
    const injected = built.define?.['__PANORAMA_STARTUP__'];
    expect(injected).toBe('null');
    expect(JSON.stringify(injected)).not.toContain('hunter2');
  });

  it('gives the dev server the details it was started with', () => {
    const served = resolve({ command: 'serve', mode: 'development' }, SECRETS);
    const injected = served.define?.['__PANORAMA_STARTUP__'];
    expect(typeof injected).toBe('string');
    expect(JSON.parse(injected as string)).toMatchObject({
      url: 'wss://db.internal:8563',
      username: 'analyst',
      autoConnect: true,
    });
  });

  it('gives the dev server null when nothing was configured', () => {
    const served = resolve({ command: 'serve', mode: 'development' }, {});
    expect(JSON.parse(served.define?.['__PANORAMA_STARTUP__'] as string)).toBeNull();
  });
});

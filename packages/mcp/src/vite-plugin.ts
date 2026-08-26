import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentEndpointOptions } from './http.js';
import { createAgentEndpoint } from './http.js';
import { MCP_PATH } from './link.js';
import { nodeClaudeEnvironment } from './node-environment.js';
import { SKILL_PATH, skillText } from './skill.js';

/**
 * The agent interface as a development-server plugin.
 *
 * Typed structurally rather than against Vite's own `Plugin`, so this file
 * imports nothing from Vite: the package is imported by the page as well, and a
 * bundler asked to follow `vite` into a browser bundle would be right to
 * complain.
 *
 * Development only, and deliberately: an interface that can edit the document
 * belongs where the document is being worked on, next to the dev server that is
 * already serving it, and nowhere near a deployed page.
 */

export interface DevServerLike {
  readonly middlewares: {
    use(
      handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void,
    ): void;
  };
  /** Asked for the port actually bound, which is not always the one configured. */
  readonly httpServer?: { address(): { readonly port: number } | string | null } | null;
}

export interface AgentPlugin {
  readonly name: string;
  readonly apply: 'serve';
  configureServer(server: DevServerLike): void;
}

/**
 * The skill, read from the document that is its source.
 *
 * Read here because this is the file that knows it is running on somebody's
 * computer, and read on demand rather than once: nothing restarts a development
 * server when a document changes, and a skill that went stale on an edit would
 * make "editing the documentation is editing what agents are told" untrue.
 *
 * `null` where it cannot be read — a package installed without its docs beside it
 * — and the endpoint then offers no skill rather than an empty one.
 *
 * Where to look is a parameter, defaulting to the repository as this file sees it.
 */
export const readSkill = (from = new URL('../../../', import.meta.url)): string | null => {
  try {
    return skillText(readFileSync(fileURLToPath(new URL(SKILL_PATH, from)), 'utf8'));
  } catch {
    return null;
  }
};

/** The stdio pipe, as an absolute path, since a paired client is told where it is. */
export const bridgeScriptPath = (): string =>
  fileURLToPath(new URL('../bin/panorama-agent.mjs', import.meta.url));

export interface AgentPluginOptions extends AgentEndpointOptions {
  /** The port the dev server is on, which is what a paired client is pointed at. */
  readonly port?: number;
}

export const panoramaAgent = (options: AgentPluginOptions = {}): AgentPlugin => ({
  name: 'panorama-agent',
  apply: 'serve',
  configureServer: (server): void => {
    /**
     * The port as bound, asked each time rather than read once: `configureServer`
     * runs before the server listens, and `--port` on the command line beats
     * anything the configuration said.
     */
    const port = (): number => {
      const bound = server.httpServer?.address() ?? null;
      return typeof bound === 'object' && bound !== null ? bound.port : (options.port ?? 5173);
    };
    const endpoint = createAgentEndpoint({
      // The machine and the paths are supplied here rather than reached for
      // inside the endpoint: this is the file that knows it is running in a
      // development server on somebody's computer.
      machine: nodeClaudeEnvironment(),
      mcpUrl: () => `http://localhost:${port()}${MCP_PATH}`,
      bridgeScript: bridgeScriptPath(),
      projectPath: process.cwd(),
      // Read when it is asked for, not once at startup: a development server does
      // not restart for a change to documentation, and an agent should be told
      // what the document says now.
      skill: () => readSkill() ?? undefined,
      ...options,
    });
    server.middlewares.use((request, response, next) => {
      endpoint.handle(request, response, next);
    });
  },
});

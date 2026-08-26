#!/usr/bin/env node
/**
 * Model Context Protocol over stdin and stdout, for clients that speak only
 * that, forwarded to the endpoint on the development server.
 *
 * A pipe and nothing else: no state, no protocol knowledge beyond "one JSON
 * value per line", and no imports. The server it forwards to is the one running
 * inside `npm run dev`, because that is the process the application is in and
 * the application is where every answer comes from.
 *
 *   claude mcp add panorama -- node packages/mcp/bin/panorama-agent.mjs
 *
 * Anything that is not the protocol goes to stderr: stdout is the conversation,
 * and a stray line on it would break it.
 */

const url = process.env.PANORAMA_AGENT_URL ?? 'http://localhost:5173/agent/mcp';
const note = (message) => process.stderr.write(`[panorama-agent] ${message}\n`);

/** An error the client can read, in the shape the protocol expects. */
const failure = (id, message) =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32_603, message } });

const forward = async (line) => {
  let id = null;
  try {
    id = JSON.parse(line).id ?? null;
  } catch {
    // Malformed input is the endpoint's to complain about, with its own wording.
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: line,
    });
    // 202 is a notification the endpoint accepted and had nothing to say about.
    if (response.status === 202) return null;
    return (await response.text()).trim();
  } catch (error) {
    return failure(
      id,
      `Could not reach Panorama at ${url}. Is "npm run dev" running? (${String(error)})`,
    );
  }
};

note(`forwarding to ${url}`);
process.stdin.setEncoding('utf8');
let pending = '';
for await (const chunk of process.stdin) {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const answer = await forward(trimmed);
    if (answer !== null && answer !== '') process.stdout.write(`${answer}\n`);
  }
}

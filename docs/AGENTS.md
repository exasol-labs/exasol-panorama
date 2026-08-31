# Driving Panorama with an agent

How to connect an agent to the canvas, in each of the two places Panorama runs,
and what to do when a client cannot see a tool that is there.

What the agent should be told once it is connected is
[AGENT-SKILL.md](AGENT-SKILL.md) — the boxes, the command and history model,
charts and their named data sets, what a picked mark means, cross-filtering, and
which feedback to read first. A second page,
[AGENT-SKILL-CHARTS.md](AGENT-SKILL-CHARTS.md), covers writing an ECharts option
through this canvas, and is read only when one is being written. The server
serves those very files as its first tool, so the documentation you read and the
instructions the agent reads cannot drift apart.

---

## 1. Why it is worth doing

Panorama offers its **live session** to an agent over the Model Context Protocol —
not an export, a screenshot pipe or a replica. **There is no second copy of the
document.** An agent's edits are the same sixteen commands your pointer produces,
applied to the session in the open page. They appear on screen as they are made,
they undo like yours, and they land in the same history graph.

That symmetry is what makes the collaboration direct rather than a game of
telephone:

- **The agent sees what you see.** `overview` reports what is open, which database,
  and where history stands; `entities`, `entity` and `rows` read the boxes and the
  cells that have actually arrived. You never have to describe your canvas to it.
- **You see what the agent did, while it does it.** It opens boxes, labels them,
  wires them together. Disagree with one? Drag it somewhere else, close it, or
  check out the commit before it — the same three gestures you would use on your
  own work.
- **Pictures are measured, not imagined.** An agent cannot see pixels, so a chart
  reports what it actually drew: marks per series, labels that fell outside the
  box, and every channel that named a column the data has not got. "Looked
  plausible, drew nothing" is the failure this closes.
- **Neither side does the other's job.** Heavy work — scanning, aggregating,
  profiling, DDL — belongs on the shortest route to the engine, and the handshake
  ranks those routes and says so. This server is for the canvas: work out what is
  true elsewhere, then put _that_ on the plane, where a person can see it.

Why the interface is shaped this way is in
[ARCHITECTURE.md §9.10](ARCHITECTURE.md#910-the-agent-interface).

## 2. In the desktop application

The installed application carries its own agent endpoint. Nothing else has to be
running — no development server, no Node, no second install — and the file an agent
is pointed at is the file that was installed:

```bash
# macOS
claude mcp add panorama -- "/Applications/Exasol Panorama.app/Contents/MacOS/panorama-desktop" --mcp-stdio
# Windows
claude mcp add panorama -- "C:\Program Files\Exasol Panorama\panorama-desktop.exe" --mcp-stdio
```

That is the whole of the setup. `--mcp-stdio` makes the same binary a Model Context
Protocol pipe on stdin and stdout, and the pipe talks to whichever window is open —
**or opens one.** So an agent can be asked about a canvas that does not exist yet,
and the application appears.

Or press the gear. **Pair with Claude** in the settings panel finds Claude Code and
the desktop client on this machine, registers _this executable_ with both — the
pipe, not a port, so the pairing cannot go stale — and **Open Claude app** starts
it. No terminal, and nothing to paste.

### How it fits together

The shape is the point:

- **The window is the server.** The shell owns a loopback socket and knows nothing
  about the protocol: it takes a message, hands it to the page and returns what the
  page said. The handshake, the catalogue, the sixteen tools and everything they
  mean run in the page, in one copy, the same code the development server calls —
  [`answer.ts`](../packages/mcp/src/answer.ts). There is no second implementation
  to keep in step, and no second opinion about what is on the canvas.
- **Nothing has a port in it.** A running window writes where it is to
  `~/.panorama/sessions/<pid>.json`, and the pipe reads that. Two windows are two
  files; a crashed one is recognised by its pid being gone. Nothing you paste
  anywhere contains a number that can go stale.
- **Only this machine, and only this user.** The socket is bound to loopback, the
  endpoint refuses any request carrying an `Origin` that is not the application's
  own — which is what a web page cannot fake — and every call needs the token from
  the session file. A local page that talks a browser into reaching a local address
  still gets nothing.
- **A client that starts before the application does not open one.** `initialize`
  and `tools/list` are answered from the catalogue the pipe saw last time — a menu,
  never any state — so opening a terminal does not open a window. A real call does.

To see it from outside:

```bash
curl -s localhost:7355/agent/health                       # is anybody home
TOKEN=$(sed -n 's/.*"token": "\([^"]*\)".*/\1/p' ~/.panorama/sessions/*.json)
curl -s -X POST localhost:7355/agent/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
```

## 3. In development

The endpoint is part of the development server, so there is one thing to start:

```bash
npm run dev              # the app, and the agent endpoint with it
```

The repository ships an `.mcp.json`, so a client that reads one — Claude Code does
— finds the server as `panorama` without being told. For anything that speaks only
stdio there is a pipe:

```bash
claude mcp add panorama -- npm run agent
```

Both reach the same place. `curl http://localhost:5173/agent/health` says whether a
session has attached; the page attaches by being open, and nothing else.

The **Settings** panel at the foot of the sidebar shows the endpoint's address,
whether this page is attached and whether anything has asked it a question yet —
and, since the development server is on the same machine as Claude, what Claude
there is on it.

One consequence to know about: a Claude paired through this repository's
`.mcp.json` is pointed at the _development server's_ endpoint, which serves browser
tabs. It will report that nothing is attached while the only thing open is a
desktop window. Pair with the binary, as above, or open the application in a tab.

## 4. The tools

`overview` is where to start — what is open, what is being edited, where the
history stands. `entities`, `entity` and `rows` describe the boxes and read their
cells; `history` is the commit graph; `session` is what is selected. `dispatch`
applies a document command — one, or a list of them — `checkout` moves the history
head, `label` renames a box, and `open_table`, `action`, `query` and `chart` do the
things a document command cannot express on its own. `catalogue` lists the
database. `session_dispatch` changes what is selected, and `skill` is the page
describing all of it.

That page is [AGENT-SKILL.md](AGENT-SKILL.md), and the server serves it three ways:
as the `skill` **tool**, first in the list, which is the one mechanism every client
surfaces; and as the prompt `panorama` and the resource `panorama://skill` for a
client that shows those. Same text every way. The tool is answered by the server
rather than forwarded to the page, so it works before anything is open. There is no
second copy of it in the code, the handshake says to call it first, and a test
insists every tool is written down in it.

There is a **second page** behind the same tool —
`skill(page: "charts")`, the prompt `panorama-charts`, the resource
`panorama://skill/charts` — which is [AGENT-SKILL-CHARTS.md](AGENT-SKILL-CHARTS.md):
which ECharts series come out drawable and which come out inert, how a data set
reaches an option, and the settings this seam silently drops. It is a page of its
own rather than a section of the first because it is three times the length and
answers nothing until an option is being written; the handshake says to read it
then and not before. Its claims are held true by a contract test rather than by
review — a named CSS colour makes the marks vanish, and the day that stops being
so the test says which paragraph is now wrong.

## 5. If an agent cannot see a tool that is there

Almost always the same thing, and it is not on the agent's side: **a client fetches
the tool list once, when it connects, and then shows what it fetched.** So a client
that connected before a tool existed — or while nothing was listening at all, which
looks the same to it — keeps showing the old list however many times the server is
corrected.

Two things to check, in order:

1. **Is the endpoint running?** `curl http://localhost:5173/agent/health`. In
   development it lives on the development server; without `npm run dev` there is
   nothing there, and a client that connected anyway is holding a memory of one.
2. **Which catalogue is the agent looking at?** The handshake stamps it, in
   `serverInfo.version` (`0.1.0+16.850d7b2f`: sixteen tools and a hash of them) and
   again in words at the end of the instructions. Ask the agent what its client
   shows. A different number means a cached list, not a missing tool.

The fix is to reconnect the server in the client — in Claude Code, `/mcp`; in the
desktop application, restart it. The stdio pipe watches the stamp and sends
`notifications/tools/list_changed` when it moves, so a client that honours it is
corrected on its own, including when the server appears after the client did.

To see what a client will actually get, ask the server rather than the code:

```bash
curl -s -X POST http://localhost:5173/agent/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length, .[0].name'
```

## 6. What this server is not for

The handshake ranks the routes to the engine by how far the rows have to travel: a
local `exasol` CLI first where the database is on this machine, a native Exasol MCP
server next, this server for the canvas — and check first that the other route is
the same database.

**A deployed PWA has no agent.** The desktop application carries its own endpoint;
a browser install has nowhere to put one, so in a headset or on a tablet the canvas
is driven by hand. Why, and what the alternatives cost, is in
[`plans/panorama-agent-local-plan.md`](../plans/panorama-agent-local-plan.md).

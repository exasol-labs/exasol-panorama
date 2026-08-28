# Connecting Panorama to a database

Everything about getting rows onto the canvas: the deployments Exasol Personal
manages, certificates a machine signed for itself, and how to hand Panorama a
connection before the page opens.

The [README](../README.md) covers the ordinary case in three sentences. This is
for when the ordinary case is not yours.

---

## 1. Your Exasol Personal deployments

If Exasol Personal is installed, the connection panel has two tabs — **Personal**
and **Manual** — and opens on Personal, because the deployments it lists are the
answer to everything the form would ask. Where the tool is not installed there are
no tabs at all: the form is the only way in, and a single choice presented as a
choice is furniture. Installed with nothing deployed yet is the one in-between
case, and it opens on the form while still offering the tab, so you can see that
the tool is there and has nothing.

The Personal tab lists what Exasol Personal **manages** — not hosts: the same
command installs to this machine or to AWS, Azure, Exoscale or STACKIT, so a
deployment listed here may be running anywhere. Clicking one connects: the address
and user come from `exasol info`, the password from the deployment's own
`secrets.json`, and for a local one the certificate question does not arise
because the address is loopback.

Once connected, the explorer's indicator says the deployment's name rather than an
address, with the address as its tooltip: `agent-alpha` is what you call your
database; `wss://127.0.0.1:58325` is not. A connection typed into the form has no
name to show, so it is identified by its host.

The list is asked for again whenever there is no connection, so starting one with
`exasol start` and coming back finds it.

Nothing about this is in the web build: a page cannot run a command, and a page on
a hosted origin is not on the machine that would. The password is fetched at the
click rather than with the list, so what is drawn, logged or read aloud is names,
statuses and addresses.

### Is it running?

A filled dot, and the tool's own word for it in the row's accessible name. A
deployment that is not running is listed and not clickable — more use than not
listing it, and better than a failure a second later.

**Panorama asks the socket rather than the tool**, and that took finding out.
Three measurements on a machine with six deployments, filed upstream as
[exasol/exasol-personal#309](https://github.com/exasol/exasol-personal/issues/309),
[#310](https://github.com/exasol/exasol-personal/issues/310) and
[#311](https://github.com/exasol/exasol-personal/issues/311):

- `exasol deployments list` called all six `running` while only one had a database
  listening. Its status is unusable.
- `exasol status` knows more — it reports `stopped` and
  `database_connection_failed` correctly — but it also reported _two_ of them as
  `database_ready` at the same `127.0.0.1:8563`, which cannot be true: one process
  holds a port. A stopped deployment's readiness check had found the other's
  database on the port it used to use.
- And it is not reliably quick: about two seconds against a healthy database, but
  _minutes_ against an unreachable one.

So a row is offered when a connection to its address **completes a TLS
handshake** — the question a click actually asks, answered in milliseconds on
loopback and bounded by a two-and-a-half-second timeout elsewhere. A socket that
merely accepts is not enough, and that distinction is not theoretical: a local
deployment is a database inside a VM behind a forwarder on loopback, and the two
fail apart. A forwarder that has lost its route to the guest goes on accepting
connections and resets every one of them, which a socket test calls ready. The
certificate is not checked there — nothing is sent over that connection, and a
local certificate is self-signed — so the question it answers is exactly "is a
database there", and nothing more.

The tool is still asked for its status, with a three-second deadline, because its
words and its sentences beat anything invented here; when it does not answer in
time the row says what the probe found instead. It is checked again at the moment
you click, because a database can stop in between.

So the panel asks three questions rather than one, and shows each answer as it
lands: the names (instant), then which rows can be clicked (a few hundred
milliseconds), then the tool's own words for the rest (seconds, and worth nothing
to somebody who came to connect). Rows are on screen immediately, marked
`checking…`, and become connectable well before the slow answer arrives.

### Two deployments claiming one address

Exasol Personal can install two deployments on the same port, and then `info`
reports that port for both — the stopped one included. The tool cannot say which
is real, and neither can the listening process's command line (`launcher
__daemon__ 2 18432`). But the process table can: the local runner works _inside
its own deployment directory_, so one `lsof` names every deployment with a live
process. The one that has it keeps its address; the others read `port taken` and
are told whose it is. Where that cannot be settled — nothing live, or two live
claimants — both rows read `address conflict` and name the other to stop, because
opening the wrong database under the right name is worse than any refusal.

That answer costs the best part of a second, so it is worked out in the background
as the application starts, remembered for thirty seconds, and asked for **only
when something is actually contested** — a machine with no clash never pays it. It
is also established again, from scratch, at the moment you click.

On Windows it stays refused: working out which deployment is running means asking
the process table what it has open, and `lsof` has no one-line Windows equivalent.

### When a deployment will not open

Symptoms worth telling apart, from a morning spent on exactly this:

| What you see                                | What it usually is                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| The row is greyed out                       | Nothing answered at its address. Start it: `exasol start -d <name>`         |
| `exasol start` says the directory is locked | A lock file left behind by a launcher that did not exit cleanly — see below |
| It connects, then the database is empty     | A different deployment than you think; check the port in the row's tooltip  |

Exasol Personal guards its deployment directory and its artifact cache with lock
_files_, not with OS locks — so a launcher that is killed rather than stopped
leaves them behind and every later `exasol start` refuses. There are two:

```bash
ls -la ~/.exasol/personal/deployments/<name>/.dirmutex.*
ls -la ~/Library/Caches/.exasol/personal/runtime-artifacts/.dirmutex.*
```

Check nothing holds them (`lsof <file>` prints nothing) and that no `exasol`
command is running, then move them aside and start again. The tool's own warning —
"do not use `unlock` unless you are certain that no other launcher is running" —
is worth respecting: that check is the point.

---

## 2. A certificate the machine signed itself

An Exasol Personal on your own machine presents a certificate it signed itself,
and that is the most common local instance there is. What happens next depends
entirely on which Panorama you are running.

### In the desktop application it just works

The socket is opened by the shell rather than by the page, so Panorama can do what
a browser will not: decide about a certificate. The rules, in order —

- A certificate the **system trusts** is used with no ceremony. A managed instance
  or Exasol SaaS never comes up.
- A certificate on **this machine's loopback interface** is accepted without
  asking. Reaching `localhost` means talking to this computer, and a certificate
  is not what stands between you and a program you are already running.
- **Anything else asks you, once**, in a native dialog naming the fingerprint, and
  remembers the answer per host _and_ per certificate in
  `~/.panorama/trusted-certificates.json` — so a certificate that changes asks
  again. Trust on first use, for the same reason `ssh` does it.

Nothing is relaxed quietly. Verification is tried properly first, and the log line
says which of the three answers a connection got:

```
[panorama] connected to localhost:8563 (self-signed certificate, accepted because it is this machine)
```

The socket itself is not a hole in the machine. It is bound to loopback; it
refuses any handshake carrying an `Origin` that is not the application's own — the
header a web page cannot forge — and it needs the token this application generated
at startup, which only its own window is given. Credentials pass through it
encrypted by the page against the key the database offered, exactly as they would
from a browser: the shell moves bytes and could not read them.

### In a browser it does not

And cannot: a browser refuses a `wss://` handshake to a host whose certificate it
does not trust and — unlike a page navigation — never offers to make an exception.
It reports a generic failure. For the development server and the browser install,
the workaround is to trust the certificate in the browser once:

1. Check what the certificate is actually issued for:
   `openssl s_client -connect localhost:8563 -brief </dev/null`
   Exasol's own certificate is usually `CN=localhost`.
2. Open `https://localhost:8563` in a tab and accept the warning. The page will
   not load anything afterwards — the port speaks the database protocol, not
   HTTP — but the exception is recorded.
3. Connect Panorama to **`wss://localhost:8563`**.

Use the _same host_ as the certificate: `localhost` and `127.0.0.1` are different
hosts to a browser, so an exception accepted for one does nothing for the other.

---

## 3. Connection details at startup

Typing a URL and a password is fine at a desk and miserable in a headset, so the
details can be given before the page opens — as environment variables, or in a
`.env.local` at the repository root:

```bash
PANORAMA_EXASOL_URL=wss://db.internal:8563
PANORAMA_EXASOL_USER=analyst
PANORAMA_EXASOL_PASSWORD=…        # or PANORAMA_EXASOL_TOKEN, which wins
PANORAMA_EXASOL_SCHEMA=SALES      # optional: opened once connected
PANORAMA_EXASOL_TABLE=ORDERS
PANORAMA_EXASOL_AUTOCONNECT=0     # optional: prefill, but wait to be asked
```

The names are the ones the Exasol integration tests already use, so one exported
block drives both. A URL alone prefills the form. Add a secret and Panorama
connects on load; name a schema and table too and it opens that table, so a headset
needs no interaction at all.

A secret is never put back into an input: it is used to connect and nothing more. A
password sitting in a form field is readable over a shoulder and recoverable from
the DOM, for no benefit over having connected already.

**These details never reach a build.** They are injected by the development server
only; `npm run build` is handed a literal `null` whatever the environment holds, so
a password cannot be baked into a deployable artifact. There is a test for that,
because it is the kind of guarantee that quietly stops being true.

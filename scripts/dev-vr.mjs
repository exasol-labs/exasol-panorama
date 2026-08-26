import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The dev server, reachable from a headset.
 *
 * WebXR is only offered on a secure page. `http://localhost` counts as secure,
 * which is why the desktop never needed this — but a headset reaching this
 * machine over the network sees a plain LAN address, which does not, and the
 * browser refuses to start a session before Panorama is even asked.
 *
 * Two ways across, because the obvious one is not always available:
 *
 *   `--usb`   The headset is plugged in and `adb` forwards a port, so the page
 *             is `http://localhost` *on the headset*. Nothing crosses the
 *             network, which matters on a machine whose endpoint security drops
 *             inbound connections, and localhost is a secure context already —
 *             no certificate, no warning.
 *
 *   default   Over the network, with a self-signed certificate naming this
 *             machine's current LAN address. The headset warns once, because
 *             nothing has vouched for a certificate a machine made for itself;
 *             accepting it makes the origin secure.
 */

const usb = process.argv.includes('--usb');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const certDir = join(root, 'apps/web/.certs');
const keyFile = join(certDir, 'dev.key');
const certFile = join(certDir, 'dev.crt');

/** This machine's address on the LAN, which is what the headset has to reach. */
const lanAddress = () => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
};

const port = process.env['PANORAMA_VR_PORT'] ?? '5173';

/**
 * Over USB: `adb reverse` makes the *headset's* own localhost reach this
 * machine, so nothing touches the network and the page is a secure context
 * without a certificate.
 */
const startUsb = () => {
  const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const ready = devices.filter((line) => line.endsWith('\tdevice'));
  const unauthorized = devices.filter((line) => line.endsWith('\tunauthorized'));

  if (ready.length === 0) {
    console.error('');
    console.error('  No headset is answering over USB.');
    console.error('');
    if (unauthorized.length > 0) {
      console.error('  One is connected but has not been allowed to debug. Put the');
      console.error('  headset on: there is a prompt asking you to allow USB debugging.');
      console.error('  Accept it (and tick "always allow"), then run this again.');
    } else {
      console.error('  Check that the headset is plugged in with a data-capable USB-C');
      console.error('  cable, is powered on, and has Developer Mode enabled — it is set');
      console.error("  per-device in the Meta Horizon phone app, under the headset's");
      console.error('  settings. Then run this again.');
    }
    console.error('');
    process.exit(1);
  }

  // The headset asks its own localhost; adb carries it down the cable.
  execFileSync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`]);
  const release = () => {
    try {
      execFileSync('adb', ['reverse', '--remove', `tcp:${port}`]);
    } catch {
      // The device may already be gone; nothing left to release.
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(0));

  console.log('');
  console.log('  Panorama over USB');
  console.log('  ─────────────────');
  console.log(`  In the headset's browser, open:  http://localhost:${port}/`);
  console.log('');
  console.log("  That really is the headset's own localhost — adb is carrying it");
  console.log('  down the cable. No certificate and no warning: localhost is already');
  console.log('  a secure context, which is all WebXR asks for.');
  console.log('');
  console.log('  Open a table, then press "Enter XR". The button only appears where a');
  console.log('  headset is on offer, so it stays hidden on the desktop.');
  console.log('');
  return { host: '127.0.0.1', env: {} };
};

/** Over the network: HTTPS, with a certificate naming this machine's address. */
const startNetwork = () => {
  const address = lanAddress();
  if (address === null) {
    console.error('No LAN address found. Connect this machine to the same network as the headset.');
    process.exit(1);
  }

  /**
   * A certificate is regenerated when it does not exist or does not name the
   * current address — a laptop's DHCP lease outlives neither a café nor a
   * reboot, and a certificate for yesterday's address fails in a way that looks
   * like a bug in the app.
   */
  const coversAddress = () => {
    if (!existsSync(certFile)) return false;
    try {
      const text = execFileSync('openssl', ['x509', '-in', certFile, '-noout', '-text'], {
        encoding: 'utf8',
      });
      return text.includes(`IP Address:${address}`);
    } catch {
      return false;
    }
  };

  if (!coversAddress()) {
    mkdirSync(certDir, { recursive: true });
    console.log(`Generating a development certificate for ${address}…`);
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '365',
      '-subj',
      '/CN=Panorama development',
      '-addext',
      `subjectAltName=IP:${address},IP:127.0.0.1,DNS:localhost`,
    ]);
  }
  if (!existsSync(keyFile) || readFileSync(certFile).length === 0) {
    console.error('The development certificate could not be created.');
    process.exit(1);
  }

  console.log('');
  console.log('  Panorama over HTTPS, for a headset on the same network');
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  In the headset's browser, open:  https://${address}:${port}/`);
  console.log('');
  console.log('  The browser will warn that the certificate is not trusted. That is');
  console.log('  expected — nothing vouches for a certificate this machine made for');
  console.log('  itself. Choose Advanced, then Proceed. WebXR needs that acceptance:');
  console.log('  without it the page is not a secure context and refuses to start.');
  console.log('');
  console.log('  If the headset reports an empty response, something between the two');
  console.log('  is dropping the connection — endpoint security on this machine, or');
  console.log('  client isolation on the network. Try `npm run dev:vr -- --usb`, which');
  console.log('  goes down the cable instead and avoids the network entirely.');
  console.log('');
  return {
    host: '0.0.0.0',
    env: { PANORAMA_HTTPS_KEY: keyFile, PANORAMA_HTTPS_CERT: certFile },
  };
};

const { host, env } = usb ? startUsb() : startNetwork();

const vite = spawn('npx', ['vite', '--host', host, '--port', port, '--strictPort', 'apps/web'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ...env },
});
vite.on('exit', (code) => process.exit(code ?? 0));

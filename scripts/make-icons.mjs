/**
 * Draws the application icons.
 *
 * An installed application needs icons, and an icon is the one asset a browser
 * will not improvise: without a 192 and a 512 there is no install prompt at all,
 * and a wrong declared size fails silently. So they are drawn here, from the
 * colours the application already uses, and the result is committed — a build
 * must not depend on having run this, and a reviewer should be able to see what
 * changed. Run it when the drawing or the palette changes:
 *
 *     node scripts/make-icons.mjs
 *
 * `apps/web/test/manifest.test.ts` reads the committed files back and checks that
 * every icon the manifest declares exists and is the size it claims.
 *
 * The PNGs are written by hand rather than by a library: three axis-aligned
 * rectangles and a deflate stream is less to depend on, and less to explain, than
 * an image toolchain in a project that has no other use for one.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../apps/web/public/icons');

/**
 * Where the desktop bundler's source icon goes.
 *
 * `tauri icon` derives the `.icns`, the `.ico` and the sizes each platform's
 * bundler wants from one square PNG, and it insists on an alpha channel. So the
 * mark is drawn once more, larger and with a fourth channel, and committed beside
 * the icons it was turned into — see `apps/desktop/package.json`.
 */
const desktopOut = join(here, '../apps/desktop/src-tauri/icons');

/** The application's own palette: accent on the canvas grey. See `styles.css`. */
const ACCENT = [0x2f, 0x6f, 0xed];
const LIGHT = [0xf1, 0xf3, 0xf5];

/** Rendered this many times over and averaged down, which is the whole of the
 * anti-aliasing: the drawing is rectangles, so edges are the only hard part. */
const SUPERSAMPLE = 4;

/**
 * The mark, in a unit square: a table seen head-on.
 *
 * A title bar and three rows of cells, fading as they recede — the same reading
 * of a table the canvas itself draws, which is what makes the icon recognisable
 * as this application rather than as a generic grid.
 */
const MARK = [
  { x: 0.04, y: 0.06, w: 0.92, h: 0.15, alpha: 1 },
  ...[0, 1, 2].flatMap((row) =>
    [0, 1, 2].map((column) => ({
      x: 0.04 + column * 0.315,
      y: 0.27 + row * 0.21,
      w: 0.29,
      h: 0.15,
      alpha: 0.92 - row * 0.22 - column * 0.06,
    })),
  ),
];

const blend = (over, under, alpha) => over * alpha + under * (1 - alpha);

/**
 * @param size pixels per side
 * @param inset how far inside the square the mark is drawn: a maskable icon is
 *   cropped to a circle by the platform, so its mark has to survive the corners
 *   being taken away.
 */
const draw = (size, inset) => {
  const scale = size * SUPERSAMPLE;
  const pixels = new Uint8Array(size * size * 3);
  const span = 1 - 2 * inset;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let coverage = 0;
      let alphaSum = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = (x * SUPERSAMPLE + sx + 0.5) / scale;
          const v = (y * SUPERSAMPLE + sy + 0.5) / scale;
          const mu = (u - inset) / span;
          const mv = (v - inset) / span;
          const hit = MARK.find((r) => mu >= r.x && mu < r.x + r.w && mv >= r.y && mv < r.y + r.h);
          if (hit !== undefined) {
            coverage += 1;
            alphaSum += hit.alpha;
          }
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      // Coverage and the mark's own translucency multiply: a partly covered
      // pixel of a faded cell is faded twice, which is what makes the edges of
      // the receding rows soft rather than stepped.
      const alpha = coverage === 0 ? 0 : (alphaSum / coverage) * (coverage / samples);
      const at = (y * size + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[at + channel] = Math.round(blend(LIGHT[channel], ACCENT[channel], alpha));
      }
    }
  }
  return pixels;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xff_ff_ff_ff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xff_ff_ff_ff) >>> 0;
};

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
};

/**
 * Truecolour, 8 bits a channel, no interlacing — the simplest PNG there is.
 *
 * With or without an alpha channel: a browser is happy either way, and the
 * desktop bundler refuses a source that has none. The mark is opaque in both
 * cases, so the extra channel is a constant 255 rather than a second drawing.
 */
const encodePng = (size, pixels, channels = 3) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    // Filter 0: the rows are flat colour, so nothing else earns its complexity.
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const ICONS = [
  { file: 'icon-192.png', size: 192, inset: 0.06 },
  { file: 'icon-512.png', size: 512, inset: 0.06 },
  // The safe area of a maskable icon is the middle 80%; a circle through that
  // leaves the corners, so the mark sits well inside it.
  { file: 'icon-maskable-512.png', size: 512, inset: 0.22 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.06 },
];

/** RGB to RGBA, opaque: the desktop bundler will not read a source without it. */
const opaque = (size, pixels) => {
  const out = new Uint8Array(size * size * 4);
  for (let at = 0; at < size * size; at += 1) {
    out[at * 4] = pixels[at * 3];
    out[at * 4 + 1] = pixels[at * 3 + 1];
    out[at * 4 + 2] = pixels[at * 3 + 2];
    out[at * 4 + 3] = 255;
  }
  return out;
};

mkdirSync(out, { recursive: true });
for (const { file, size, inset } of ICONS) {
  const png = encodePng(size, draw(size, inset));
  writeFileSync(join(out, file), png);
  console.info(`${file}  ${size}x${size}  ${png.length} bytes`);
}

/**
 * The desktop source, at the size every platform's bundler can be derived from.
 * 1024 because macOS asks for it and nothing asks for more.
 */
mkdirSync(desktopOut, { recursive: true });
const source = encodePng(1024, opaque(1024, draw(1024, 0.06)), 4);
writeFileSync(join(desktopOut, 'source.png'), source);
console.info(`source.png  1024x1024  ${source.length} bytes  (desktop bundler source)`);

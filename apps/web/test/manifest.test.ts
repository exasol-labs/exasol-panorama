import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The install criteria, checked against the files that are actually shipped.
 *
 * Everything here fails silently in a browser. A missing 192 or 512 means no
 * install prompt, with no error; a declared size that does not match the file is
 * an icon the platform quietly refuses; a manifest the document does not link is
 * a manifest nobody reads. None of it shows up in a page that otherwise works, so
 * it is asserted rather than remembered — and asserted against the bytes on disk,
 * because the failure mode is precisely the file and the declaration drifting
 * apart. `scripts/make-icons.mjs` draws them; this says they are still right.
 */

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

interface Manifest {
  readonly name: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly theme_color: string;
  readonly background_color: string;
  readonly icons: readonly ManifestIcon[];
}

const read = (relative: string): Buffer =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)));

const manifest = JSON.parse(read('../public/manifest.webmanifest').toString('utf8')) as Manifest;
const document_ = read('../index.html').toString('utf8');

/** A PNG says its own size in the IHDR chunk, which starts at byte 16. */
const pngSize = (bytes: Buffer): { width: number; height: number } | null => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

describe('the web app manifest', () => {
  it('says what an installed application needs to be launched', () => {
    expect(manifest.name).toBe('Exasol Panorama');
    // Truncated under an icon at about twelve characters, so it is chosen, not
    // derived from the full name.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('matches the palette the application is drawn in', () => {
    const styles = read('../src/styles.css').toString('utf8');
    expect(styles).toContain(`--pn-bg: ${manifest.background_color}`);
    expect(manifest.theme_color).toBe(manifest.background_color);
  });

  it('is linked from the document, with a theme colour a browser can use early', () => {
    expect(document_).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(document_).toContain(`content="${manifest.theme_color}"`);
  });
});

describe('the icons it declares', () => {
  it('exists, as a PNG of exactly the size claimed', () => {
    for (const icon of manifest.icons) {
      const bytes = read(`../public${icon.src}`);
      expect(icon.type, icon.src).toBe('image/png');
      const size = pngSize(bytes);
      expect(size, `${icon.src} is not a PNG`).not.toBeNull();
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(size, icon.src).toEqual({ width, height });
    }
  });

  it('covers the two sizes that decide whether an install is offered at all', () => {
    const any = manifest.icons.filter((icon) => icon.purpose !== 'maskable');
    expect(any.map((icon) => icon.sizes).sort()).toEqual(['192x192', '512x512']);
  });

  it('includes a maskable one, so a launcher does not crop the mark away', () => {
    const maskable = manifest.icons.filter((icon) => icon.purpose === 'maskable');
    expect(maskable.map((icon) => icon.sizes)).toEqual(['512x512']);
  });

  /** iOS reads neither the manifest's icons nor its name for a home screen. */
  it('is joined by an apple-touch-icon the document points at', () => {
    expect(document_).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(pngSize(read('../public/icons/apple-touch-icon.png'))).toEqual({
      width: 180,
      height: 180,
    });
  });
});

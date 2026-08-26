import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFormat } from '@panorama/export';
import {
  PNG_PIXEL_RATIO,
  canStreamToDisk,
  openSaveSink,
  rasteriseSvg,
} from '../src/panorama/save-file.js';

const request = (format: 'csv' | 'parquet' = 'csv'): Parameters<typeof openSaveSink>[0] => ({
  tableId: 'table:a' as never,
  tableName: 'SALES.ORDERS',
  fileName: `SALES.ORDERS${describeFormat(format).extension}`,
  format: describeFormat(format),
});

interface Picker {
  (options: unknown): Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
}

const withPicker = (picker: Picker | undefined): void => {
  if (picker === undefined) {
    delete (globalThis as { showSaveFilePicker?: Picker }).showSaveFilePicker;
    return;
  }
  (globalThis as { showSaveFilePicker?: Picker }).showSaveFilePicker = picker;
};

afterEach(() => {
  withPicker(undefined);
  vi.restoreAllMocks();
});

describe('openSaveSink where the browser can stream to disk', () => {
  it('asks for the file first, then streams into it', async () => {
    const written: number[] = [];
    let closed = false;
    const options: unknown[] = [];
    withPicker(async (given) => {
      options.push(given);
      return {
        createWritable: async (): Promise<WritableStream<Uint8Array>> =>
          new WritableStream<Uint8Array>({
            write(chunk) {
              written.push(...chunk);
            },
            close() {
              closed = true;
            },
          }),
      };
    });
    expect(canStreamToDisk()).toBe(true);

    const sink = await openSaveSink(request('parquet'));
    if (sink === null) throw new Error('expected a sink');
    await sink.write(new Uint8Array([1, 2, 3]));
    expect(sink.position).toBe(3);
    await sink.close();
    expect(written).toEqual([1, 2, 3]);
    expect(closed).toBe(true);
    // The dialog is told the name and the type, so it filters and pre-fills.
    expect(options[0]).toEqual({
      suggestedName: 'SALES.ORDERS.parquet',
      types: [
        {
          description: 'Parquet file',
          accept: { 'application/vnd.apache.parquet': ['.parquet'] },
        },
      ],
    });
  });

  it('reports a dismissed dialog as no destination rather than as a failure', async () => {
    withPicker(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    expect(await openSaveSink(request())).toBeNull();
  });

  it('lets a real failure through', async () => {
    withPicker(async () => {
      throw new Error('no permission');
    });
    await expect(openSaveSink(request())).rejects.toThrow('no permission');
  });
});

describe('openSaveSink where it cannot', () => {
  it('assembles the file and offers it as a download', async () => {
    withPicker(undefined);
    expect(canStreamToDisk()).toBe(false);
    const url = 'blob:panorama/1';
    const create = vi.fn(() => url);
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicks: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ): void {
      clicks.push(this);
    });

    const sink = await openSaveSink(request());
    if (sink === null) throw new Error('expected a sink');
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3]));
    expect(sink.position).toBe(3);
    await sink.close();

    expect(click).toHaveBeenCalledTimes(1);
    expect(clicks[0]?.download).toBe('SALES.ORDERS.csv');
    expect(clicks[0]?.getAttribute('href')).toBe(url);
    // The blob carries every byte, and the URL is released again.
    expect(create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect((create.mock.calls[0]?.[0] as Blob).size).toBe(3);
    expect((create.mock.calls[0]?.[0] as Blob).type).toBe('text/csv');
    expect(revoke).toHaveBeenCalledWith(url);
    // Nothing is left in the document afterwards.
    expect(document.querySelector('a')).toBeNull();
  });

  it('offers nothing when the export was abandoned', async () => {
    withPicker(undefined);
    const create = vi.fn(() => 'blob:panorama/2');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const sink = await openSaveSink(request());
    if (sink === null) throw new Error('expected a sink');
    await sink.write(new Uint8Array([1, 2, 3]));
    await sink.abort?.(new Error('stopped'));
    expect(create).not.toHaveBeenCalled();
  });
});

describe('rasterising a chart for a PNG', () => {
  /** A canvas and an image, as far as this function is concerned. */
  const withPlatform = (
    options: { readonly context?: unknown; readonly blob?: Blob | null } = {},
  ): { revoked: string[]; drawn: number[][]; encoded: string[] } => {
    const revoked: string[] = [];
    const drawn: number[][] = [];
    const encoded: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chart');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => revoked.push(url));
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected ${tag}`);
      return {
        width: 0,
        height: 0,
        getContext: () =>
          options.context === undefined
            ? {
                drawImage: (_image: unknown, x: number, y: number, w: number, h: number) =>
                  drawn.push([x, y, w, h]),
              }
            : options.context,
        toBlob: (callback: (blob: Blob | null) => void, type: string) => {
          encoded.push(type);
          callback(options.blob === undefined ? new Blob(['png-bytes']) : options.blob);
        },
      } as unknown as HTMLCanvasElement;
    });
    // jsdom has no SVG decoder, so the image reports success and nothing else.
    class FakeImage {
      src = '';
      decode(): Promise<void> {
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Image', FakeImage);
    return { revoked, drawn, encoded };
  };

  it('draws the SVG at twice the size and encodes a PNG', async () => {
    const platform = withPlatform();
    const bytes = await rasteriseSvg('<svg/>', { width: 300, height: 200 });
    // Twice the pixels: a chart pasted into a document is looked at closely.
    expect(platform.drawn).toEqual([[0, 0, 300 * PNG_PIXEL_RATIO, 200 * PNG_PIXEL_RATIO]]);
    expect(platform.encoded).toEqual(['image/png']);
    expect(new TextDecoder().decode(bytes)).toBe('png-bytes');
  });

  it('releases the object URL whether it worked or not', async () => {
    const platform = withPlatform();
    await rasteriseSvg('<svg/>', { width: 10, height: 10 });
    expect(platform.revoked).toEqual(['blob:chart']);

    const failing = withPlatform({ context: null });
    await expect(rasteriseSvg('<svg/>', { width: 10, height: 10 })).rejects.toThrow(
      /cannot rasterise/,
    );
    // An object URL outlives the document, so it goes back either way.
    expect(failing.revoked).toEqual(['blob:chart']);
  });

  it('says so when the browser produced no image', async () => {
    withPlatform({ blob: null });
    await expect(rasteriseSvg('<svg/>', { width: 10, height: 10 })).rejects.toThrow(
      /could not encode/,
    );
  });

  it('never asks for a canvas with no pixels in it', async () => {
    const platform = withPlatform();
    await rasteriseSvg('<svg/>', { width: 0, height: 0 });
    expect(platform.drawn).toEqual([[0, 0, 1, 1]]);
  });
});

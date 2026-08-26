import type { ByteSink } from '@panorama/export';
import { collectingSink, streamSink } from '@panorama/export';
import type { ExportSinkRequest } from './workspace.js';

/**
 * Opening the file an export is written to.
 *
 * Two routes, because browsers offer two.
 *
 * Where the File System Access API exists, the user picks the file *first* and
 * the bytes are streamed into it as they are encoded. That is the route that
 * makes the size of the relation irrelevant: nothing is ever held whole, so
 * exporting ten billion rows costs one batch of memory and however long the
 * database takes.
 *
 * Where it does not, the only way to hand a file to the user is a download of
 * something the page already has — so the whole file is assembled in memory and
 * then offered. That works, and it is bounded by memory rather than by disk,
 * which is why the export panel says which route it took when the file is large.
 *
 * `showSaveFilePicker` must be called during the click that asked for it: user
 * activation does not survive an `await`. So nothing is awaited before it.
 */

interface SaveFilePickerType {
  readonly description: string;
  readonly accept: Record<string, readonly string[]>;
}

interface SaveFilePickerOptions {
  readonly suggestedName: string;
  readonly types: readonly SaveFilePickerType[];
}

interface SaveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<SaveFileHandle>;

const picker = (): SaveFilePicker | undefined =>
  (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

/** True when a file can be streamed to disk rather than assembled in memory. */
export const canStreamToDisk = (): boolean => typeof picker() === 'function';

/**
 * The download of last resort: an object URL and a synthetic click, which is
 * the only way a page without the File System Access API can hand over a file.
 */
const downloadSink = (fileName: string, mimeType: string): ByteSink => {
  const collected = collectingSink();
  return {
    get position(): number {
      return collected.position;
    },
    write: collected.write,
    async close(): Promise<void> {
      const bytes = collected.bytes();
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const url = URL.createObjectURL(new Blob([buffer as ArrayBuffer], { type: mimeType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    async abort(reason: unknown): Promise<void> {
      // Nothing was offered, so there is nothing to withdraw.
      await collected.abort?.(reason);
    },
  };
};

/** Thrown by the picker when the user closes the dialog. */
const isDismissal = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export const openSaveSink = async (request: ExportSinkRequest): Promise<ByteSink | null> => {
  const show = picker();
  if (show === undefined) {
    return downloadSink(request.fileName, request.format.mimeType);
  }
  try {
    const handle = await show({
      suggestedName: request.fileName,
      types: [
        {
          description: `${request.format.label} file`,
          accept: { [request.format.mimeType]: [request.format.extension] },
        },
      ],
    });
    return streamSink(await handle.createWritable());
  } catch (error) {
    if (isDismissal(error)) return null;
    throw error;
  }
};

/**
 * Rasterises an SVG into PNG bytes.
 *
 * The browser already has a vector rasteriser and every font on the machine, so
 * the PNG is the SVG drawn once rather than a second painting routine that would
 * have to be kept in step with the first. Which means the two formats cannot
 * disagree about what the chart looks like.
 *
 * Twice the pixels, because a chart pasted into a document is looked at closely
 * and a screen-resolution one looks like a screenshot.
 */
export const PNG_PIXEL_RATIO = 2;

export const rasteriseSvg = async (
  svg: string,
  size: { readonly width: number; readonly height: number },
): Promise<Uint8Array> => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(size.width * PNG_PIXEL_RATIO));
    canvas.height = Math.max(1, Math.round(size.height * PNG_PIXEL_RATIO));
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('This browser cannot rasterise a chart');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (blob === null) throw new Error('This browser could not encode a PNG');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    // Released whether it worked or not: an object URL outlives the document.
    URL.revokeObjectURL(url);
  }
};

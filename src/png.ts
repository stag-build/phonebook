import { open } from 'node:fs/promises';

/** `\x89PNG\r\n\x1a\n` — the 8-byte signature every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature (8) + IHDR length and type (8) + width and height (8). */
const HEADER_BYTES = 24;

export interface PngSize {
  width: number;
  height: number;
}

/**
 * Read a PNG's pixel dimensions from its IHDR header.
 *
 * A gallery cannot lay out a screenshot it has no size for: real preview
 * output ranges from a 161x79 badge to a 1206x2622 full screen, and a
 * consumer that does not know which is which either reflows as images load or
 * reserves the wrong space. The dimensions are the first 24 bytes of the file,
 * so this reads the header rather than decoding the image.
 *
 * Returns `undefined` for anything that is not a readable PNG. Size is
 * optional in the manifest, and one odd file is not a reason to fail a whole
 * `generate`.
 */
export async function readPngSize(path: string): Promise<PngSize | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    if (bytesRead < HEADER_BYTES) return undefined;
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
    if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return undefined;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width === 0 || height === 0) return undefined;
    return { width, height };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

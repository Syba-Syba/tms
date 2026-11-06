/**
 * Image type is decided by the bytes, never by a label.
 *
 * The client declares `contentType: 'image/jpeg'` whatever it actually captured, and the seal
 * used to pick embedPng/embedJpg from that label (or from the key's extension). A PNG picked
 * from a gallery, stored as "image/jpeg", made pdf-lib throw at seal time and left the
 * inspection, and the deposit settlement behind it, blocked for good.
 */
import { inflateSync } from 'node:zlib';

export type ImageType = 'png' | 'jpg';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, magic: number[]) =>
  bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG)) return 'png';
  if (startsWith(bytes, JPEG)) return 'jpg';
  return null;
}

/**
 * Width and height from the header alone, without decoding. pdf-lib decodes a PNG in full, so a
 * 35 KB all-zero PNG of 6000x6000 took hundreds of megabytes: the size is checked first.
 * Null when the header cannot be read.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  const u32 = (at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
  if (type === 'png') {
    // IHDR is always the first chunk: length at 8, type at 12, width at 16, height at 20.
    if (bytes.length < 24 || Buffer.from(bytes.subarray(12, 16)).toString('latin1') !== 'IHDR') return null;
    return { width: u32(16), height: u32(20) };
  }
  if (type === 'jpg') {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) {
        at += 1; // fill byte
        continue;
      }
      // Markers without a length: RSTn, SOI, EOI, TEM.
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        at += 2;
        continue;
      }
      // Start of frame (any coding), but not DHT (C4), JPG (C8) or DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (at + 8 >= bytes.length) return null;
        return { width: u16(at + 7), height: u16(at + 5) };
      }
      at += 2 + u16(at + 2);
    }
  }
  return null;
}

/** Photos are re-encoded to 1600 px by the app; these leave room for anything sane. */
export const MAX_IMAGE_SIDE = 10_000;
export const MAX_IMAGE_PIXELS = 16_000_000;

/**
 * Whether the header names a size small enough to decode. A PNG whose header cannot be read
 * fails. A JPEG with no frame header is left to pdf-lib, which refuses it without decoding.
 */
export function hasSafeDimensions(
  bytes: Uint8Array,
  limits: { side: number; pixels: number } = { side: MAX_IMAGE_SIDE, pixels: MAX_IMAGE_PIXELS },
): boolean {
  const size = imageDimensions(bytes);
  if (!size) return sniffImageType(bytes) === 'jpg';
  if (size.width < 1 || size.height < 1) return false;
  return size.width <= limits.side && size.height <= limits.side && size.width * size.height <= limits.pixels;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

/**
 * Whether a PNG is whole: every chunk inside the file, IHDR first, IEND last, and the image
 * data a complete zlib stream no larger than its header names (short rows are tolerated,
 * as pdf-lib reads them). pdf-lib's decoder never returns on a
 * truncated PNG (it spins, holding the process), and throws on corrupt data, so nothing is
 * handed to it unless this passes. Call only after hasSafeDimensions bounds the size.
 */
export function isWellFormedPng(bytes: Uint8Array): boolean {
  const size = imageDimensions(bytes);
  if (sniffImageType(bytes) !== 'png' || !size) return false;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const depth = view[24]!;
  const colour = view[25]!;
  const interlaced = view[28] === 1;
  const channels = CHANNELS[colour];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return false;
  const idat: Buffer[] = [];
  let palette = false;
  let ended = false;
  let at = 8;
  while (at < view.length) {
    if (at + 12 > view.length) return false;
    const length = view.readUInt32BE(at);
    const type = view.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > view.length) return false;
    if (at === 8 && type !== 'IHDR') return false;
    if (type === 'IDAT') idat.push(view.subarray(at + 8, at + 8 + length));
    if (type === 'PLTE') palette = true;
    at += 12 + length;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || idat.length === 0 || (colour === 3 && !palette)) return false;
  const bits = channels * depth;
  const row = (width: number) => Math.ceil((width * bits) / 8);
  let expected = 0;
  if (interlaced) {
    for (const [x, y, dx, dy] of ADAM7) {
      const w = size.width > x ? Math.ceil((size.width - x) / dx) : 0;
      const h = size.height > y ? Math.ceil((size.height - y) / dy) : 0;
      if (w > 0 && h > 0) expected += h * (1 + row(w));
    }
  } else {
    expected = size.height * (1 + row(size.width));
  }
  try {
    inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
    return true;
  } catch {
    return false;
  }
}

/** A signature pad's canvas is a few thousand pixels wide at most, even on a high-DPI screen. */
export const SIGNATURE_LIMITS = { side: 4000, pixels: 4_000_000, bytes: 750 * 1024 };

/** The base64 payload of a data URL, or of a bare base64 string. Whitespace is tolerated. */
export function bytesFromDataUrl(value: string): Uint8Array {
  const payload = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(payload, 'base64'));
}

/**
 * The PNG bytes behind a signature pad's data URL, or null when they are not a PNG, or are too
 * big (in bytes or pixels) to be a signature. The size is read from the header, so a small
 * file that would decode to gigabytes is refused before anything decodes it.
 */
export function pngBytesFromDataUrl(value: string): Uint8Array | null {
  const bytes = bytesFromDataUrl(value);
  if (sniffImageType(bytes) !== 'png' || bytes.length > SIGNATURE_LIMITS.bytes) return null;
  return hasSafeDimensions(bytes, SIGNATURE_LIMITS) && isWellFormedPng(bytes) ? bytes : null;
}

export const isPngDataUrl = (value: string) => pngBytesFromDataUrl(value) !== null;

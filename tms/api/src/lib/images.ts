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

const u16 = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;

/** More scans than any real progressive photo has; past this a file is built to cost time. */
const MAX_JPEG_SCANS = 100;

/**
 * The one frame of a JPEG, read the way every reader will read it, or null.
 *
 * pdf-lib copies a JPEG into the PDF without decoding it, and takes the size from the first
 * frame header its own simple reader finds. Anything that could make that reader, this one and
 * the viewer's decoder disagree is refused: fill bytes and bare markers before the scan, a
 * second frame, lossless, hierarchical and arithmetic coding, and a line count set after the
 * scan (DNL). Baseline and progressive photos, with any number of APP blocks, pass.
 */
export function jpegFrame(bytes: Uint8Array): { width: number; height: number; scans: number } | null {
  if (!startsWith(bytes, JPEG)) return null;
  let frame: { width: number; height: number } | null = null;
  let at = 2;
  // Headers: every one is FF, a marker, and a length that stays inside the file.
  for (;;) {
    if (at === bytes.length) return frame && { ...frame, scans: 0 };
    if (at + 4 > bytes.length || bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    const length = u16(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return null;
    const plain = marker === 0xc4 || marker === 0xdb || marker === 0xdd || marker === 0xfe || (marker >= 0xe0 && marker <= 0xef);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const components = bytes[at + 9]!;
      if (frame || length !== 8 + 3 * components || bytes[at + 4] !== 8 || ![1, 3, 4].includes(components)) return null;
      frame = { width: u16(bytes, at + 7), height: u16(bytes, at + 5) };
    } else if (marker === 0xda) {
      if (!frame) return null;
      break;
    } else if (!plain) {
      return null;
    }
    at += 2 + length;
  }
  // Scans: compressed data, with only tables, restarts and further scans between.
  let scans = 0;
  for (;;) {
    scans += 1;
    if (scans > MAX_JPEG_SCANS) return null;
    at += 2 + u16(bytes, at + 2);
    let next = -1;
    while (at + 1 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1]!;
      // A stuffed FF, a restart, or a fill byte: still inside the scan.
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) at += 2;
      else if (marker === 0xff) at += 1;
      else {
        next = marker;
        break;
      }
    }
    // The end of the image, or of the file: a photo cut short still shows what arrived.
    if (next === -1 || next === 0xd9) return { ...frame, scans };
    for (;;) {
      if (at + 4 > bytes.length || bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      const length = u16(bytes, at + 2);
      if (length < 2 || at + 2 + length > bytes.length) return null;
      if (marker === 0xda) break;
      const plain = marker === 0xc4 || marker === 0xdb || marker === 0xdd || marker === 0xfe || (marker >= 0xe0 && marker <= 0xef);
      if (!plain) return null;
      at += 2 + length;
    }
  }
}

/**
 * Width and height from the header alone, without decoding. pdf-lib decodes a PNG in full, so a
 * 35 KB all-zero PNG of 6000x6000 took hundreds of megabytes: the size is checked first.
 * Null when the header cannot be read. For a PNG this is the first IHDR only: isWellFormedPng
 * is what makes sure there is no second one.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  if (type === 'png') {
    // IHDR is always the first chunk: length at 8, type at 12, width at 16, height at 20.
    if (bytes.length < 24 || Buffer.from(bytes.subarray(12, 16)).toString('latin1') !== 'IHDR') return null;
    return { width: u32(bytes, 16), height: u32(bytes, 20) };
  }
  if (type === 'jpg') {
    const frame = jpegFrame(bytes);
    return frame && { width: frame.width, height: frame.height };
  }
  return null;
}

/** Whether a JPEG has one readable frame and at least one scan of image data. */
export const isWellFormedJpeg = (bytes: Uint8Array) => (jpegFrame(bytes)?.scans ?? 0) > 0;

/**
 * The most that is ever decoded. Files stored before the upload ceiling below can be this big,
 * and must still render.
 */
export const MAX_IMAGE_SIDE = 10_000;
export const MAX_IMAGE_PIXELS = 16_000_000;

/**
 * A new photo's ceiling. The app redraws every photo to 1600 px on its longest edge, so nothing
 * it sends is over 2.6 megapixels. A decoded PNG costs about 4 bytes a pixel held until the PDF
 * is saved, and at the old 16 megapixels sixty of them were 3.8 GB.
 */
export const UPLOAD_LIMITS = { side: 2400, pixels: 3_000_000 };

/**
 * Decoded PNG pixels one document may hold: about 160 MB. Past it, photos are left out of the
 * report (and it says how many) rather than the render running out of memory.
 */
export const REPORT_PIXEL_BUDGET = 40_000_000;

/** The pixels pdf-lib will decode and hold for this image. A JPEG is copied in as it is: none. */
export function decodedPixels(bytes: Uint8Array): number {
  if (sniffImageType(bytes) !== 'png') return 0;
  const size = imageDimensions(bytes);
  return size ? size.width * size.height : 0;
}

/** Whether the header names a size small enough to decode. A header that cannot be read fails. */
export function hasSafeDimensions(
  bytes: Uint8Array,
  limits: { side: number; pixels: number } = { side: MAX_IMAGE_SIDE, pixels: MAX_IMAGE_PIXELS },
): boolean {
  const size = imageDimensions(bytes);
  if (!size) return false;
  if (size.width < 1 || size.height < 1) return false;
  return size.width <= limits.side && size.height <= limits.side && size.width * size.height <= limits.pixels;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;

/**
 * The chunks a still PNG is made of, plus the ancillary ones writers add (colour, text, time,
 * and Apple's iDOT). The decoder skips or merely stores all of these. Everything else is
 * refused, above all the animation chunks (acTL, fcTL, fdAT).
 */
const PNG_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS',
  'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'mDCV', 'cLLI', 'sBIT', 'bKGD', 'pHYs', 'sPLT',
  'tIME', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'iDOT',
]);

/**
 * Whether a PNG is whole and plain: every chunk inside the file and of a known kind, exactly
 * one IHDR and it comes first, IEND last, and the image data a complete zlib stream no larger
 * than its header names (short rows are tolerated, as pdf-lib reads them).
 *
 * pdf-lib's decoder never returns on a truncated PNG (it spins, holding the process), and
 * throws on corrupt data. It also takes the size from the last IHDR it meets, and decodes
 * every frame of an animated PNG before refusing it: a 96-byte file with a second IHDR, or a
 * 242-byte one with a 20000x20000 frame, froze the server for everyone. So nothing is handed
 * to it unless this passes. Call only after hasSafeDimensions bounds the size.
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
  // Compression and filter have one legal value each, interlace two.
  if (view.readUInt32BE(8) !== 13 || view[26] !== 0 || view[27] !== 0 || view[28]! > 1) return false;
  const idat: Buffer[] = [];
  let palette = false;
  let ended = false;
  let at = 8;
  while (at < view.length) {
    if (at + 12 > view.length) return false;
    const length = view.readUInt32BE(at);
    const type = view.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > view.length) return false;
    if (!PNG_CHUNKS.has(type)) return false;
    // The decoder takes its size from whichever IHDR it read last.
    if ((type === 'IHDR') !== (at === 8)) return false;
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

/**
 * Image type is decided by the bytes, never by a label.
 *
 * The client declares `contentType: 'image/jpeg'` whatever it actually captured, and the seal
 * used to pick embedPng/embedJpg from that label (or from the key's extension). A PNG picked
 * from a gallery, stored as "image/jpeg", made pdf-lib throw at seal time and left the
 * inspection, and the deposit settlement behind it, blocked for good.
 */
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

/** The base64 payload of a data URL, or of a bare base64 string. Whitespace is tolerated. */
export function bytesFromDataUrl(value: string): Uint8Array {
  const payload = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(payload, 'base64'));
}

/** The PNG bytes behind a signature pad's data URL, or null when they are not a PNG at all. */
export function pngBytesFromDataUrl(value: string): Uint8Array | null {
  const bytes = bytesFromDataUrl(value);
  return sniffImageType(bytes) === 'png' ? bytes : null;
}

export const isPngDataUrl = (value: string) => pngBytesFromDataUrl(value) !== null;

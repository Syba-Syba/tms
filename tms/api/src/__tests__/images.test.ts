import { describe, expect, it } from 'vitest';
import { bytesFromDataUrl, isPngDataUrl, pngBytesFromDataUrl, sniffImageType } from '../lib/images';

const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('image type by bytes', () => {
  it('recognises PNG and JPEG by their magic bytes, whatever anyone labelled them', () => {
    expect(sniffImageType(bytesFromDataUrl(ONE_PX_PNG))).toBe('png');
    expect(sniffImageType(JPEG_HEAD)).toBe('jpg');
  });

  it('says null for anything else, including empty and text', () => {
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('%PDF-1.4'))).toBeNull();
    // A JPEG that was labelled PNG, and a PNG labelled JPEG, are told apart by bytes alone.
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // too short to be a PNG
  });

  it('reads a signature pad data URL with or without the data: prefix', () => {
    expect(isPngDataUrl(`data:image/png;base64,${ONE_PX_PNG}`)).toBe(true);
    expect(isPngDataUrl(ONE_PX_PNG)).toBe(true);
    expect(pngBytesFromDataUrl(`data:image/png;base64,${ONE_PX_PNG}`)?.length).toBeGreaterThan(60);
  });

  it('refuses a data URL whose bytes are not a PNG, even when it says image/png', () => {
    const jpegAsPng = `data:image/png;base64,${Buffer.from(JPEG_HEAD).toString('base64')}`;
    expect(isPngDataUrl(jpegAsPng)).toBe(false);
    expect(pngBytesFromDataUrl(jpegAsPng)).toBeNull();
    expect(isPngDataUrl('data:image/png;base64,aGVsbG8gd29ybGQ=')).toBe(false);
    expect(isPngDataUrl('')).toBe(false);
  });
});

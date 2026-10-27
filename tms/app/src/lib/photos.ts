import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

export interface PickedPhoto {
  dataUrl: string;
  blob: Blob;
  contentType: 'image/jpeg';
}

/**
 * One way to get a photo on every platform.
 *
 * The Capacitor camera plugin's web implementation needs @ionic/pwa-elements for its
 * prompt, which this app does not ship, so on a phone browser (the only client that works
 * against the self-hosted server) `Camera.getPhoto` never resolved and nothing could be
 * uploaded. The browser's own file input does the job, and offers the camera or the gallery.
 *
 * Whatever comes back is redrawn through a canvas: the longest edge is capped, the EXIF
 * orientation is baked in (pdf-lib ignores it, so portrait photos came out sideways in the
 * sealed reports), and the bytes are JPEG, which is what the upload declares. A PNG from the
 * gallery used to be labelled image/jpeg and broke the seal when the server tried to embed it.
 */
export async function pickPhoto(
  options: { maxEdge?: number; quality?: number } = {},
): Promise<PickedPhoto | null> {
  const { maxEdge = 1600, quality = 0.7 } = options;
  const source = Capacitor.isNativePlatform() ? await fromCamera() : await fromFileInput();
  if (!source) return null;
  return reencode(source, maxEdge, quality);
}

async function fromCamera(): Promise<Blob | null> {
  try {
    const photo = await Camera.getPhoto({
      quality: 85,
      width: 2000,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
    });
    if (!photo.dataUrl) return null;
    return await (await fetch(photo.dataUrl)).blob();
  } catch {
    // The plugin rejects when the person cancels; that is not an error.
    return null;
  }
}

function fromFileInput(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // image/* without `capture`, so the phone offers both the camera and the gallery, the
    // same choice the native prompt gives.
    input.accept = 'image/*';
    input.style.display = 'none';

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    // Cancelling fires no change event in older browsers; focus returning to the page with
    // nothing chosen is the only signal. The delay lets a late change event win.
    const onFocus = () => setTimeout(() => finish(input.files?.[0] ?? null), 1000);

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // A format the bitmap decoder refuses (HEIC on some browsers) may still load as an <img>.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not a photo this browser can read. Try a JPEG or PNG.'));
    };
    image.src = url;
  });
}

async function reencode(source: Blob, maxEdge: number, quality: number): Promise<PickedPhoto> {
  const image = await decode(source);
  const width = 'naturalWidth' in image ? image.naturalWidth : image.width;
  const height = 'naturalHeight' in image ? image.naturalHeight : image.height;
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot process photos.');
  // JPEG has no transparency; without this a transparent PNG comes out black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if ('close' in image) image.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not encode the photo.');
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), blob, contentType: 'image/jpeg' };
}

/** PUTs to a signed upload link and refuses to call a failed upload done. */
export async function putFile(uploadUrl: string, blob: Blob, contentType: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'content-type': contentType },
  });
  if (!response.ok) throw new Error(`The upload failed (${response.status}). Try again.`);
}

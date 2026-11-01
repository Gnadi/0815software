import { decodeQr } from '../scan/qr';

/**
 * Pictures of receipts: made small on the phone before they are stored or
 * sent (a 12-megapixel photo is 4 MB; 1600 pixels across still read), and
 * searched for a QR code right there.
 */

const MAX_SIDE = 1600;

async function bitmap(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
}

function canvasOf(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot draw pictures');
  return ctx;
}

/** A JPEG at most 1600 pixels across; a PDF passes as it is. */
export async function shrinkPhoto(file: Blob): Promise<Blob> {
  if (file.type === 'application/pdf') return file;
  const img = await bitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const ctx = canvasOf(Math.round(img.width * scale), Math.round(img.height * scale));
  ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
  img.close();
  return new Promise((resolve, reject) => ctx.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not shrink the picture'))), 'image/jpeg', 0.82));
}

/** The text of a QR code in a photo, trying a few sizes — a small code in a big photo reads better scaled. */
export async function qrFromPhoto(file: Blob): Promise<string | null> {
  if (file.type === 'application/pdf') return null;
  const img = await bitmap(file);
  try {
    for (const side of [1400, 900, 2000]) {
      const scale = Math.min(1, side / Math.max(img.width, img.height));
      const ctx = canvasOf(Math.round(img.width * scale), Math.round(img.height * scale));
      ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
      const found = decodeQr(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height));
      if (found) return found.text;
      if (scale === 1) break;
    }
    return null;
  } finally {
    img.close();
  }
}

/** One video frame, the middle of it, looked at for a code. */
export function qrFromVideo(video: HTMLVideoElement, ctx: CanvasRenderingContext2D): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const side = Math.min(w, h);
  const out = Math.min(720, side);
  ctx.canvas.width = out;
  ctx.canvas.height = out;
  ctx.drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
  return decodeQr(ctx.getImageData(0, 0, out, out))?.text ?? null;
}

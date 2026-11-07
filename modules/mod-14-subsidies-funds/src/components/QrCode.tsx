import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '../qr/encode';

/**
 * A QR code drawn here, in the browser (src/qr/encode.ts) — never fetched from
 * a QR web service, which would hand it the two-factor secret. Always dark on
 * white whatever the theme: a phone camera reads that, not an inverted code.
 */
export function QrCode({ text, size = 196, label }: { text: string; size?: number; label: string }) {
  const { viewBox, d } = useMemo(() => qrSvgPath(encodeQr(text)), [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={viewBox}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{ background: '#fff', display: 'block', margin: '0 auto' }}
    >
      <path d={d} fill="#000" />
    </svg>
  );
}

import { useEffect, useRef, useState } from 'react';
import { qrFromVideo } from '../pwa/image';

/**
 * The camera, looking for a QR code: four looks a second at the middle of the
 * picture, read here (src/scan/qr.ts). Nothing is recorded or sent; the
 * stream stops as soon as a code is read or the scanner closes.
 */
export function QrScanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const look = () => {
      if (stopped || !video.current || !ctx) return;
      const text = qrFromVideo(video.current, ctx);
      if (text) {
        stopped = true;
        onCode(text);
        return;
      }
      timer = window.setTimeout(look, 250);
    };
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem('This browser offers no camera here — it needs HTTPS. Take a photo instead.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        look();
      })
      .catch(() => setProblem('No camera — permission was refused, or there is none. Take a photo instead.'));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div className="scanner">
      {problem ? <div className="resource__error mono">{problem}</div> : <video ref={video} className="scanner__video" playsInline muted />}
      <div className="scanner__hint mono">HOLD THE RECEIPT'S QR CODE IN THE FRAME</div>
      <button type="button" className="btn" onClick={onClose}>
        CLOSE
      </button>
    </div>
  );
}

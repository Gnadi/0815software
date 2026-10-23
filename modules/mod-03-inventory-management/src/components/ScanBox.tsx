import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Product } from '../../shared/types';
import { api, ApiError } from '../api';

/**
 * Scan a product: a handheld scanner "types" the code and Enter into the
 * field (keyboard wedge — works in every browser), or the device camera reads
 * it where the browser has a BarcodeDetector (Chrome/Edge on Android and
 * desktop). Either way the server resolves the code (GTIN or SKU) and the
 * screen decides what a scan means: open the product, or count one in.
 */

interface Props {
  onFound: (product: Product) => void;
  onAuthLost: () => void;
  label?: string;
}

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => Detector;
  }
}

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'code_128'];

export function ScanBox({ onFound, onAuthLost, label = 'SCAN' }: Props) {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const canUseCamera = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices;

  async function resolve(raw: string) {
    const value = raw.trim();
    if (value === '') return;
    setMessage('');
    try {
      const { product } = await api.lookupProduct(value);
      setMessage(`${product.sku} · ${product.name}`);
      onFound(product);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else setMessage(err instanceof Error ? err.message : 'Lookup failed');
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void resolve(code);
    setCode('');
  }

  // The camera loop: one frame every 250 ms until a code is read or it is closed.
  useEffect(() => {
    if (!camera || !window.BarcodeDetector) return;
    const detector = new window.BarcodeDetector({ formats: FORMATS });
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        stream = s;
        if (stopped || !video.current) return;
        video.current.srcObject = s;
        void video.current.play();
        timer = setInterval(() => {
          if (!video.current) return;
          void detector.detect(video.current).then((codes) => {
            if (codes.length > 0 && !stopped) {
              stopped = true;
              setCamera(false);
              void resolve(codes[0]!.rawValue);
            }
          });
        }, 250);
      })
      .catch((err: unknown) => {
        setMessage(`Camera unavailable: ${err instanceof Error ? err.message : String(err)}`);
        setCamera(false);
      });
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // resolve is stable enough for the life of one camera session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  return (
    <div>
      <form className="toolbar" onSubmit={submit}>
        <input
          className="field__input mono"
          placeholder={`${label} — barcode or SKU, then Enter`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Scan a barcode or type a SKU"
        />
        {canUseCamera && (
          <button className="btn btn--ghost" type="button" onClick={() => setCamera(!camera)}>
            {camera ? 'CLOSE CAMERA' : 'CAMERA'}
          </button>
        )}
        {message && <span className="toolbar__count mono">{message}</span>}
      </form>
      {camera && <video ref={video} muted playsInline style={{ width: '100%', maxWidth: 420, borderRadius: 8, marginTop: 8 }} />}
    </div>
  );
}

import { productBarcode } from '../../shared/barcode';
import type { Product } from '../../shared/types';

/**
 * A shelf/product label: name, SKU and the barcode as SVG — the product's
 * GTIN when it has one, its SKU in Code 128 otherwise (shared/barcode.ts).
 * Printed with the browser's own print dialog; the stylesheet below hides
 * everything else on the page while printing.
 */
export function BarcodeLabel({ product }: { product: Product }) {
  const code = productBarcode(product);
  const module = 2; // px per module: crisp on screen and on a 203 dpi label printer
  const quiet = 10 * module;
  const width = code.modules.length * module + 2 * quiet;
  const height = 70;
  return (
    <div className="barcode-label">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .barcode-label, .barcode-label * { visibility: visible; }
          .barcode-label { position: absolute; left: 0; top: 0; }
        }
      `}</style>
      <div className="mono" style={{ fontSize: 12, marginBottom: 4 }}>
        {product.name}
      </div>
      <svg
        width={width}
        height={height + 16}
        viewBox={`0 0 ${width} ${height + 16}`}
        role="img"
        aria-label={`${code.symbology} ${code.text}`}
        style={{ background: '#fff' }}
      >
        {[...code.modules].map((m, i) =>
          m === '1' ? <rect key={i} x={quiet + i * module} y={0} width={module} height={height} fill="#000" /> : null,
        )}
        <text x={width / 2} y={height + 13} textAnchor="middle" fontFamily="monospace" fontSize={12} fill="#000">
          {code.text}
        </text>
      </svg>
      <div className="mono table__id" style={{ fontSize: 11 }}>
        {product.sku} · {code.symbology}
      </div>
    </div>
  );
}

import { monogram } from '../format';

/**
 * The standard product-image placeholder: an inline SVG rendering the
 * product's monogram initials on its accent color. NO binary image
 * files ship with this module — if you have real product photography,
 * this component is the one place to swap in an <img>, and the
 * product's `accent` column is where an image URL/path column would go.
 */
export function ProductMark({
  name,
  accent,
  size = 'card',
}: {
  name: string;
  accent: string | null;
  size?: 'card' | 'hero' | 'thumb';
}) {
  const color = accent ?? '#4A4A46';
  return (
    <svg
      className={`mark mark--${size}`}
      viewBox="0 0 100 100"
      role="img"
      aria-label={name}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect width="100" height="100" fill={color} opacity="0.16" />
      <rect x="0.5" y="0.5" width="99" height="99" fill="none" stroke={color} opacity="0.5" />
      <text
        x="50"
        y="54"
        textAnchor="middle"
        dominantBaseline="middle"
        fill={color}
        fontFamily="'JetBrains Mono', ui-monospace, monospace"
        fontSize="30"
        fontWeight="600"
        letterSpacing="2"
      >
        {monogram(name)}
      </text>
    </svg>
  );
}

import { useEffect, useState } from 'react';
import type { PreviewKind } from '../../shared/types';
import type { VersionText } from '../api';

/**
 * A version as the browser may show it: a PDF in the browser's own viewer, an
 * image, or — for everything else — the text read out of it. The server
 * decides which from the file's bytes and serves only PDFs and images
 * inline; HTML and SVG arrive here as plain text and are rendered as text.
 */
export function Preview({
  kind,
  inlineUrl,
  loadText,
  title,
}: {
  kind: PreviewKind | null;
  inlineUrl: string;
  loadText: () => Promise<VersionText>;
  title: string;
}) {
  const [text, setText] = useState<VersionText | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setText(null);
    setError('');
    if (kind === 'text' || kind === null) {
      loadText()
        .then(setText)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the text'));
    }
  }, [kind, inlineUrl, loadText]);

  if (kind === 'pdf') return <iframe className="preview preview--pdf" src={inlineUrl} title={title} />;
  if (kind === 'image') {
    return (
      <div className="preview preview--image">
        <img src={inlineUrl} alt={title} />
      </div>
    );
  }
  if (kind === 'none') return <p className="detail__none mono">NO PREVIEW FOR THIS FILE TYPE — DOWNLOAD IT</p>;
  if (error) return <div className="page__error mono">{error}</div>;
  if (!text) return <p className="detail__none mono">LOADING…</p>;
  if (text.status !== 'text') {
    const why: Record<string, string> = {
      empty: 'NO TEXT IN THIS FILE — A SCAN OR A PICTURE',
      encrypted: 'THE FILE IS ENCRYPTED',
      unsupported: 'NO PREVIEW FOR THIS FILE TYPE — DOWNLOAD IT',
      failed: 'THE FILE COULD NOT BE READ',
    };
    return <p className="detail__none mono">{why[text.status ?? ''] ?? 'NO PREVIEW'}</p>;
  }
  return (
    <pre className="preview preview--text">
      {text.text}
      {text.truncated && '\n\n… (the rest is in the download)'}
    </pre>
  );
}

/** A search passage with the words found marked (\u0002 … \u0003 from the server). */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g);
  return (
    <span className="snippet">
      {parts.map((p, i) => (p.startsWith('\u0002') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

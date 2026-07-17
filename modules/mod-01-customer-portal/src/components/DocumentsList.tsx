import { useEffect, useState } from 'react';
import type { DocumentMeta } from '../../shared/types';
import { api, ApiError, documentDownloadUrl } from '../api';
import { formatBytes, formatDate } from '../format';

export function DocumentsList({ onAuthLost }: { onAuthLost: () => void }) {
  const [documents, setDocuments] = useState<DocumentMeta[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .documents()
      .then((data) => setDocuments(data.documents))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onAuthLost();
        else setError(err instanceof Error ? err.message : 'Failed to load');
      });
  }, [onAuthLost]);

  return (
    <section>
      <header className="page__head">
        <div className="page__eyebrow mono">SELF-SERVICE · DOCUMENTS</div>
        <h1 className="page__title">Your documents</h1>
        <p className="page__desc">Invoices, delivery notes and statements — download any time.</p>
      </header>

      {error && <div className="page__error mono">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="mono">TYPE</th>
              <th className="mono">TITLE</th>
              <th className="mono">ORDER</th>
              <th className="mono">DATE</th>
              <th className="mono">SIZE</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(documents ?? []).map((doc) => (
              <tr key={doc.id}>
                <td className="mono">{doc.doc_type.replace('_', ' ').toUpperCase()}</td>
                <td>{doc.title}</td>
                <td className="mono">{doc.order_no ?? '—'}</td>
                <td>{formatDate(doc.created_at)}</td>
                <td className="table__num">{formatBytes(doc.size_bytes)}</td>
                <td>
                  <a className="rowbtn mono" href={documentDownloadUrl(doc.id)} download>
                    DOWNLOAD ↓
                  </a>
                </td>
              </tr>
            ))}
            {documents !== null && documents.length === 0 && (
              <tr>
                <td className="table__empty mono" colSpan={6}>
                  NO DOCUMENTS
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

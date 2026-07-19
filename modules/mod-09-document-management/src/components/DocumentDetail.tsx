import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  formatBytes,
  MATTER_ROLE_RANK,
  type DocumentDetail as DetailData,
} from '../../shared/types';
import { api, ApiError, downloadUrl } from '../api';
import { formatDateTime } from '../format';

interface Props {
  id: number;
  onBack: () => void;
  onOpenMatter: (id: number) => void;
  onAuthLost: () => void;
}

export function DocumentDetail({ id, onBack, onOpenMatter, onAuthLost }: Props) {
  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.document(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      else if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [id, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) {
    return (
      <>
        <button className="backlink mono" onClick={onBack}>
          ← DOCUMENTS
        </button>
        <p className="detail__none mono">DOCUMENT NOT FOUND</p>
      </>
    );
  }
  if (!data) return <div className="boot mono">LOADING…</div>;

  const { document: doc, versions, activity, matter_role } = data;
  const canEdit = MATTER_ROLE_RANK[matter_role] >= MATTER_ROLE_RANK.editor;
  const canOwn = MATTER_ROLE_RANK[matter_role] >= MATTER_ROLE_RANK.owner;
  const current = doc.current_version;

  async function del() {
    if (!window.confirm('Soft-delete this document? History is retained but it will be hidden.')) return;
    try {
      await api.deleteDocument(id);
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <>
      <button className="backlink mono" onClick={onBack}>
        ← DOCUMENTS
      </button>
      <div className="page__head page__head--split">
        <div>
          <button className="page__eyebrow mono linklike" onClick={() => onOpenMatter(doc.matter_id)}>
            {doc.matter_key} ↗
          </button>
          <h1 className="page__title">{doc.title}</h1>
          <p className="page__desc">
            Current version v{current} · {versions.length} version{versions.length === 1 ? '' : 's'} · created by {doc.created_by_name}
          </p>
        </div>
        <div className="head__actions">
          <a className="btn btn--primary" href={downloadUrl(id)}>
            DOWNLOAD CURRENT ↓
          </a>
          {canOwn && (
            <button className="btn btn--danger" onClick={() => void del()}>
              DELETE
            </button>
          )}
        </div>
      </div>

      {error && <div className="page__error mono">{error}</div>}

      <div className="detail">
        <div className="detail__col">
          <h2 className="detail__heading mono">VERSION HISTORY</h2>
          <div className="table-wrap">
            <table className="table table--tight">
              <thead>
                <tr>
                  <th className="table__num">Ver</th>
                  <th>Uploaded</th>
                  <th>By</th>
                  <th className="table__num">Size</th>
                  <th>SHA-256</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <tr key={v.id}>
                      <td className="table__num">
                        v{v.version_no}
                        {v.version_no === current && <span className="tag mono tag--current">current</span>}
                      </td>
                      <td className="mono">{formatDateTime(v.uploaded_at)}</td>
                      <td>{v.uploaded_by_name}</td>
                      <td className="table__num">{formatBytes(v.size_bytes)}</td>
                      <td className="mono sha">{v.sha256.slice(0, 12)}…</td>
                      <td>
                        <a className="rowbtn" href={downloadUrl(id, v.version_no)}>
                          ↓
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {canEdit && <VersionUpload documentId={id} title={doc.title} onDone={() => void load()} />}

          <h2 className="detail__heading mono">TAGS</h2>
          <TagEditor documentId={id} tags={doc.tags} canEdit={canEdit} onChange={() => void load()} />
        </div>

        <div className="detail__col">
          <h2 className="detail__heading mono">ACTIVITY</h2>
          <ul className="timeline">
            {activity.map((a, i) => (
              <li key={i} className={`timeline__step ${i === 0 ? 'is-current' : ''}`}>
                <span className="timeline__dot" />
                <div>
                  <div className="timeline__status">{a.kind === 'document_created' ? 'CREATED' : `VERSION ${a.version_no}`}</div>
                  <div className="timeline__at mono">
                    {formatDateTime(a.at)} · {a.actor_name}
                  </div>
                  <div className="timeline__note">{a.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function VersionUpload({ documentId, title, onDone }: { documentId: number; title: string; onDone: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.uploadVersion(documentId, file, title);
      if (fileRef.current) fileRef.current.value = '';
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card card--form" onSubmit={(e) => void submit(e)}>
      <div className="formrow">
        <label className="field field--grow">
          <span className="field__label mono">UPLOAD NEW VERSION</span>
          <input className="field__input field__input--file" type="file" ref={fileRef} />
        </label>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'UPLOADING…' : 'ADD VERSION'}
        </button>
      </div>
      {error && <div className="login__error mono">{error}</div>}
    </form>
  );
}

function TagEditor({
  documentId,
  tags,
  canEdit,
  onChange,
}: {
  documentId: number;
  tags: string[];
  canEdit: boolean;
  onChange: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setError('');
    try {
      await api.addTag(documentId, value.trim().toLowerCase());
      setValue('');
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function remove(tag: string) {
    try {
      await api.removeTag(documentId, tag);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <div className="tagbox">
      <div className="tagbox__tags">
        {tags.length === 0 && <span className="detail__none mono">NO TAGS</span>}
        {tags.map((t) => (
          <span key={t} className="tag mono">
            {t}
            {canEdit && (
              <button className="tag__x" onClick={() => void remove(t)}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {canEdit && (
        <form className="tagbox__add" onSubmit={(e) => void add(e)}>
          <input className="field__input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="add tag" />
          <button className="btn btn--primary" type="submit">
            ADD
          </button>
        </form>
      )}
      {error && <div className="login__error mono">{error}</div>}
    </div>
  );
}

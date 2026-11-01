import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  formatBytes,
  MATTER_ROLE_RANK,
  type DocumentDetail as DetailData,
  type DocumentVersion,
  type RetentionClass,
  type RetentionInfo,
  type ShareLink,
} from '../../shared/types';
import { api, ApiError, downloadUrl, errorText, previewUrl } from '../api';
import { formatDate, formatDateTime } from '../format';
import { Preview } from './Preview';

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
  const [shown, setShown] = useState<number | null>(null);

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
  const previewed = versions.find((v) => v.version_no === (shown ?? current)) ?? versions[versions.length - 1]!;

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
                      <td className="mono sha" title={v.sha256}>
                        {v.sha256.slice(0, 8)}…
                      </td>
                      <td className="table__actions">
                        <button className={`rowbtn ${v.version_no === previewed.version_no ? 'is-on' : ''}`} onClick={() => setShown(v.version_no)} title="Preview">
                          VIEW
                        </button>
                        <a className="rowbtn" href={downloadUrl(id, v.version_no)} title="Download">
                          ↓
                        </a>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {canEdit && <VersionUpload documentId={id} title={doc.title} onDone={() => void load()} />}

          <h2 className="detail__heading mono">PREVIEW · V{previewed.version_no}</h2>
          <VersionPreview documentId={id} version={previewed} title={doc.title} />

          <h2 className="detail__heading mono">TAGS</h2>
          <TagEditor documentId={id} tags={doc.tags} canEdit={canEdit} onChange={() => void load()} />
        </div>

        <div className="detail__col">
          <h2 className="detail__heading mono">RETENTION</h2>
          <RetentionPanel documentId={id} retention={data.retention} canOwn={canOwn} onChange={() => void load()} />

          {data.shares !== null && (
            <>
              <h2 className="detail__heading mono">SHARE LINKS</h2>
              <SharesPanel documentId={id} data={data} onChange={() => void load()} />
            </>
          )}

          {data.events.length > 0 && (
            <>
              <h2 className="detail__heading mono">DECISIONS</h2>
              <ul className="timeline">
                {data.events.map((e, i) => (
                  <li key={i} className="timeline__step">
                    <span className="timeline__dot" />
                    <div>
                      <div className="timeline__status">{EVENT_LABEL[e.kind]}</div>
                      <div className="timeline__at mono">
                        {formatDateTime(e.at)} · {e.actor_name}
                      </div>
                      <div className="timeline__note">{e.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

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

const EVENT_LABEL: Record<DetailData['events'][number]['kind'], string> = {
  retention_set: 'RETENTION SET',
  hold_set: 'LEGAL HOLD',
  hold_released: 'HOLD RELEASED',
  share_created: 'LINK CREATED',
  share_revoked: 'LINK REVOKED',
};

function VersionPreview({ documentId, version, title }: { documentId: number; version: DocumentVersion; title: string }) {
  const loadText = useCallback(() => api.versionText(documentId, version.version_no), [documentId, version.version_no]);
  return <Preview kind={version.preview} inlineUrl={previewUrl(documentId, version.version_no)} loadText={loadText} title={title} />;
}

function RetentionPanel({ documentId, retention, canOwn, onChange }: { documentId: number; retention: RetentionInfo; canOwn: boolean; onChange: () => void }) {
  const [classes, setClasses] = useState<RetentionClass[]>([]);
  const [editing, setEditing] = useState(false);
  const [classId, setClassId] = useState<string>(retention.class_id ? String(retention.class_id) : '');
  const [date, setDate] = useState(retention.document_date_set ? retention.document_date : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (canOwn) void api.retentionClasses().then((r) => setClasses(r.classes)).catch(() => setClasses([]));
  }, [canOwn]);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      setEditing(false);
      setReason('');
      onChange();
    } catch (err) {
      setError(errorText(err, 'Failed'));
    }
  }

  return (
    <div className="card">
      <dl className="proplist">
        <dt>Class</dt>
        <dd>{retention.class_name ? `${retention.class_name} · ${retention.years} years` : 'None — never due for disposal'}</dd>
        {retention.basis && (
          <>
            <dt>Legal basis</dt>
            <dd>{retention.basis}</dd>
          </>
        )}
        <dt>Document date</dt>
        <dd>
          {retention.document_date}
          {!retention.document_date_set && <span className="detail__hint"> (upload date)</span>}
        </dd>
        {retention.retention_end && (
          <>
            <dt>Keep until</dt>
            <dd>
              {retention.retention_end}
              {retention.due && <span className="tag mono tag--due">due for disposal</span>}
            </dd>
          </>
        )}
        <dt>Legal hold</dt>
        <dd>{retention.legal_hold ? `${retention.legal_hold.reason} — ${retention.legal_hold.by_name}, ${formatDate(retention.legal_hold.at)}` : 'None'}</dd>
      </dl>
      {canOwn && !editing && (
        <div className="stack">
          <button className="btn btn--ghost" onClick={() => setEditing(true)}>
            CHANGE RETENTION
          </button>
          {retention.legal_hold ? (
            <button className="btn btn--ghost" onClick={() => void run(() => api.releaseLegalHold(documentId))}>
              RELEASE HOLD
            </button>
          ) : (
            <form className="formrow holdform" onSubmit={(e) => (e.preventDefault(), void run(() => api.setLegalHold(documentId, reason)))}>
              <input className="field__input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason for a legal hold" />
              <button className="btn btn--ghost" type="submit" disabled={!reason.trim()}>
                HOLD
              </button>
            </form>
          )}
        </div>
      )}
      {canOwn && editing && (
        <form className="formrow" onSubmit={(e) => (e.preventDefault(), void run(() => api.setRetention(documentId, { retention_class_id: classId ? Number(classId) : null, document_date: date || null })))}>
          <label className="field field--grow">
            <span className="field__label mono">CLASS</span>
            <select className="field__input" value={classId} onChange={(e) => setClassId(e.target.value)}>
              <option value="">No class</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.years} years
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label mono">DOCUMENT DATE</span>
            <input className="field__input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button className="btn btn--primary" type="submit">
            SAVE
          </button>
          <button className="btn btn--ghost" type="button" onClick={() => setEditing(false)}>
            CANCEL
          </button>
        </form>
      )}
      {error && <div className="login__error mono">{error}</div>}
    </div>
  );
}

const STATUS_LABEL: Record<ShareLink['status'], string> = { active: 'active', expired: 'expired', revoked: 'revoked', used_up: 'used up' };

function SharesPanel({ documentId, data, onChange }: { documentId: number; data: DetailData; onChange: () => void }) {
  const [version, setVersion] = useState('');
  const [days, setDays] = useState('');
  const [password, setPassword] = useState('');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [note, setNote] = useState('');
  const [created, setCreated] = useState('');
  const [error, setError] = useState('');

  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const res = await api.createShare(documentId, {
        version_no: version ? Number(version) : null,
        days: days ? Number(days) : undefined,
        password: password || undefined,
        max_downloads: maxDownloads ? Number(maxDownloads) : null,
        note,
      });
      setCreated(`${window.location.origin}${res.path}`);
      setPassword('');
      setNote('');
      onChange();
    } catch (err) {
      setError(errorText(err, 'Could not create the link'));
    }
  }

  async function revoke(id: number) {
    if (!window.confirm('Revoke this link? It stops working at once.')) return;
    try {
      await api.revokeShare(id);
      onChange();
    } catch (err) {
      setError(errorText(err, 'Could not revoke the link'));
    }
  }

  const shares = data.shares ?? [];
  return (
    <div className="card">
      {shares.length === 0 && <p className="detail__none mono">NO LINKS</p>}
      {shares.length > 0 && (
        <ul className="sharelist">
          {shares.map((l) => (
            <li key={l.id} className="sharelist__item">
              <div className="sharelist__main">
                <span>
                  #{l.id} · {l.version_no === null ? 'current version' : `v${l.version_no}`} · until {formatDate(l.expires_at)} · {l.downloads}
                  {l.max_downloads !== null && ` / ${l.max_downloads}`} downloads{l.has_password && ' · password'}
                </span>
                <span className={`tag mono tag--${l.status}`}>{STATUS_LABEL[l.status]}</span>
                {l.can_revoke && (
                  <button className="rowbtn" onClick={() => void revoke(l.id)}>
                    REVOKE
                  </button>
                )}
              </div>
              <div className="detail__hint">
                {l.created_by_name}, {formatDate(l.created_at)}
                {l.note && ` — ${l.note}`}
                {l.last_used_at && ` · last used ${formatDateTime(l.last_used_at)}`}
                {l.revoked_by_name && ` · revoked by ${l.revoked_by_name}`}
              </div>
            </li>
          ))}
        </ul>
      )}
      {created && (
        <div className="sharebox">
          <span className="field__label mono">NEW LINK — SHOWN ONCE, ONLY ITS HASH IS STORED</span>
          <div className="formrow">
            <input className="field__input mono" readOnly value={created} onFocus={(e) => e.target.select()} />
            <button className="btn btn--ghost" onClick={() => void navigator.clipboard?.writeText(created)}>
              COPY
            </button>
          </div>
        </div>
      )}
      {data.can_share ? (
        <form className="shareform" onSubmit={(e) => void create(e)}>
          <label className="field">
            <span className="field__label mono">VERSION</span>
            <select className="field__input" value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value="">Always the current</option>
              {data.versions
                .slice()
                .reverse()
                .map((v) => (
                  <option key={v.version_no} value={v.version_no}>
                    Only v{v.version_no}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label mono">DAYS</span>
            <input className="field__input" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder="default" />
          </label>
          <label className="field">
            <span className="field__label mono">PASSWORD</span>
            <input className="field__input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="optional" autoComplete="new-password" />
          </label>
          <label className="field">
            <span className="field__label mono">MAX DOWNLOADS</span>
            <input className="field__input" type="number" min={1} value={maxDownloads} onChange={(e) => setMaxDownloads(e.target.value)} placeholder="no limit" />
          </label>
          <label className="field field--grow">
            <span className="field__label mono">FOR</span>
            <input className="field__input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. tax adviser" />
          </label>
          <button className="btn btn--primary" type="submit">
            CREATE LINK
          </button>
        </form>
      ) : (
        <p className="detail__hint">
          {data.share_policy === 'off' ? 'Share links are switched off by the administrator.' : 'Only owners of this matter may create share links.'}
        </p>
      )}
      {error && <div className="login__error mono">{error}</div>}
    </div>
  );
}

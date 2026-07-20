import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  MATTER_ROLE_RANK,
  type DocumentSummary,
  type MatterMember,
  type MatterRole,
  type MatterSummary,
  type UserProfile,
  type UserRef,
} from '../../shared/types';
import { api, ApiError } from '../api';
import { formatDate } from '../format';

interface Props {
  id: number;
  user: UserProfile;
  onBack: () => void;
  onOpenDocument: (id: number) => void;
  onAuthLost: () => void;
}

export function MatterDetail({ id, user, onBack, onOpenDocument, onAuthLost }: Props) {
  const [matter, setMatter] = useState<MatterSummary | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [members, setMembers] = useState<MatterMember[]>([]);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ matter: m }, { documents: docs }, { members: mem }] = await Promise.all([
        api.matter(id),
        api.documents({ matter: id }),
        api.members(id),
      ]);
      setMatter(m);
      setDocuments(docs);
      setMembers(mem);
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
          ← MATTERS
        </button>
        <p className="detail__none mono">MATTER NOT FOUND</p>
      </>
    );
  }
  if (!matter) return <div className="boot mono">LOADING…</div>;

  const canEdit = MATTER_ROLE_RANK[matter.role] >= MATTER_ROLE_RANK.editor;
  const canOwn = MATTER_ROLE_RANK[matter.role] >= MATTER_ROLE_RANK.owner;

  return (
    <>
      <button className="backlink mono" onClick={onBack}>
        ← MATTERS
      </button>
      <div className="page__head">
        <div className="page__eyebrow mono">{matter.key} · YOUR ROLE {matter.role.toUpperCase()}</div>
        <h1 className="page__title">{matter.name}</h1>
        {matter.description && <p className="page__desc">{matter.description}</p>}
      </div>

      {error && <div className="page__error mono">{error}</div>}

      {canEdit && <UploadForm matterId={id} onDone={() => void load()} />}

      <h2 className="detail__heading mono">DOCUMENTS ({documents.length})</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Tags</th>
              <th className="table__num">Version</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {documents.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={5}>
                  NO DOCUMENTS
                </td>
              </tr>
            )}
            {documents.map((d) => (
              <tr key={d.id} className="table__row-link" onClick={() => onOpenDocument(d.id)}>
                <td>{d.title}</td>
                <td>
                  {d.tags.map((t) => (
                    <span key={t} className="tag mono">
                      {t}
                    </span>
                  ))}
                </td>
                <td className="table__num">v{d.current_version}</td>
                <td className="mono">{formatDate(d.updated_at)}</td>
                <td className="table__arrow">→</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="detail__heading mono">MEMBERS ({members.length})</h2>
      <MembersPanel
        matterId={id}
        members={members}
        canManage={canOwn}
        currentUserId={user.id}
        onChange={() => void load()}
      />
    </>
  );
}

function UploadForm({ matterId, onDone }: { matterId: number; onDone: () => void }) {
  const [title, setTitle] = useState('');
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
      await api.uploadDocument(matterId, file, title || file.name);
      setTitle('');
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
          <span className="field__label mono">NEW DOCUMENT TITLE</span>
          <input className="field__input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to file name" />
        </label>
        <label className="field">
          <span className="field__label mono">FILE</span>
          <input className="field__input field__input--file" type="file" ref={fileRef} />
        </label>
      </div>
      {error && <div className="login__error mono">{error}</div>}
      <button className="btn btn--primary" type="submit" disabled={busy}>
        {busy ? 'UPLOADING…' : 'UPLOAD DOCUMENT'}
      </button>
    </form>
  );
}

function MembersPanel({
  matterId,
  members,
  canManage,
  currentUserId,
  onChange,
}: {
  matterId: number;
  members: MatterMember[];
  canManage: boolean;
  currentUserId: number;
  onChange: () => void;
}) {
  const [users, setUsers] = useState<UserRef[]>([]);
  const [pickUser, setPickUser] = useState('');
  const [pickRole, setPickRole] = useState<MatterRole>('viewer');
  const [error, setError] = useState('');

  useEffect(() => {
    if (canManage) void api.users().then(({ users: u }) => setUsers(u)).catch(() => setUsers([]));
  }, [canManage]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!pickUser) return;
    setError('');
    try {
      await api.addMember(matterId, Number(pickUser), pickRole);
      setPickUser('');
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function remove(userId: number) {
    setError('');
    try {
      await api.removeMember(matterId, userId);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  const memberIds = new Set(members.map((m) => m.user_id));
  const candidates = users.filter((u) => !memberIds.has(u.id));

  return (
    <div className="table-wrap">
      <table className="table table--tight">
        <thead>
          <tr>
            <th>Name</th>
            <th>Username</th>
            <th>Role</th>
            {canManage && <th />}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id}>
              <td>{m.name}</td>
              <td className="mono">{m.username}</td>
              <td>
                <span className="badge">{m.role}</span>
              </td>
              {canManage && (
                <td>
                  {m.user_id !== currentUserId && (
                    <button className="rowbtn" onClick={() => void remove(m.user_id)}>
                      REMOVE
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <form className="memberadd" onSubmit={(e) => void add(e)}>
          <select className="field__input toolbar__select" value={pickUser} onChange={(e) => setPickUser(e.target.value)}>
            <option value="">Add member…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.username})
              </option>
            ))}
          </select>
          <select className="field__input toolbar__select" value={pickRole} onChange={(e) => setPickRole(e.target.value as MatterRole)}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="owner">owner</option>
          </select>
          <button className="btn btn--primary" type="submit" disabled={!pickUser}>
            ADD
          </button>
          {error && <span className="login__error mono">{error}</span>}
        </form>
      )}
    </div>
  );
}

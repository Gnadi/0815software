import { useRef, useState } from 'react';
import type { AttachmentInfo, AttachmentUpload } from '../../shared/types';

/**
 * Files on tickets, for every form that sends them and every thread that
 * shows them. They go to the server base64 in the request's JSON; the limits
 * are checked here first so nobody waits for an upload the server refuses.
 */

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

export async function toUploads(files: File[]): Promise<AttachmentUpload[]> {
  return Promise.all(files.map(async (f) => ({ filename: f.name, content_type: f.type || 'application/octet-stream', content_base64: await toBase64(f) })));
}

export function FilePicker({ files, onChange, maxBytes, perMessage, disabled }: { files: File[]; onChange: (files: File[]) => void; maxBytes: number; perMessage: number; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState('');
  const add = (chosen: FileList | null) => {
    if (!chosen) return;
    const next = [...files];
    const refused: string[] = [];
    for (const f of Array.from(chosen)) {
      if (f.size > maxBytes) refused.push(`${f.name} is ${fmtBytes(f.size)} (at most ${fmtBytes(maxBytes)})`);
      else if (next.length >= perMessage) refused.push(`${f.name}: at most ${perMessage} files`);
      else next.push(f);
    }
    setProblem(refused.join(' · '));
    onChange(next);
    if (input.current) input.current.value = '';
  };
  return (
    <div className="files">
      <div className="files__row">
        <button type="button" className="btn btn--ghost btn--sm" disabled={disabled || files.length >= perMessage} onClick={() => input.current?.click()}>
          ATTACH FILES
        </button>
        <span className="files__hint mono">
          UP TO {perMessage} · {fmtBytes(maxBytes)} EACH
        </span>
        <input ref={input} type="file" multiple hidden onChange={(e) => add(e.target.files)} />
      </div>
      {problem && <div className="field__error mono">{problem}</div>}
      {files.length > 0 && (
        <ul className="files__list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span>{f.name}</span>
              <span className="mono files__size">{fmtBytes(f.size)}</span>
              <button type="button" className="linklike mono" onClick={() => onChange(files.filter((_, j) => j !== i))}>
                REMOVE
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AttachmentList({ attachments, href }: { attachments: AttachmentInfo[]; href: (id: number) => string }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="files__list files__list--links">
      {attachments.map((a) => (
        <li key={a.id}>
          <a className="linklike" href={href(a.id)} download={a.filename}>
            ⤓ {a.filename}
          </a>
          <span className="mono files__size">{fmtBytes(a.size)}</span>
        </li>
      ))}
    </ul>
  );
}

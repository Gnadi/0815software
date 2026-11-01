import { AuditClient, FilesClient, SearchClient, ServiceError } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services (best-effort, opt-in):
 *   - PS-06 File Storage — mirror each uploaded document version to shared
 *     object storage (the module keeps its own local copy either way)
 *   - PS-07 Audit Log    — record uploads, share links and disposals on the
 *     tamper-evident trail
 *   - PS-09 Search       — index each document's title and text, with its
 *     matter as a facet, for search across modules
 * With no URL configured the module runs standalone; a downstream outage never
 * fails the local operation.
 *
 * Search inside this module never asks PS-09: its own index answers, behind
 * the matter check (docs.ts). PS-09 holds a copy for other consumers, which
 * reach it with the machine token — the same trust as the PS-06 mirror of
 * the bytes themselves — and loses it when the document is deleted.
 */

export interface PlatformConfig {
  filesUrl?: string;
  auditUrl?: string;
  searchUrl?: string;
  serviceToken?: string;
  bucket?: string;
}

export interface DocumentUploadInfo {
  actor: string;
  docId: number;
  matterId: number;
  version: number;
  bytes: Buffer;
  contentType: string;
  title: string;
  /** The text read out of the version, for PS-09. */
  text: string;
}

export interface AuditEntry {
  actor: string;
  action: string;
  resource: string;
  metadata?: Record<string, unknown>;
}

/** What became of each copy outside the module when a document went away. */
export type MirrorOutcome = Record<string, 'removed' | 'failed' | 'not configured'>;

export interface PlatformHooks {
  documentUploaded(info: DocumentUploadInfo): Promise<void>;
  /** Drop the copies outside the module: PS-09 always, PS-06 when `versions` is given. */
  documentRemoved(docId: number, versions?: number[]): Promise<MirrorOutcome>;
  audit(entry: AuditEntry): Promise<void>;
}

export const noopPlatform: PlatformHooks = {
  async documentUploaded() {
    /* standalone */
  },
  async documentRemoved() {
    return {};
  },
  async audit() {
    /* standalone */
  },
};

/** PS-09 gets enough text to find a document by, not a second archive. */
const MAX_INDEXED_CHARS = 100_000;

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const files = cfg.filesUrl ? new FilesClient({ baseUrl: cfg.filesUrl, serviceToken: cfg.serviceToken }) : null;
  const auditClient = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const searchClient = cfg.searchUrl ? new SearchClient({ baseUrl: cfg.searchUrl, serviceToken: cfg.serviceToken }) : null;
  if (!files && !auditClient && !searchClient) return noopPlatform;
  const bucket = cfg.bucket ?? 'documents';
  let bucketReady = false;

  const audit = async (entry: AuditEntry): Promise<void> => {
    if (!auditClient) return;
    try {
      await auditClient.record(entry);
    } catch (err) {
      console.warn('[mod-09] audit failed:', err);
    }
  };

  return {
    audit,

    async documentUploaded(info: DocumentUploadInfo): Promise<void> {
      if (files) {
        try {
          if (!bucketReady) {
            await files.createBucket(bucket).catch((err) => {
              // A 409 just means the bucket already exists — ignore it.
              if (!(err instanceof ServiceError) || err.status !== 409) throw err;
            });
            bucketReady = true;
          }
          await files.put(bucket, `${info.docId}/v${info.version}`, info.bytes, { content_type: info.contentType });
        } catch (err) {
          console.warn('[mod-09] file mirror failed:', err);
        }
      }
      await audit({ actor: info.actor, action: 'document.uploaded', resource: `document:${info.docId}`, metadata: { version: info.version, title: info.title } });
      if (searchClient) {
        try {
          await searchClient.index({
            collection: 'documents',
            id: String(info.docId),
            title: info.title,
            body: info.text.slice(0, MAX_INDEXED_CHARS),
            facets: { matter: String(info.matterId) },
          });
        } catch (err) {
          console.warn('[mod-09] search index failed:', err);
        }
      }
    },

    async documentRemoved(docId: number, versions?: number[]): Promise<MirrorOutcome> {
      const outcome: MirrorOutcome = { search: 'not configured', files: 'not configured' };
      if (searchClient) {
        try {
          await searchClient.remove('documents', String(docId));
          outcome.search = 'removed';
        } catch (err) {
          // Gone already is what we wanted.
          outcome.search = err instanceof ServiceError && err.status === 404 ? 'removed' : 'failed';
        }
      }
      if (files && versions) {
        outcome.files = 'removed';
        for (const v of versions) {
          try {
            await files.remove(bucket, `${docId}/v${v}`);
          } catch (err) {
            if (!(err instanceof ServiceError && err.status === 404)) outcome.files = 'failed';
          }
        }
      }
      if (!versions) delete outcome.files;
      return outcome;
    },
  };
}

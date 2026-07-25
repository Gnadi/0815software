import { AuditClient, FilesClient, SearchClient, ServiceError, type SearchResult } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services (best-effort, opt-in):
 *   - PS-06 File Storage — mirror each uploaded document version to shared
 *     object storage (the module keeps its own local copy either way)
 *   - PS-07 Audit Log    — record uploads on the tamper-evident trail
 *   - PS-09 Search       — index each document for cross-entity search, and
 *     back GET /api/search with it
 * With no URL configured the module runs standalone; a downstream outage never
 * fails the upload.
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
  version: number;
  bytes: Buffer;
  contentType: string;
  title: string;
}

export interface PlatformHooks {
  documentUploaded(info: DocumentUploadInfo): Promise<void>;
  /** Search indexed documents via PS-09, or null when Search is unconfigured. */
  searchDocuments(q: string): Promise<SearchResult | null>;
}

export const noopPlatform: PlatformHooks = {
  async documentUploaded() {
    /* standalone */
  },
  async searchDocuments() {
    return null;
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const files = cfg.filesUrl ? new FilesClient({ baseUrl: cfg.filesUrl, serviceToken: cfg.serviceToken }) : null;
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const searchClient = cfg.searchUrl ? new SearchClient({ baseUrl: cfg.searchUrl, serviceToken: cfg.serviceToken }) : null;
  if (!files && !audit && !searchClient) return noopPlatform;
  const bucket = cfg.bucket ?? 'documents';
  let bucketReady = false;

  return {
    async searchDocuments(q: string): Promise<SearchResult | null> {
      if (!searchClient) return null;
      return searchClient.search({ collection: 'documents', q });
    },

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
      if (audit) {
        try {
          await audit.record({
            actor: info.actor,
            action: 'document.uploaded',
            resource: `document:${info.docId}`,
            metadata: { version: info.version, title: info.title },
          });
        } catch (err) {
          console.warn('[mod-09] audit failed:', err);
        }
      }
      if (searchClient) {
        try {
          await searchClient.index({ collection: 'documents', id: String(info.docId), title: info.title });
        } catch (err) {
          console.warn('[mod-09] search index failed:', err);
        }
      }
    },
  };
}

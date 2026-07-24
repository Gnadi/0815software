import { AuditClient, FilesClient, ServiceError } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services (best-effort, opt-in):
 *   - PS-06 File Storage — mirror each uploaded document version to shared
 *     object storage (the module keeps its own local copy either way)
 *   - PS-07 Audit Log    — record uploads on the tamper-evident trail
 * With no URL configured the module runs standalone; a downstream outage never
 * fails the upload.
 */

export interface PlatformConfig {
  filesUrl?: string;
  auditUrl?: string;
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
}

export const noopPlatform: PlatformHooks = {
  async documentUploaded() {
    /* standalone */
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const files = cfg.filesUrl ? new FilesClient({ baseUrl: cfg.filesUrl, serviceToken: cfg.serviceToken }) : null;
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  if (!files && !audit) return noopPlatform;
  const bucket = cfg.bucket ?? 'documents';
  let bucketReady = false;

  return {
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
    },
  };
}

/**
 * PS-06 File / Object Storage — wire contract shared between server and clients.
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface Bucket {
  name: string;
  created_at: string;
}

export interface ObjectInfo {
  bucket: string;
  key: string;
  size: number;
  content_type: string;
  sha256: string;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

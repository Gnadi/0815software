import type { ProviderInfo } from '../shared/types.js';

/**
 * The third-party provider registry is config-as-code (mod-06 profiles
 * pattern): each entry declares a base URL, how outbound requests
 * authenticate, and how inbound webhook signatures are verified. The
 * import-time self-check rejects an invalid entry at boot rather than at
 * request time.
 */

export type AuthType = 'bearer' | 'basic' | 'apikey' | 'oauth2';
export type SignatureScheme = 'github' | 'stripe' | 'shopify' | 'hmac-sha256' | 'none';

export interface ProviderEntry extends ProviderInfo {
  base_url: string;
  auth_type: AuthType;
  signature_scheme: SignatureScheme;
  /** Inbound webhook header carrying the signature (when applicable). */
  signature_header: string | null;
  signature_encoding: 'hex' | 'base64';
  signature_prefix: string;
}

const AUTH_TYPES: AuthType[] = ['bearer', 'basic', 'apikey', 'oauth2'];
const SIGNATURE_SCHEMES: SignatureScheme[] = ['github', 'stripe', 'shopify', 'hmac-sha256', 'none'];

export const REGISTRY: readonly ProviderEntry[] = [
  { key: 'google', name: 'Google Workspace', base_url: 'https://www.googleapis.com', auth_type: 'oauth2', signature_scheme: 'none', signature_header: null, signature_encoding: 'hex', signature_prefix: '' },
  { key: 'microsoft', name: 'Microsoft 365', base_url: 'https://graph.microsoft.com', auth_type: 'oauth2', signature_scheme: 'none', signature_header: null, signature_encoding: 'hex', signature_prefix: '' },
  { key: 'stripe', name: 'Stripe', base_url: 'https://api.stripe.com', auth_type: 'bearer', signature_scheme: 'stripe', signature_header: 'stripe-signature', signature_encoding: 'hex', signature_prefix: '' },
  { key: 'github', name: 'GitHub', base_url: 'https://api.github.com', auth_type: 'bearer', signature_scheme: 'github', signature_header: 'x-hub-signature-256', signature_encoding: 'hex', signature_prefix: 'sha256=' },
  { key: 'shopify', name: 'Shopify', base_url: 'https://example.myshopify.com/admin/api', auth_type: 'apikey', signature_scheme: 'shopify', signature_header: 'x-shopify-hmac-sha256', signature_encoding: 'base64', signature_prefix: '' },
  { key: 'rest', name: 'Generic REST', base_url: '', auth_type: 'bearer', signature_scheme: 'hmac-sha256', signature_header: 'x-signature', signature_encoding: 'hex', signature_prefix: '' },
  { key: 'graphql', name: 'Generic GraphQL', base_url: '', auth_type: 'bearer', signature_scheme: 'hmac-sha256', signature_header: 'x-signature', signature_encoding: 'hex', signature_prefix: '' },
];

export function providerEntry(key: string): ProviderEntry | undefined {
  return REGISTRY.find((p) => p.key === key);
}

export function publicRegistry(): ProviderInfo[] {
  return REGISTRY.map((p) => ({ key: p.key, name: p.name, auth_type: p.auth_type }));
}

// ── Import-time self-check ─────────────────────────────────────────────
(function selfCheck(): void {
  const keys = new Set<string>();
  for (const p of REGISTRY) {
    if (keys.has(p.key)) throw new Error(`provider-registry: duplicate key "${p.key}"`);
    keys.add(p.key);
    if (!AUTH_TYPES.includes(p.auth_type)) throw new Error(`provider-registry: bad auth_type for "${p.key}"`);
    if (!SIGNATURE_SCHEMES.includes(p.signature_scheme)) throw new Error(`provider-registry: bad signature_scheme for "${p.key}"`);
    if (p.signature_scheme !== 'none' && !p.signature_header) {
      throw new Error(`provider-registry: "${p.key}" needs a signature_header`);
    }
  }
})();

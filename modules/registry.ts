/**
 * Typed view of modules/registry.json for TypeScript consumers (the marketing
 * site). Scripts use ./registry.mjs, which reads the same JSON file — there is
 * exactly one place where the data lives.
 */
import registryJson from './registry.json';

export interface PlatformServiceEntry {
  /** Directory name under platform/, e.g. "ps-07-audit-log". */
  id: string;
  n: string;
  label: string;
  defaultPort: number;
  routePrefix: string;
  /** Env var a consumer sets to point at this service. */
  urlEnv: string;
  /** True when the service needs POST /api/tick to make progress. */
  tickDriven: boolean;
  secrets: string[];
}

export interface ModuleServices {
  required: string[];
  optional: string[];
}

export interface ModuleEnv {
  required: string[];
  optional: string[];
  secrets: string[];
}

/** Another module this one integrates with when they share a stack. */
export interface ModulePeer {
  id: string;
  urlEnv: string;
}

export interface ModulePeers {
  optional: ModulePeer[];
}

export interface ModuleConstraints {
  supportsSso: boolean;
  needsPublicBaseUrl: boolean;
  /**
   * The module can be pointed at another SQLite database via SOURCE_DB_PATH
   * (read-only). It ACCEPTS one — it does not require one; the module runs
   * standalone when the variable is unset.
   */
  acceptsSourceDb: boolean;
}

export interface ModuleRegistryEntry {
  /** Directory name under modules/, e.g. "mod-04-invoice-billing". */
  id: string;
  n: string;
  slug: string;
  title: string;
  /** Short operational label; lowercased it is the module's subdomain. */
  label: string;
  defaultPort: number;
  scope: string;
  services: ModuleServices;
  /** Absent for every module that knows about no other module. */
  peers?: ModulePeers;
  env: ModuleEnv;
  constraints: ModuleConstraints;
}

export interface Registry {
  schemaVersion: number;
  services: PlatformServiceEntry[];
  modules: ModuleRegistryEntry[];
}

export const registry = registryJson as unknown as Registry;
export const schemaVersion: number = registry.schemaVersion;
export const registryModules: ModuleRegistryEntry[] = registry.modules;
export const registryServices: PlatformServiceEntry[] = registry.services;

/** Look a module up by its directory id. Throws on an unknown id. */
export function moduleById(id: string): ModuleRegistryEntry {
  const found = registryModules.find((m) => m.id === id);
  if (!found) throw new Error(`unknown module "${id}"`);
  return found;
}

/** Subdomain a module gets in a generated stack: "Invoicing" -> "invoicing". */
export function subdomainFor(mod: ModuleRegistryEntry): string {
  return mod.label.toLowerCase().replace(/\s+/g, '-');
}

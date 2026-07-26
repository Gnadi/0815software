/**
 * Typed-at-the-edges loader for modules/registry.json — the one
 * machine-readable description of every module and Platform Service.
 *
 * Plain ESM with Node built-ins only, so scripts (deploy/provision.mjs,
 * deploy/smoke-stack.mjs, demo/serve.mjs, the demo hub) can import it without
 * a build step. TypeScript consumers use ./registry.ts, which reads the same
 * JSON file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGISTRY_PATH = fileURLToPath(new URL('./registry.json', import.meta.url));

/** @type {{ schemaVersion: number, services: any[], modules: any[] }} */
export const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

export const schemaVersion = registry.schemaVersion;
export const modules = registry.modules;
export const services = registry.services;

/** Look a module up by its directory id, e.g. "mod-04-invoice-billing". */
export function moduleById(id) {
  const found = modules.find((m) => m.id === id);
  if (!found) {
    throw new Error(`unknown module "${id}" — known ids: ${modules.map((m) => m.id).join(', ')}`);
  }
  return found;
}

/** Look a Platform Service up by its directory id, e.g. "ps-07-audit-log". */
export function serviceById(id) {
  const found = services.find((s) => s.id === id);
  if (!found) {
    throw new Error(`unknown service "${id}" — known ids: ${services.map((s) => s.id).join(', ')}`);
  }
  return found;
}

/** Every service a module integrates with (required first, then optional). */
export function servicesOf(mod) {
  return [...mod.services.required, ...mod.services.optional].map(serviceById);
}

/**
 * The compose service name for a Platform Service: "ps-07-audit-log" -> "ps07".
 * Matches the names the reference deployment already uses.
 */
export function composeNameOf(service) {
  return service.id.slice(0, 5).replace('-', '');
}

/** Internal container URL of a service inside one generated stack. */
export function internalUrlOf(service) {
  return `http://${composeNameOf(service)}:${service.defaultPort}`;
}

/** Subdomain a module gets in a generated stack: "Invoicing" -> "invoicing". */
export function subdomainFor(mod) {
  return mod.label.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Resolve a module selection into the stack that has to be brought up.
 *
 * `allServices` is the escape hatch: it keeps every Platform Service in the
 * stack even when no selected module references it. Without it, only the
 * services the selection actually reads are included — a two-module stack is
 * six services, not ten.
 */
export function resolveSelection(moduleIds, { allServices = false } = {}) {
  if (moduleIds.length === 0) throw new Error('select at least one module');
  const seen = new Set();
  for (const id of moduleIds) {
    if (seen.has(id)) throw new Error(`module "${id}" selected twice`);
    seen.add(id);
  }
  const selected = moduleIds.map(moduleById);

  const needed = new Set();
  for (const mod of selected) {
    for (const service of servicesOf(mod)) {
      // A module that cannot use SSO must not be handed IDENTITY_URL, and it
      // is the only reason PS-01 would be in its service list.
      if (service.urlEnv === 'IDENTITY_URL' && !mod.constraints.supportsSso) continue;
      needed.add(service.id);
    }
  }
  const resolvedServices = allServices ? [...services] : services.filter((s) => needed.has(s.id));

  return {
    modules: selected,
    services: resolvedServices,
    /** The ticker sidecar only earns its place when something ticks. */
    needsTicker: resolvedServices.some((s) => s.tickDriven),
  };
}

/** Every secret a resolved stack must generate, as "SCOPE.NAME" pairs. */
export function secretsOf({ modules: mods, services: svcs }) {
  const out = [];
  for (const service of svcs) for (const name of service.secrets) out.push({ scope: service.id, name });
  for (const mod of mods) for (const name of mod.env.secrets) out.push({ scope: mod.id, name });
  return out;
}

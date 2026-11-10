/**
 * Build identification and published-version check.
 *
 * The page knows which build it is running (version, commit, build time,
 * builder). `dist/version.json` describes the build currently PUBLISHED; it is
 * fetched with `cache: 'no-store'`, so comparing both tells apart "old code is
 * published" from "the browser is running a cached old build".
 */
export interface BuildInfo {
  version: string;
  commit: string;
  dirty: boolean;
  builtAt: string;
  builder: string;
  ref: string;
}

export const BUILD: BuildInfo =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev', commit: 'dev', dirty: false, builtAt: '', builder: 'test', ref: '' };

export const shortCommit = (c: string): string => (/^[0-9a-f]{7,}$/i.test(c) ? c.slice(0, 7) : c);

/** Where the page is running (from its location; no network access). */
export function runtimeEnvironment(loc: { hostname: string; protocol: string } = globalThis.location ?? { hostname: '', protocol: '' }): string {
  const h = loc.hostname;
  if (loc.protocol === 'file:') return 'arquivo local';
  if (h.endsWith('github.io')) return 'produção (GitHub Pages)';
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return 'local / preview';
  return h || 'desconhecido';
}

/**
 * Versão como aparece para quem usa o simulador (tela inicial, Sobre): só
 * "v3.3.0". Commit e data do build ficam fora da identificação visual, mas
 * continuam em buildLabel(), usado no Diagnóstico para rastrear o build.
 */
export function versionLabel(b: BuildInfo = BUILD): string {
  return `v${b.version}`;
}

/** Rótulo técnico completo (versão · commit · data), para o Diagnóstico. */
export function buildLabel(b: BuildInfo = BUILD): string {
  const date = b.builtAt ? b.builtAt.replace('T', ' ').slice(0, 16) + ' UTC' : '—';
  return `v${b.version} · ${shortCommit(b.commit)}${b.dirty ? '+' : ''} · ${date}`;
}

export type PublishedCheck =
  | { state: 'same'; published: BuildInfo }
  | { state: 'newer'; published: BuildInfo }
  | { state: 'unavailable'; reason: string };

/** Compare the running build with the published version.json (pure; testable). */
export function comparePublished(running: BuildInfo, published: unknown): PublishedCheck {
  const p = published as Partial<BuildInfo> | null;
  if (!p || typeof p.commit !== 'string' || typeof p.version !== 'string') return { state: 'unavailable', reason: 'version.json inválido' };
  const pub = p as BuildInfo;
  return pub.commit === running.commit ? { state: 'same', published: pub } : { state: 'newer', published: pub };
}

export async function checkPublished(running: BuildInfo = BUILD): Promise<PublishedCheck> {
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return { state: 'unavailable', reason: `HTTP ${r.status}` };
    return comparePublished(running, await r.json());
  } catch (e) {
    return { state: 'unavailable', reason: String(e) };
  }
}

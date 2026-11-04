import { ptBR } from './pt-BR';

export type Dictionary = Record<string, string>;

const dictionaries: Record<string, Dictionary> = { 'pt-BR': ptBR };
let current: Dictionary = ptBR;

export function setLocale(locale: string): void {
  current = dictionaries[locale] ?? ptBR;
}

/** Translate `key`, replacing `{name}` placeholders with `params`. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = current[key] ?? ptBR[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Fill every element with a `data-i18n` attribute under `root`. */
export function applyI18n(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
}

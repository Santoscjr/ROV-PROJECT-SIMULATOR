import { ptBR } from './pt-BR';
import { en } from './en';

export type Dictionary = Record<string, string>;
export type Locale = 'pt-BR' | 'en';

/** Idiomas oferecidos, com o nome de cada um escrito no próprio idioma (não traduzir). */
export const LOCALES: readonly { id: Locale; name: string }[] = [
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'en', name: 'English' },
];

const dictionaries: Record<Locale, Dictionary> = { 'pt-BR': ptBR, en };
let current: Dictionary = ptBR;
let currentId: Locale = 'pt-BR';

export function setLocale(locale: string): void {
  currentId = locale in dictionaries ? (locale as Locale) : 'pt-BR';
  current = dictionaries[currentId];
}

export function getLocale(): Locale {
  return currentId;
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

import { afterEach, describe, expect, it } from 'vitest';
import { ptBR } from '../src/i18n/pt-BR';
import { en } from '../src/i18n/en';
import { LOCALES, getLocale, setLocale, t } from '../src/i18n';
import { DEFAULT_SETTINGS, SettingsStore, sanitizeSettings } from '../src/config/settings';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n: dicionário em inglês', () => {
  afterEach(() => setLocale('pt-BR'));

  it('tem exatamente as mesmas chaves do pt-BR', () => {
    const pt = Object.keys(ptBR).sort();
    const e = Object.keys(en).sort();
    expect(e.filter((k) => !(k in ptBR))).toEqual([]);
    expect(pt.filter((k) => !(k in en))).toEqual([]);
    expect(e.length).toBe(pt.length);
  });

  it('mantém os mesmos marcadores {x} em cada texto', () => {
    const diff = Object.keys(ptBR).filter((k) => placeholders(ptBR[k]).join() !== placeholders(en[k] ?? '').join());
    expect(diff).toEqual([]);
  });

  it('não deixa texto vazio nem sobra de português óbvia', () => {
    expect(Object.entries(en).filter(([, v]) => !v.trim())).toEqual([]);
    // palavras que só aparecem em pt-BR; nomes de marca e termos técnicos não entram aqui
    const pt = /\b(não|você|operação|câmera|configurações|profundidade|pressione)\b/i;
    expect(Object.entries(en).filter(([, v]) => pt.test(v)).map(([k]) => k)).toEqual([]);
  });

  it('setLocale troca o idioma e volta para pt-BR com um código desconhecido', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('menu.start')).toBe('Start operation');
    expect(t('mission.descent', { depth: 30 })).toBe('Descend to working depth (> 30 m)');
    setLocale('xx');
    expect(getLocale()).toBe('pt-BR');
    expect(t('menu.start')).toBe('Iniciar operação');
  });

  it('oferece os dois idiomas pelo nome no próprio idioma', () => {
    expect(LOCALES.map((l) => l.id)).toEqual(['pt-BR', 'en']);
    expect(LOCALES.find((l) => l.id === 'en')!.name).toBe('English');
  });
});

describe('configuração de idioma', () => {
  it('padrão pt-BR e valores inválidos voltam ao padrão', () => {
    expect(DEFAULT_SETTINGS.language).toBe('pt-BR');
    expect(sanitizeSettings({}).language).toBe('pt-BR');
    expect(sanitizeSettings({ language: 'fr' }).language).toBe('pt-BR');
    expect(sanitizeSettings({ language: 'en' }).language).toBe('en');
  });

  it('persiste entre cargas', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    new SettingsStore(storage).update({ language: 'en' });
    expect(new SettingsStore(storage).get().language).toBe('en');
  });
});

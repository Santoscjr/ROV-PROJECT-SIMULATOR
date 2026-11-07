import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../src/i18n';
import { ptBR } from '../src/i18n/pt-BR';
import { en } from '../src/i18n/en';
import { CONTACT_EMAIL, CREATOR, LINKEDIN_URL } from '../src/i18n/identity';
import { aboutMarkup, contactMarkup } from '../src/ui/menus';

import indexHtml from '../index.html?raw';
import monitorHtml from '../monitor.html?raw';
import spacemouseHtml from '../spacemouse.html?raw';
import readme from '../README.md?raw';
import portfolio from '../docs/PORTFOLIO.md?raw';
import menusSrc from '../src/ui/menus.ts?raw';
import styleSrc from '../src/ui/style.css?raw';
import ptSrc from '../src/i18n/pt-BR.ts?raw';
import enSrc from '../src/i18n/en.ts?raw';
import identitySrc from '../src/i18n/identity.ts?raw';
import mainSrc from '../src/main.ts?raw';

// arquivos de interface e documentação que carregam a identidade do projeto
const FILES: Record<string, string> = {
  'index.html': indexHtml,
  'monitor.html': monitorHtml,
  'spacemouse.html': spacemouseHtml,
  'README.md': readme,
  'docs/PORTFOLIO.md': portfolio,
  'src/ui/menus.ts': menusSrc,
  'src/ui/style.css': styleSrc,
  'src/i18n/pt-BR.ts': ptSrc,
  'src/i18n/en.ts': enSrc,
  'src/i18n/identity.ts': identitySrc,
  'src/main.ts': mainSrc,
};
const read = (p: string) => FILES[p];

const anchors = (html: string) => [...html.matchAll(/<a\s([^>]*)>/g)].map((m) => m[1]);
const attr = (a: string, name: string) => a.match(new RegExp(`${name}="([^"]*)"`))?.[1];

describe('identidade do projeto', () => {
  afterEach(() => setLocale('pt-BR'));

  it('não cita marca de empresa em nenhum arquivo de interface ou documentação', () => {
    for (const f of Object.keys(FILES)) expect(read(f), f).not.toMatch(/santoscjr\s*dev/i);
  });

  it('a aplicação não fixa o domínio de publicação (URLs relativas)', () => {
    for (const f of ['index.html', 'monitor.html', 'spacemouse.html', 'src/ui/menus.ts', 'src/main.ts']) expect(read(f), f).not.toMatch(/github\.io/i);
  });

  it('index.html tem título, descrição, autor e theme-color', () => {
    const html = read('index.html');
    expect(html).toMatch(/<title>ROV Offshore Simulator<\/title>/);
    expect(html).toMatch(/<meta name="description" content="[^"]*Claudio Junior[^"]*"/);
    expect(html).toMatch(/<meta name="author" content="Claudio Junior"/);
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}"/i);
  });

  it('assinatura, slogan e posicionamento existem nos dois idiomas', () => {
    for (const d of [ptBR, en]) {
      expect(d['brand.signature']).toBe('Created & Developed by {name}');
      expect(d['brand.slogan']).toBe('Explore the depths. Master the operation.');
      expect(d['brand.positioning']).toBeTruthy();
    }
    expect(en['brand.positioning']).toBe('Independent Subsea Simulation Project');
  });
});

describe('Sobre e Contato', () => {
  afterEach(() => setLocale('pt-BR'));

  it('contato: e-mail por mailto e LinkedIn em nova aba com rel seguro, sem telefone', () => {
    const html = contactMarkup();
    const links = anchors(html);
    expect(links).toHaveLength(2);
    expect(attr(links[0], 'href')).toBe(`mailto:${CONTACT_EMAIL}`);
    expect(CONTACT_EMAIL).toBe('santoscjr@gmail.com');
    expect(attr(links[1], 'href')).toBe(LINKEDIN_URL);
    expect(LINKEDIN_URL).toBe('https://www.linkedin.com/in/claudio-junior-1b3335142');
    expect(attr(links[1], 'target')).toBe('_blank');
    expect(attr(links[1], 'rel')).toBe('noopener noreferrer');
    expect(html).not.toMatch(/tel:|telefone|phone|whatsapp/i);
    expect(html).not.toMatch(/doa[çc][ãa]o|donat|pix|assinatura mensal|subscription/i);
  });

  it('tela Sobre em pt-BR traz texto, dedicatória, contato e o nome do autor', () => {
    const html = aboutMarkup();
    expect(html).toContain('Um projeto independente, desenvolvido pela paixão pela tecnologia submarina.');
    expect(html).toContain('Para aqueles que sonham em explorar o desconhecido.');
    expect(html).toContain('Porque a vontade de explorar não conhece profundidades.');
    expect(html).toContain(`<strong>${CREATOR}</strong>`);
    expect(html).toContain('id="about-contact"');
    expect(html).toMatch(/data-a="back"/);
  });

  it('tela Sobre em inglês', () => {
    setLocale('en');
    const html = aboutMarkup();
    expect(html).toContain('About the project');
    expect(html).toContain('For those who dream of exploring the unknown.');
    expect(html).toContain('Because the will to explore knows no depth.');
    expect(html).not.toContain('Sobre o projeto');
  });

  it('o texto do autor não fala de ferramentas nem promete reprodução fiel de equipamento real', () => {
    for (const d of [ptBR, en]) {
      const about = Object.entries(d)
        .filter(([k]) => k.startsWith('about.') || k.startsWith('contact.'))
        .map(([, v]) => v)
        .join(' ');
      expect(about).not.toMatch(/\b(IA|AI|ChatGPT|Claude|LLM|intelig[êe]ncia artificial|artificial intelligence)\b/);
      expect(about).not.toMatch(/certificad|certified|perfeitamente|perfectly/i);
    }
  });
});

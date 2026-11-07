# CLAUDE.md — instruções do projeto

ROV Offshore Simulator: projeto pessoal e independente de Claudio Junior.
TypeScript + Three.js + Vite, site estático (GitHub Pages), interface em pt-BR e inglês.

Estas regras valem para qualquer agente ou pessoa que mexer no código.

## Identidade

- Projeto pessoal. **Não** vincular à SantosCJR Dev: sem logotipo, domínio, e-mail corporativo ou texto de empresa.
- Nome: **ROV Offshore Simulator**. Assinatura: **Created & Developed by Claudio Junior**.
- Contato público: só o e-mail e o LinkedIn de `src/i18n/identity.ts`. Nunca telefone.
- Sem pagamentos, doações ou assinaturas até haver pedido explícito.
- Não afirmar que o simulador reproduz equipamentos reais com perfeição, e não inventar funcionalidades.
- Recurso não validado (por exemplo SpaceMouse e gamepad em hardware) aparece como "não validado".

## Comentários no código: português brasileiro

Requisito permanente. Comentários novos ou revisados são escritos em pt-BR natural, claro e direto, como anotações de quem mantém o próprio projeto. Evite linguagem acadêmica e frases artificiais.

```ts
// Aqui calculo a posição do cabo usando o ponto de fixação do ROV.
// A posição precisa acompanhar a rotação do veículo para evitar
// que a conexão fique deslocada durante a pilotagem.
```

Quando fizer sentido, o comentário explica:
- o que o componente faz e qual é a responsabilidade dele;
- de quais componentes depende e quais funções importantes chama;
- por que uma decisão técnica foi tomada;
- as limitações e os cuidados ao modificar;
- como funcionam os cálculos principais.

Regras:
- Não comente cada linha nem repita o nome da função.
- Não escreva justificativas técnicas inventadas ou explicações incorretas.
- **Não renomeie identificadores para traduzi-los.** Nomes de bibliotecas e APIs ficam como estão.
- Não traduza em massa comentários existentes em inglês. Revise os comentários dos trechos que você alterar; nos demais, evite mudanças só cosméticas.
- Não modifique código de terceiros (`node_modules`) nem arquivos gerados (`dist/`, `package-lock.json`).

## Idiomas da interface

- Textos visíveis passam por `t('chave')` (`src/i18n`). Toda chave existe em `pt-BR.ts` e em `en.ts`, com os mesmos marcadores `{x}`; o teste `tests/i18n.test.ts` cobra isso.
- HTML estático usa `data-i18n="chave"` e `applyI18n()`.
- O padrão é pt-BR. Termos técnicos consagrados (ROV, TMS, tether, Top-Hat, LARS) ficam como estão.
- Sem bibliotecas pesadas de tradução.

## Endereço, publicação e segurança

- O site continua no endereço atual. Não configure domínio novo. Não use links absolutos para o próprio site no app: `base: './'`.
- Não altere a visibilidade do repositório, a publicação ou as configurações de privacidade sem autorização.
- Nada de segredos ou credenciais no repositório. Build de produção sem sourcemaps (`vite.config.ts`).
- O JavaScript que roda no navegador sempre pode ser lido por quem acessa o site, mesmo com o repositório privado.

## Git

- Desenvolva em branch própria. **Sem merge automático na `main`, sem publicar automaticamente.**
- Commits separados por responsabilidade, com mensagem que explique causa e correção.
- Não altere testes só para fazê-los passar. Quando um requisito muda, a justificativa vai no commit.

## Simulação: princípios que já custaram caro

- Uma fonte única por fenômeno: a física, os sensores e a imagem usam o mesmo terreno, as mesmas rochas e o mesmo cabo. Nada de correção só visual para esconder erro físico.
- Tether (`src/physics/segmentTether.ts`):
  - a curva desenhada passa exatamente pelos nós físicos;
  - a aparência (cor e diâmetro) vem de `src/render/tetherLook.ts`, tanto para o tambor do TMS quanto para o cabo livre.
- Passo fixo de 1/120 s. Mudanças na física precisam de teste com cenário medido, não só inspeção visual.

## Validação antes de entregar

```bash
npx tsc --noEmit -p .
npx vitest run
npm run build
```

Testes de navegador, com `npx vite preview --port 4173` rodando:

```bash
node scripts/e2e.mjs
node scripts/e2e-station.mjs
```

Capturas: `scripts/visual.mjs`. Desempenho: `scripts/perf.mjs`. Nesta máquina o WebGL é por software (SwiftShader): os números servem para comparar configurações, não representam uma GPU.

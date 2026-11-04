# ROV Offshore Simulator

Simulador de pilotagem de um ROV *work class* offshore que roda inteiramente no navegador (Three.js + TypeScript, site estático).

**Acesse:** https://santoscjr.github.io/ROV-PROJECT-SIMULATOR/

O operador prepara o veículo no convés, autoriza o lançamento pelo guindaste e desce até ~120 m de lâmina d’água. Em seguida inspeciona dois pontos de um sistema submarino de produção (conexão do jumper no manifold e vão livre do duto de exportação) e retorna ao ponto de recuperação. Ao final, a operação gera um relatório.

## Como pilotar

| Comando | Teclado (padrão) | Gamepad |
|---|---|---|
| Avanço / ré | `W` / `S` | analógico direito ↕ |
| Lateral | `A` / `D` | analógico direito ↔ |
| Subir / descer | `R` / `F` | analógico esquerdo ↕, gatilhos |
| Giro (rumo) | `Q` / `E` | analógico esquerdo ↔ |
| Tilt da câmera | `T` / `G`, arrastar o mouse, roda | direcional ↑/↓ |
| Controle fino | segurar `Shift` | — |
| Luzes on/off, intensidade | `L`, `[` `]` | Y, LB/RB |
| Câmera operacional / externa | `C` | B |
| Modos MANUAL / STABILIZE / DEPTH HOLD | `1` `2` `3` (`M` alterna) | X |
| Confirmar / registrar inspeção | `Enter` | A |
| Pausa · Ajuda | `Esc` · `H` | Start · Back |

As teclas usam a posição física (funcionam em ABNT2, AZERTY etc.) e podem ser remapeadas em **Configurações**. O SpaceMouse (opcional, via WebHID) é descrito em [docs/SPACEMOUSE.md](docs/SPACEMOUSE.md).

## Desenvolvimento

```bash
npm install
npm run dev        # servidor local
npm test           # testes unitários (física, modos, missão, entrada, configurações)
npm run build      # build de produção em dist/
```

Teste de navegador (Playwright/Chromium, com o build servido em `localhost:4173`):

```bash
npx vite preview --port 4173 &
node scripts/e2e.mjs http://localhost:4173/ test-results
```

A publicação é automática: cada push em `main` executa typecheck, testes e build, e publica `dist/` no GitHub Pages (`.github/workflows/deploy.yml`). Em **Settings → Pages**, a fonte precisa estar como **GitHub Actions**.

## Arquitetura

```
src/
  input/        dispositivos (teclado, gamepad, SpaceMouse) → InputManager → comando do piloto
  control/      modos de pilotagem (PID), alocação de empuxo
  physics/      corpo rígido 6-DOF, hidrodinâmica, propulsores, colisões
  sim/          terreno, corrente, layout do campo, guindaste (LARS), orquestração em passo fixo
  mission/      lógica da missão de inspeção (independente de renderização)
  render/       cena Three.js, ROV procedural, óptica submarina, efeitos, câmeras
  ui/           HUD, menus, configurações, relatório
  audio/        som procedural (Web Audio)
  i18n/         textos (pt-BR)
```

Fluxo por quadro: `InputManager.poll()` → `Simulation.advance(dt)`, que roda a física a 120 Hz fixos, independente do FPS → atualização da missão → sincronização visual → render (cena → passe submarino → partículas/feixes) → HUD.

Detalhes do modelo físico, da óptica e das simplificações adotadas: [docs/SIMULACAO.md](docs/SIMULACAO.md).

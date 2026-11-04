# ROV Offshore Simulator

Simulador de pilotagem de um ROV *work class* offshore que roda inteiramente no navegador (Three.js + TypeScript, site estático).

**Acesse:** https://santoscjr.github.io/ROV-PROJECT-SIMULATOR/

## Operações

| Operação | O que o piloto faz | Condições |
|---|---|---|
| **Treinamento de pilotagem** | Começa submerso. Exercícios verificados pela simulação: avanço, recuo, lateral, rumo, profundidade, manter rumo, estabilização, portais e aproximação de alvo | Corrente fraca, água clara (impostas) |
| **Inspeção de estrutura offshore** | Checklist, lançamento pelo guindaste e descida a ~120 m. Depois, inspeção de três pontos (jumper no manifold, vão livre do duto, painel da árvore de natal) com procedimento de aproximação e iluminação mínima, retorno e recuperação | Escolhidas pelo piloto |
| **Navegação em condições adversas** | Rota ao longo do duto até o PLET, manutenção de posição em estação, inspeção da válvula e retorno | Corrente forte, água turva, céu nublado (impostas) |

Cada operação termina com um relatório que traz:
- tempo de operação, profundidade máxima e distância percorrida;
- objetivos e inspeções registradas;
- colisões e desvios de procedimento;
- condições ambientais e estado final do ROV.

As condições ambientais são **corrente**, **visibilidade**, **luz natural** e **estado do mar**. Elas alteram a física (força da corrente sobre o ROV e o umbilical) e a óptica (extinção, partículas, iluminação), e não apenas a aparência.

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
| Densidade do HUD (completo / compacto / mínimo) | `U` | — |

As teclas usam a posição física (funcionam em ABNT2, AZERTY etc.) e podem ser remapeadas em **Configurações**.

**SpaceMouse (opcional, via WebHID, Chrome/Edge):** conecte uma vez pelo menu principal ou por Configurações → SpaceMouse. Nas próximas visitas a reconexão é automática. Os comandos são proporcionais, com zona morta, sensibilidade, curva de resposta, mapeamento de eixos e botões, e calibração.

**Combinação de dispositivos:** em cada eixo vale o dispositivo com maior deflexão. Se o SpaceMouse desconectar, os comandos dele zeram imediatamente e o teclado continua funcionando. Detalhes em [docs/SPACEMOUSE.md](docs/SPACEMOUSE.md).

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

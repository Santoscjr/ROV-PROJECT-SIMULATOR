# ROV Offshore Simulator

**Independent Subsea Simulation Project** · *Explore the depths. Master the operation.*
Created & Developed by **Claudio Junior** · versão **v3.3.0**.

Simulador de pilotagem de um ROV *work class* offshore que roda inteiramente no navegador (Three.js + TypeScript, site estático). É um projeto pessoal e independente: uma simulação educacional com modelos simplificados, sem a pretensão de reproduzir a dinâmica certificada de um equipamento real.

**Acesse:** https://santoscjr.github.io/ROV-PROJECT-SIMULATOR/

Interface em português (Brasil) e inglês: o idioma é escolhido na tela inicial (ou em Configurações → Estação) e aplicado ao recarregar a página. A tela inicial também dá acesso a **Sobre** e **Contato**.

## Recursos

Resumo objetivo; o detalhamento, com as fontes, está em [docs/PORTFOLIO.md](docs/PORTFOLIO.md).

**Disponível**
- ROV fictício de 8 propulsores com dinâmica de 6 graus de liberdade em passo fixo (1/120 s), potência hidráulica compartilhada e modos MANUAL, STABILIZE e DEPTH HOLD.
- Tether segmentado com resolução que acompanha o comprimento pago, rigidez à flexão e contato com o casco do ROV; mesma aparência do tambor do TMS até o veículo.
- TMS Top-Hat com guincho (AUTO/MANUAL), limites de tensão e ciclo completo de lançamento, liberação, acoplamento e recuperação.
- Sonar de imageamento frontal geométrico, altímetro de feixe, DVL, USBL simulado e instrumentação completa.
- Câmeras principal, auxiliar, externa, do tether e do TMS, com óptica submarina por canal, partículas e ressuspensão de sedimentos.
- Ambiente compartilhado: o mesmo terreno com semente e o mesmo campo de rochas para física, sensores, tether e imagem.
- Cinco operações com relatório; roteiro de lançamento não bloqueante.
- Teclado, mouse, gamepad e SpaceMouse (via WebHID); estação com até 3 monitores adicionais.

**Em desenvolvimento**
- Refinamento visual do fundo; contador de voltas do tether; novas missões e instrumentação.

**Limitações conhecidas**
- Gamepad e SpaceMouse suportados, mas **sem validação em hardware físico** até agora; desempenho em GPU real não medido.
- Tether sem autocolisão nem torção (folga grande empilhada pode dobrar sobre si mesma); sonar sem multipercurso/refração e com leque fixo em roll/pitch.
- A janela principal precisa ficar visível para alimentar os monitores; posicionamento das janelas é manual.

## Operações

| Operação | O que o piloto faz | Condições |
|---|---|---|
| **Treinamento de pilotagem** | Começa submerso, já liberado do Top-Hat, com o tether pago. Exercícios verificados pela simulação: avanço, recuo, lateral, rumo, profundidade, manter rumo, estabilização, portais e aproximação de alvo | Corrente fraca, água clara (impostas) |
| **Inspeção de estrutura offshore** | Checklist, lançamento pelo guindaste e descida a ~120 m. Depois, inspeção de três pontos (jumper no manifold, vão livre do duto, painel da árvore de natal) com procedimento de aproximação e iluminação mínima, retorno e recuperação | Escolhidas pelo piloto |
| **Navegação em condições adversas** | Rota ao longo do duto até o PLET, manutenção de posição em estação, inspeção da válvula e retorno | Corrente forte, água turva, céu nublado (impostas) |
| **Treinamento de TMS** | Começa acoplado ao Top-Hat: preparar o guincho, pagar tether, afastar-se mantendo folga sem tensão excessiva, reaproximar, recolher e acoplar | Escolhidas pelo piloto |
| **Pilotagem livre** | Sem objetivos nem cronômetro: pilotar, operar o TMS, testar câmeras, sonar e layouts | Escolhidas pelo piloto |

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
| Tilt / pan da câmera do painel ativo | `T` / `G` · `B` / `N`, arrastar o mouse, roda (Ctrl/Alt + roda = zoom) | direcional ↑/↓ |
| Controle fino | segurar `Shift` | — |
| Luzes on/off, intensidade | `L`, `[` `]` | Y, LB/RB |
| Câmera operacional / externa (painel ativo) | `C` | B |
| Modos MANUAL / STABILIZE / DEPTH HOLD | `1` `2` `3` (`M` alterna) | X |
| Confirmar / registrar inspeção | `Enter` | A |
| Pausa · Ajuda | `Esc` · `H` | Start · Back |
| Densidade do HUD (completo / compacto / mínimo) | `U` | — |
| Liberar o ROV do Top-Hat (quando acoplado) | `Enter` | A |
| Pagar / recolher tether (segurar) | `↑` / `↓` | — |
| Parar guincho · AUTO/MANUAL | `K` · `J` | — |
| Pitch (nariz para cima / para baixo) | `PgUp` / `PgDn` | — |
| Câmeras: auxiliar · principal · externa · TMS · tether (painel ativo) | `6` `7` `8` `9` `0` | — |
| Zoom da câmera do painel ativo | `Z` / `X` | — |
| Layout de telas (1/2/4) · monitor secundário | `Y` · `F8` | — |
| Recolher / descer o conjunto ROV + Top-Hat (pilotagem livre) | `O` | — |
| Roteiro de lançamento: completo / compacto / oculto | `F2` | — |

**Estação de pilotagem (v3.2).** A estação é formada por **fontes** (câmeras principal, auxiliar, externa, tether e TMS, sonar, instrumentação), **painéis** (cada um mostra uma fonte) e **janelas** (a principal e até 3 monitores adicionais, cada uma com 1, 2 ou 4 painéis). Uma câmera se comporta igual em qualquer painel ou janela: pan, tilt e zoom (e a órbita da câmera externa) pertencem à câmera, ficam salvos e são compartilhados por todos os painéis que a mostram.

- **Painel ativo** (borda destacada; clique em qualquer janela): recebe os atalhos de câmera, SpaceMouse e gamepad. O mouse age no painel sob o ponteiro.
- **FIXO / LIVRE** (botão no cabeçalho): atalhos e dispositivos não trocam a fonte de um painel fixo; pan, tilt e zoom continuam livres.
- **Perfis** (tela inicial ou Configurações → Estação):
  - Pilotagem;
  - Operação de TMS;
  - Inspeção;
  - **Estação Offshore**: monitor 2 com o sonar, monitor 3 com a instrumentação, tela principal com tether e TMS em cima, principal e auxiliar embaixo;
  - Personalizado: salve a sua estação.
- **Monitores (`F8`)**: cada F8 abre o próximo monitor configurado; arraste a janela para o monitor físico. A simulação é única: a janela principal renderiza todas as janelas (mantenha-a visível). Teclas digitadas num monitor comandam o ROV normalmente. Se qualquer janela for recarregada, a reconexão é automática.
- **Instrumentos**:
  - em tela única, o HUD da v2;
  - em 2/4 telas, cada câmera tem sua sobreposição (bússola, profundidade e altitude, pitch e roll, tether, câmera, alarmes; itens configuráveis), e os dados essenciais ficam numa faixa reservada abaixo dos painéis, sem cobrir as imagens.

A fonte **Instrumentação** foi feita para ocupar um monitor: horizonte artificial, rosa dos ventos, leituras agrupadas, alarmes e navegação.

**Versão e diagnóstico.** A tela inicial mostra a versão (por exemplo, `v3.3.0`); commit e data do build ficam em **Diagnóstico**. Se houver uma versão mais nova publicada, aparece um aviso para recarregar (build antigo em cache). **Diagnóstico** mostra:
- build e comparação com a versão publicada;
- esquema das configurações;
- GPU e desempenho;
- estação e entrada;
- estado da simulação e do tether;
- erros capturados.

Ele tem uma visão de engenharia da física do tether (nós, contatos e força na terminação). Em Configurações, "Restaurar padrões" age por categoria, com confirmação.

## Desenvolvimento

```bash
npm install
npm run dev        # servidor local
npm test           # testes unitários (física, modos, missão, entrada, configurações)
npm run build      # build de produção em dist/
```

Testes de navegador (Playwright/Chromium, com o build servido em `localhost:4173`):

```bash
npx vite preview --port 4173 &
node scripts/e2e.mjs http://localhost:4173/ test-results          # operações
node scripts/e2e-station.mjs http://localhost:4173/                # estação, painéis, monitores, câmeras em qualquer posição
node scripts/visual.mjs http://localhost:4173/                     # capturas de cada câmera (água clara e turva)
node scripts/perf.mjs http://localhost:4173/ low,medium            # tempo de quadro com 1, 2, 4 e 4+2 painéis
```

Engenharia do tether e identidade do projeto v3.3: [docs/V3.3_TETHER_IDENTIDADE.md](docs/V3.3_TETHER_IDENTIDADE.md). Ambiente submarino v3.2 (rochas físicas, terreno com semente e LOD, água por canal, ressuspensão de sedimentos, altímetro de feixe, roteiro de lançamento, novos modelos do ROV e TMS): [docs/V3.2_SUBSEA.md](docs/V3.2_SUBSEA.md). Pesquisa: [docs/research/](docs/research/references.md). Auditoria, matriz de regressões e limitações: [docs/AUDITORIA_V3.2.md](docs/AUDITORIA_V3.2.md). Pesquisa técnica: [docs/PESQUISA_TECNICA.md](docs/PESQUISA_TECNICA.md). Sonar: [docs/SONAR.md](docs/SONAR.md).

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
  i18n/         textos (pt-BR e inglês), identidade e contato
```

Fluxo por quadro: `InputManager.poll()` → `Simulation.advance(dt)`, que roda a física a 120 Hz fixos, independente do FPS → atualização da missão → sincronização visual → render (cena → passe submarino → partículas/feixes) → HUD.

Detalhes do modelo físico, da óptica e das simplificações adotadas: [docs/SIMULACAO.md](docs/SIMULACAO.md).

## Contato

Contato profissional, sugestões, feedback e colaboração: [santoscjr@gmail.com](mailto:santoscjr@gmail.com) · [LinkedIn](https://www.linkedin.com/in/claudio-junior-1b3335142).

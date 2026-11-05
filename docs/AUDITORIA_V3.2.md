# Auditoria e recuperação — v3.2.0-rc.1

Branch `recovery/v3.2`, criada a partir de `main` @ `699fdb8` (merge do PR #4, v3.1.1). Data: 2026-11-05.

## 1. O que estava publicado (Fase 0)

| Verificação | Resultado observado |
|---|---|
| `main` | `699fdb8` = merge do PR #4 (v3.1.1). O PR #4 **foi mergeado** pelo usuário. |
| Deploys | Run 16 (15:54 UTC, `workflow_dispatch`) publicou de novo a **v3.1** (`2ea8b95`). Run 17 (15:56, push do merge) publicou a **v3.1.1** (`699fdb8`): build, typecheck, testes e `deploy-pages` com sucesso às 15:57:41. |
| Vite `base` | `./`. Assets com hash e caminhos relativos. Sem service worker. |
| Site publicado | Inacessível deste ambiente (a política de rede bloqueia `github.io`). A rastreabilidade foi feita pelo Actions e agora também pelo `version.json`. |
| Sintoma relatado ("câmera externa só gira no painel 1") | **Não se reproduz na 3.1.1** (teste de navegador: drag/teclado funcionam nos 4 painéis). O sintoma é **exatamente** o comportamento da **3.1**, cujo `bindPointer` só movia o rig do painel 1. Isso indica fortemente uma página/bundle antigo em cache, ou o teste feito entre os runs 16 e 17. Não é possível provar, porque o build não tinha identificação visível. |
| Defeito real encontrado | Na 3.1.1, a órbita da câmera externa pertencia ao *rig do painel*, não à câmera. Ao trocar de painel ela voltava ao padrão, e não era persistida. |

**Correção estrutural:** cada build agora tem identificação (versão, commit, data, origem) na tela inicial e no Diagnóstico, e publica `version.json`. A página compara o build carregado com o publicado (`cache: no-store`) e avisa quando há versão mais nova ("Esta aba está usando um build antigo em cache"). O Diagnóstico distingue:
- código antigo publicado;
- cache desatualizado;
- esquema de configurações salvo × atual;
- erros de inicialização e de carregamento de recursos (capturados);
- GPU/WebGL.

## 2. Hipótese central — caminhos de renderização diferentes por painel/janela

**Confirmada por análise de código** (`git show 699fdb8:src/app.ts`, `src/render/secondaryWindow.ts`):

| Caminho | Água (composite) | Partículas e feixes (`WaterEffects`) | MSAA | Sombras | Culling/céu |
|---|---|---|---|---|---|
| Painel 1 da janela principal | sim | **sim** | sim | sim | pela câmera do painel 1 |
| Painéis 2–4 | sim | **não** | não | sim | pela câmera do **painel 1** |
| Monitor secundário | sim | **não** | não | **não** | pela câmera do **painel 1** |

**Correção:** `renderCameraPanel()` (`src/render/station.ts`) passou a ser o único caminho, usado por todos os painéis de todas as janelas. Ele faz preparação da cena por câmera (`World.preparePanel`), aplica a óptica da água do ambiente (`World.waterOptics`) e desenha partículas e feixes contra o buffer de profundidade de cada painel (`WaterEffects.bindPass`). Os painéis secundários usam MSAA ≤ 2 conforme a qualidade, e o monitor tem sombras quando a qualidade não é baixa. O teste de navegador conta os painéis desenhados com o pipeline completo por quadro (`frameStats.waterPanels` = número de painéis de câmera visíveis, incluindo monitores).

## 3. Matriz de regressões

v2 = `v2.0-stable` (`e22b1f7`): tela única, sem TMS, multipainel ou sonar. Por isso vários itens não existiam na v2. A comparação com a v2 foi feita **por análise de código e comportamento**, sem capturas da v2 lado a lado.

| Recurso | v2 | 3.1.1 (main) | Regressão | Causa | Correção (3.2) | Teste |
|---|---|---|---|---|---|---|
| Identificação da versão | só `v2.0` | só `v3.1.1` | sim: build não rastreável | sem commit/data no bundle | build id + `version.json` + aviso de cache | `station32`: build; e2e: tela inicial |
| Câmera externa em qualquer painel | n/a | órbita por painel, não persistida (3.1: só painel 1) | sim | estado no rig, não na câmera | estado único por câmera física (`camState.external`/`tms`) | `station32` (matriz câmera × painel × janela); e2e (C) |
| Água/partículas iguais em todos os painéis | n/a (1 vista) | só painel 1 | sim | caminhos de render duplicados | `renderCameraPanel` único | e2e (W) |
| Monitor secundário | n/a | caminho próprio, sem sombras/partículas, 1–2 painéis | sim | `SecondaryWindow` separado | `MonitorWindow` (até 3 janelas, 1/2/4 painéis, bloqueios, faixa) com o mesmo renderizador | e2e (6)(7) |
| Teclas digitadas no monitor | n/a | agiam no painel ativo da janela **principal** | sim | painel ativo só da janela principal | painel ativo global `{janela, painel}` | e2e (6) |
| HUD em 2/4 telas | n/a | barra superior + caixa de missão sobre as imagens; sobreposição em janelas estreitas | sim | HUD de tela cheia reaproveitado | sobreposição por câmera (sem caixas) + faixa **reservada** abaixo dos painéis; HUD da v2 mantido em tela única | e2e: 4 resoluções × 2 layouts, sem sobreposição |
| Sonar/instrumentação em tela única | n/a | **invisíveis** (frame oculto) | sim | `StationUi` ocultava o frame em 1 painel | frame visível para fontes não-câmera | e2e/visual |
| Instrumentação | HUD v2 | lista de textos | parcial | — | horizonte artificial, rosa dos ventos, grupos, alarmes, navegação | visual |
| Sonar | n/a | viés de alcance de 3–5 bins, tubos não detectados, retornos laterais falsos, sombra fixa; ping dependente do FPS | sim | sondagem por esfera crescente; varredura por quadro | interseção exata, oclusão real, varredura pela taxa do sensor (5 Hz) | `sonarGeometry` (17) + `sonar` |
| Tether (render × física) | umbilical simples | último nó trocado pela ponta do restritor; redesenho a 20 Hz | sim | `World.updateTether` | tubo exatamente pelos nós físicos, a cada quadro | `tetherDynamics` (polilinha = nós) |
| Tether (física) | — | picos falsos de 15 kN; cabo inicial pré-tracionado | sim | amortecimento sem limite; disposição inicial | amortecimento ≤ força elástica; disposição sem tração | `tetherDynamics` (12) |
| Liberação/acoplamento | — | tranco na liberação; saltos de até 8,4 cm por passo no acoplamento | sim | caixa de contato; puxada sem limite | caixa no skirt; puxada ≤ 0,3 m/s; travamento < 0,5 mm | `operationCycle` |
| Guincho TMS | — | recolhia acima do limite (picos de 5,7–6,7 kN) | sim | inibição só no início | redução linear 2,5→4,5 kN e parada no limite | `tms.test` |
| Guincho principal | — | partida/parada instantânea a 0,9 m/s | sim | sem rampa | rampa de 0,3 m/s²; profundidade segura por passo | `topHat.test` |

## 4. Arquitetura resultante

- **Uma autoridade de simulação:** a janela principal (`Simulation.advance`, passo fixo de 1/120 s). As janelas de monitor não simulam: são renderizadas pela principal no mesmo quadro, num único contexto WebGL extra por janela. A sincronização é por `window.opener` (sem cópia de estado nem atraso de rede). A pesquisa avaliou BroadcastChannel; ele só seria útil para heartbeat/reconexão, que hoje já funcionam por adoção direta.
- **Fontes, painéis e janelas:**
  - uma fonte (câmera, sonar, instrumentação) tem identidade própria;
  - um painel só apresenta uma fonte;
  - uma janela tem layout, fontes e bloqueios próprios.
- **Câmeras:** `CameraStates` tem um estado por câmera física (principal, auxiliar, tether, TMS e externa), com limites centralizados em `CAM_LIMITS`, compartilhado por todos os rigs e persistido.
- **Entrada:** um único `KeyboardDevice` escuta a janela principal e as janelas de monitor (sem duplicação; o teste mede a taxa do guincho). O painel ativo é global. Seletores devolvem o foco ao piloto.
- **Perfis de estação:**
  - Pilotagem;
  - Operação de TMS;
  - Inspeção;
  - Estação Offshore (sonar | instrumentação | tether, TMS, principal e auxiliar);
  - Personalizado (salvar/restaurar).
- **Configurações:** esquema 312, com migração da 3.1 (`monitorSource`) e da 3.1.1 (`monitor`) para `monitors[]`. A restauração de padrões é **por categoria**, com confirmação do escopo.

## 5. Evidências

- Testes unitários: 21 arquivos, 220 testes (física, tether, TMS, ciclo operacional, sonar, câmeras, perfis, configurações, build).
- Navegador:
  - `scripts/e2e.mjs`: operações, 18 verificações;
  - `scripts/e2e-station.mjs`: estação, 68 verificações (setas × seletores, bloqueios, câmera externa nos 4 painéis com mouse e teclado, câmera no monitor, paridade da água, 4 resoluções × 2 layouts sem sobreposição, monitor quad, reabertura, recarga das duas janelas, perfil Offshore, identificação do build).
- Capturas em `docs/validacao-v3.2/`: tela inicial, ciclo do tether/TMS, visão de engenharia do tether, todas as câmeras em água clara e turva, sonar, instrumentação, 2 e 4 telas, perfil Offshore, monitor 2 (2 e 4 painéis), sobreposições a 1024 px.
- Desempenho: `scripts/perf.mjs`. Valores medidos com SwiftShader (CPU), portanto **não representativos de GPU**; servem só para comparar configurações. Em qualidade baixa, com o veículo junto à estrutura:

| Configuração | Draw calls/quadro | Painéis com água completa |
|---|---|---|
| 1 painel | 36 | 1 |
| 2 painéis | 88 | 2 |
| 4 painéis | 180 | 4 |
| 4 + monitor com 2 câmeras | 258 | 6 |

A degradação adaptativa reduz a resolução das visões secundárias (até 50 %) e nunca altera a física, os instrumentos ou o sonar.

## 6. Limitações e pendências conhecidas

- **Hardware físico não testado:** SpaceMouse Pro e gamepad foram exercitados só pelo caminho de comando em código e testes simulados. Nada foi validado em dispositivo real.
- **GPU real não medida:** não há medições de desempenho em GPU neste ambiente.
- **Janela principal visível:** ela comanda a renderização de todas as janelas. Se for minimizada ou ficar totalmente coberta, o navegador a estrangula e os monitores congelam; o aviso "sem conexão" aparece após 6 s.
- **Window Management API não implementada:** o posicionamento é manual (arrastar cada janela). Cada F8 abre um monitor, porque os navegadores exigem uma ação do usuário por janela.
- **Sonar:**
  - campo de visão fixo em 130°;
  - o leque não acompanha roll e pitch;
  - um único tipo de sensor (FLS imageador).
- **Tether:**
  - sem colisão do cabo consigo mesmo e sem torção;
  - PBD; a migração para XPBD recomendada pela pesquisa não foi feita;
  - geometria acoplada com a terminação 0,34 m acima da guia de saída.
- **Mudança de comportamento:** ao acoplar, o guincho mantém o modo escolhido pelo piloto (antes mudava para MANUAL silenciosamente).
- **Pesquisa incompleta:**
  - documentos IMCA e MDN inacessíveis pela rede deste ambiente; parte das referências foi verificada só por trechos de busca (marcado em `docs/PESQUISA_TECNICA.md`);
  - não implementados: contador de voltas do tether e intertravamento do Top-Hat sugeridos na pesquisa.
- **Comparação visual automatizada por diferença de pixels:** não implementada. As capturas foram revisadas manualmente.

# ROV Offshore Simulator — portfólio técnico

**Independent Subsea Simulation Project** · Created & Developed by **Claudio Junior**

> **English summary.** ROV Offshore Simulator is an independent, browser-based simulator of a
> fictional work class ROV, written in TypeScript with Three.js and Vite and published as a static
> site. It models 6-DOF vehicle dynamics in a fixed-step loop, thrusters with shared hydraulic power,
> a segmented tether with a Top-Hat TMS and winch, a geometric forward-looking sonar, a beam altimeter,
> several cameras with underwater optics, and a seeded seabed shared by physics, sensors and rendering.
> It offers five operations (training, inspection, adverse conditions, TMS training, free piloting),
> a multi-window control station and keyboard, mouse, gamepad and SpaceMouse (WebHID) input.
> It is an educational simulation with simplified models — not a certified model of any real
> equipment. Gamepad and SpaceMouse support has not yet been validated on physical hardware.

Este documento resume, de forma objetiva, o que o simulador faz hoje, o que está em andamento e
quais são as limitações conhecidas. Tudo aqui se apoia no código e nos documentos técnicos do
repositório ([SIMULACAO](SIMULACAO.md), [SONAR](SONAR.md), [V3.2_SUBSEA](V3.2_SUBSEA.md),
[AUDITORIA_V3.2](AUDITORIA_V3.2.md), [SPACEMOUSE](SPACEMOUSE.md) e [research/](research/references.md)).

É uma simulação educacional com modelos simplificados. Os valores físicos são plausíveis, escolhidos
para o simulador, e **não** representam a dinâmica certificada de nenhum equipamento real.

## Disponível

### Veículo e física de movimento
- ROV *work class* fictício (WC-150, ~1,9 t) com 8 propulsores: 4 horizontais vetoriais e 4 verticais.
- Dinâmica de 6 graus de liberdade na forma de Fossen (massa adicional, amortecimento linear e
  quadrático sobre a velocidade relativa à água, restauração por CG/CB), integrada em **passo fixo
  de 1/120 s**, independente do FPS.
- Propulsores com rotação como estado, atraso de motor, perda por avanço e **orçamento único de
  potência (HPU)** que escala todos os comandos juntos, preservando a direção da força.
- Alocação por pseudo-inversa da matriz de configuração, com saturação proporcional.
- Contato com o fundo e com as estruturas, atrito de Coulomb e pouso sem trepidação.

### Modos de pilotagem
- MANUAL, STABILIZE e DEPTH HOLD, inspirados no comportamento documentado do ArduSub.
- Transferência sem tranco entre modos, captura de rumo e profundidade, anti-windup e viés de
  flutuabilidade aprendido.

### Tether e TMS
- TMS do tipo Top-Hat com máquina de estados (convés, descida, acoplado, liberado, captura, subida).
- Tether segmentado (PBD/XPBD) com peso aparente configurável, arrasto na corrente local, rigidez
  à flexão e contato com fundo, rochas, estruturas e casco do ROV (testado também entre os nós); a
  força atua na terminação do veículo e gera momento.
- Resolução que acompanha o cabo pago (segmentos de ~1,5 m, de 32 a 160): vãos longos ficam
  curvos, sem trechos retos e dobras em ângulo.
- Mesma capa e mesmo diâmetro do tambor do TMS até o ROV; o cabo desenhado passa exatamente pelos
  nós físicos e sai do restritor com raio de curvatura controlado.
- Guincho com rampas, limites de velocidade e comprimento, bloqueio de recolhimento por tensão e
  freio que desliza em sobrecarga; modos AUTO (folga automática) e MANUAL.
- Envelope de acoplamento com e sem assistência; profundidade do Top-Hat fixa ou relativa ao fundo,
  sempre limitada à profundidade segura.

### Sensores e instrumentação
- **Sonar de imageamento frontal (FLS)** geométrico: cada eco vem de interseção real dos feixes com o
  fundo, as estruturas e as rochas; leque de 130°, alcances de 10 a 60 m, ganho, inclinação e três
  níveis de resolução, com sombra acústica e oclusão.
- **Altímetro de feixe único** (cone de 6°), compartilhando os testes de raio com o sonar.
- Profundidade, rumo, pitch, roll, velocidade (DVL com *bottom lock*), navegação USBL simulada,
  empuxo e carga por propulsor, tensão, folga e comprimento do tether. Todos os valores vêm do
  estado da simulação.
- Fonte "Instrumentação" para um monitor inteiro: horizonte artificial, rosa dos ventos, leituras
  agrupadas, alarmes e navegação.

### Câmeras e óptica submarina
- Câmeras principal, auxiliar, externa (orbital), do tether e do TMS, cada uma com estado único de
  pan, tilt e zoom compartilhado por todos os painéis que a mostram.
- Atenuação por canal (presets de água clara, normal e turva), espalhamento, luzes do ROV e do TMS
  com sombras nas qualidades média e alta, partículas em suspensão e feixes volumétricos.
- Efeitos discretos de câmera (distorção, ruído, vinheta, exposição) ajustáveis.

### Ambiente submarino
- Campo de produção fictício a ~120 m: manifold, jumper, árvore de natal, duto com vão livre e PLET.
- **Ambiente compartilhado:** terreno com semente e campo de rochas determinístico usados ao mesmo
  tempo por física, altímetro, sonar, tether e imagem — iguais em qualquer qualidade gráfica.
- Terreno em tiles com níveis de detalhe; fundo de lama, areia ou cascalho.
- Ressuspensão de sedimentos pelos propulsores, levada pela corrente e decantando conforme o fundo,
  visível em todos os painéis e janelas.
- Condições ambientais (corrente, visibilidade, luz natural, estado do mar) que alteram física e
  óptica, não só a aparência.

### Operações e relatório
- Cinco operações: treinamento de pilotagem, inspeção de estrutura offshore, navegação em condições
  adversas, treinamento de TMS e pilotagem livre.
- Roteiro de lançamento **não bloqueante**: verificações puladas viram desvio de procedimento.
- Relatório ao final: tempo, profundidade máxima, distância, objetivos, colisões, desvios,
  condições e estado final do ROV.

### Controles
- Teclado (teclas remapeáveis, dois esquemas) e mouse para as câmeras.
- Gamepad pela Gamepad API.
- SpaceMouse **via WebHID** (Chrome/Edge no desktop), com calibração, curvas e mapeamento de eixos.
- Combinação de dispositivos: em cada eixo vale o de maior deflexão, sem somas imprevisíveis.

### Estação de pilotagem multi-monitor
- Janela principal com 1, 2 ou 4 painéis e até 3 monitores adicionais (F8), cada um com layout,
  fontes e bloqueios próprios.
- Perfis de estação (Pilotagem, Operação de TMS, Inspeção, Estação Offshore, Personalizado).
- Os monitores não simulam: a janela principal renderiza todas as janelas no mesmo quadro, e a
  reconexão após recarga é automática.

### Arquitetura
- TypeScript + Three.js + Vite; site estático (GitHub Pages), caminhos relativos.
- **Uma única autoridade de simulação** (a janela principal), física em passo fixo e um único
  caminho de renderização para todos os painéis e janelas.
- Lógica de missão independente da renderização; modelos 3D procedurais, sem assets de terceiros.
- Identificação do build (versão, commit, data) e aviso de versão em cache; tela de Diagnóstico.
- Interface em português (Brasil) e inglês, com idioma salvo nas configurações.
- Testes unitários com Vitest (física, tether, TMS, sonar, missões, configurações, i18n) e testes de
  navegador com Playwright.

## Em desenvolvimento

- Refinamento visual das rochas e das ondulações de areia.
- Contador de voltas do tether e intertravamento do Top-Hat, sugeridos pela pesquisa.
- Ampliação de cenários, missões e instrumentação.

## Limitações conhecidas

- **Hardware não validado:** gamepad e SpaceMouse foram exercitados pelo caminho de comando em
  código e em testes simulados; a validação em dispositivo físico está pendente.
- **Desempenho em GPU real não medido:** as medições disponíveis foram feitas com renderização por
  software e servem só para comparar configurações.
- **Modelos simplificados:** sem Coriolis da massa adicional, sem turbulência, sem efeito solo nos
  propulsores; navegação USBL sem ruído.
- **Tether:** sem colisão do cabo consigo mesmo e sem torção; uma folga grande empilhada sobre o
  veículo pode dobrar sobre si mesma. Ao reduzir a resolução com o cabo apoiado na quina do casco,
  o trecho junto ao ROV se reacomoda alguns centímetros (≤ ~8 cm medidos).
- **Sonar:** sem multipercurso, refração, lóbulos laterais ou Doppler; o leque não acompanha roll e
  pitch; um único tipo de sensor (FLS).
- **Nuvem de sedimento** com espalhamento simples; corrente de amarração e riser só visuais.
- **Estação:** a janela principal precisa ficar visível (ela renderiza os monitores); o
  posicionamento das janelas nos monitores físicos é manual.
- A semente do fundo e o idioma são aplicados ao recarregar a página.

## Contato

- E-mail: [santoscjr@gmail.com](mailto:santoscjr@gmail.com)
- LinkedIn: [linkedin.com/in/claudio-junior-1b3335142](https://www.linkedin.com/in/claudio-junior-1b3335142)

Contato profissional, sugestões, feedback e propostas de colaboração são bem-vindos.

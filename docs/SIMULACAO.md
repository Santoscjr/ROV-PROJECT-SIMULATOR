# Modelo de simulação e simplificações

Este documento descreve o que é simulado, de onde vieram as ordens de grandeza e o que foi simplificado. Trata-se de um simulador educacional/recreativo, **não** de um modelo dinâmico certificado de qualquer equipamento real.

## Veículo

- **Configuração:** ROV *work class* fictício (WC-150), ~1,9 t, 2,6 × 1,6 × 1,6 m, com 8 propulsores. São 4 horizontais vetoriais a 45° (surge, sway e yaw) e 4 verticais (heave, roll e pitch). O arranjo vetorial é o usado em ROVs de trabalho e no modelo RexROV do UUV Simulator.
- **Massa, inércia, massa adicional e amortecimento:** ordens de grandeza do RexROV (`uuvsimulator/uuv_simulator`, Apache-2.0). Usei apenas os valores numéricos publicados como referência; nenhum código foi reutilizado. Dois ajustes:
  - Aumentei o amortecimento linear de baixa velocidade (surge/sway) para representar o arrasto do umbilical.
  - Aumentei o amortecimento rotacional para obter taxas de giro de ~40–60°/s.
- **Propulsores (v2.0):** cada propulsor tem como estado a rotação normalizada da hélice *n* ∈ [−1, 1]. O comando de força vira rotação desejada (n* = √(F/Fmáx)). O motor segue n* com atraso de 1ª ordem (τ = 0,15 s) e limite de taxa (2,5 rotação-nominal/s). O empuxo é proporcional a n·|n|, por isso a força sobe em "S": cerca de 6 % do empuxo após 0,1 s e 90 % após ~0,6 s. Os limites continuam diferentes para frente e ré (1000/800 N nos horizontais, 900/750 N nos verticais).
  - **Perda por avanço:** T = Fmáx·(n² − |n|·uₐ/Vₐ), com uₐ = velocidade da água através do propulsor ao longo do eixo (inclui ω×r) e Vₐ = 8 m/s. Equivale a uma curva K_T(J) linear. O resultado fica limitado a [0; 1,15·Fmáx·n²]. Em velocidade máxima (~1,6 m/s), os horizontais entregam ~85 % do empuxo estático.
  - **Potência compartilhada (HPU):** cada propulsor consome P = 15 kW·|n|³. O conjunto tem um orçamento único de 66 kW, ordem de grandeza de uma HPU de ~150 hp descontado o circuito de ferramentas. Se a combinação pedida passar do orçamento, todos os comandos são escalonados pelo mesmo fator, o que preserva a direção da força. Nos transitórios, as rotações são reduzidas juntas, como numa queda de pressão. Heave sozinho (60 kW) não satura; surge total fica em ~93 % e surge + heave em ~88 %. **Valores fictícios e plausíveis**, não de um equipamento real.
  - **HUD:** `level(i)` (fração do limite de empuxo, com sinal), `load(i)` (fração da potência nominal do propulsor) e `powerFraction` (potência total / orçamento).
- **Alocação:** pseudo-inversa da matriz de configuração 6×8. Quando um propulsor satura, a solução inteira é escalonada para preservar a direção da força pedida. O fator aplicado (`allocator.lastScale`) e o da HPU (`thrusters.powerScale`) alimentam o anti-windup dos controladores.

## Dinâmica (6 graus de liberdade)

Forma vetorial de Fossen, `M·ν̇ + C(ν)·ν + D(ν)·ν + g(η) = τ`, integrada por Euler semi-implícito em passo fixo de 1/120 s, separada da renderização. Simplificações:

| Item | Implementação | Simplificação |
|---|---|---|
| Massa adicional | diagonal | sem termos cruzados |
| Coriolis | apenas corpo rígido (ω×v, ω×Iω) | sem Coriolis da massa adicional |
| Amortecimento | linear + quadrático, diagonal, sobre a velocidade relativa à água | aplicado num centro de pressão deslocado (o veículo se alinha à corrente e "senta" ao acelerar) |
| Restauração | peso no CG, empuxo no CB (18 cm acima) | flutuabilidade positiva de 0,8 %; empuxo proporcional à fração submersa perto da superfície |
| Corrente | perfil com a profundidade, camada-limite no fundo, oscilações lentas | determinística, sem turbulência |
| Contatos | pontos dos skids contra o leito; esferas contra caixas/cápsulas das estruturas | resposta por projeção. Só impactos acima de 0,25 m/s quicam (restituição 0,15); contatos lentos não quicam, então o veículo pousado não trepida. Atrito de Coulomb no nível de velocidade (μ = 0,35 no leito, 0,2 nas estruturas) |
| Umbilical | modelo quase estático (ver abaixo), força aplicada no ponto de terminação (0; 1,1; 0 m) | sem dinâmica nem inércia do cabo |
| Lançamento/recuperação | guindaste cinemático até 8 m de profundidade | sem LARS/TMS completos |

## Umbilical (v2.0)

O cabo **não** é discretizado em centenas de segmentos. A cada passo:

1. **Guincho:** o comprimento lançado *L* acompanha o alvo `1,08·d + 6 m`, onde *d* é a distância em linha reta da âncora ao ROV. A âncora é o ponto de lançamento do navio ou um TMS. O lançamento é limitado a 1,5 m/s, o recolhimento a 0,8 m/s e o comprimento máximo a 600 m.
2. **Forma:** um arco parabólico no plano da carga média (arrasto + peso). A amplitude sai da folga: comprimento ≈ d + 8a²/(3d), ou seja, a = √(3·d·(L − d)/8).
3. **Arrasto:** fórmula de Morison normal ½·ρ·Cd·D·|uₙ|·uₙ, com Cd = 1,2 e D = 30 mm, mais um pequeno atrito tangencial. É avaliada em 8 pontos ao longo do arco, usando o perfil de corrente real e a velocidade aproximada do cabo (0 na âncora, v do ROV na ponta). O ROV recebe a fração *s* da carga de cada trecho, como numa corda presa nas duas pontas. Resultado: o cabo empurra o ROV corrente abaixo, com força que cresce com *L* e com a corrente². O arrasto do cabo arrastado pelo próprio ROV faz o papel de amortecimento suave.
4. **Limite do guincho:** se d > L, o cabo fica esticado. Entra então uma mola de 20 kN/m com amortecedor de 7 kN·s/m ao longo da corda, que só traciona.
5. **Robustez:** a força total é limitada a 9 kN. Um salto do ponto de fixação maior que 6 m num passo (teleporte) reinicializa o guincho.

Simplificações: o cabo é quase neutro (0,05 kg/m na água), não há ondas no cabo, tranco ou contato com o fundo (só a polilinha desenhada é mantida acima do leito e abaixo da superfície), e a divisão da carga é linear e fixa.

## Perto do fundo

- **Nuvem de sedimento:** `seabedDisturbance` (0..1) cresce quando o jato de um propulsor aponta para o leito, isto é, no sentido oposto ao empuxo. Num ROV, isso acontece ao subir com os verticais. O efeito tem queda quadrática até 3,5 m entre propulsor e fundo, o que dá altitude de ~2 m. Jatos horizontais contam pouco, e só com o propulsor a menos de 1,2 m do leito. Os skids arrastando no leito e os impactos (pousos duros) também contribuem. O valor sobe rápido (τ 0,25 s) e decai devagar (τ 2 s). É usado pelo renderizador para pluma e turbidez.
- **Efeito solo / bloqueio de fluxo na eficiência dos propulsores:** não modelado.
- **Pouso:** o contato não quica em baixa velocidade. O atrito de Coulomb permite deslizar empurrado pelos propulsores e segura o veículo contra correntes fracas quando ele está pressionado contra o fundo.

## Modos de pilotagem

Baseados no comportamento documentado do ArduSub:

- **MANUAL:** comandos diretos de força/torque. Só existe estabilidade passiva em roll/pitch (CB acima do CG). O veículo sobe devagar e deriva com a corrente.
- **STABILIZE:** PID de roll/pitch nos propulsores verticais, com setpoint 0° (ou o comando do eixo, se mapeado). O comando de giro vira demanda de taxa; ao soltá-lo, o rumo é capturado e mantido.
- **DEPTH HOLD:** STABILIZE mais PID de profundidade, com integrador que aprende a flutuabilidade. Com o comando vertical ativo, o veículo sobe/desce livremente; ao soltar, freia e mantém a nova cota.

**Transições e anti-windup (v2.0):**

- **Transferência sem tranco:** ao trocar de modo, a contribuição do assistente em cada canal (atitude e rumo; profundidade) entra ou sai em rampa de 0,5 s, misturada ao comando direto do piloto.
- **Captura de setpoints:** o rumo só é capturado com giro abaixo de 4°/s, com avanço de 0,35 s. A profundidade só é travada com velocidade vertical abaixo de 0,15 m/s. Antes disso o veículo é freado, e não puxado de volta.
- **Viés de flutuabilidade:** o valor aprendido pelo integrador de profundidade é mantido entre modos.
- **Feed-forward de giro:** compensa o amortecimento hidrodinâmico de giro. Com isso, o integrador não acumula viés durante curvas e o rumo é capturado sem ultrapassagem.
- **Anti-windup:** os integradores congelam quando a saída daquele eixo está saturada, ou quando o alocador ou a HPU escalonaram o comando, e o erro empurraria ainda mais para a saturação. O integrador de profundidade também congela com o ROV pousado e mandado descer.
- **Comando do piloto em DEPTH HOLD:** o comando vertical passa direto, somado apenas ao viés aprendido, sem disputa com o controlador.

Os testes em `tests/physics.test.ts` verificam que os modos produzem comportamentos diferentes. Por exemplo, sem comando, o DEPTH HOLD mantém a cota com tolerância de ±0,25 m, enquanto o MANUAL deriva; e o STABILIZE segura o rumo sob corrente cruzada. Os testes da v2.0 cobrem a dinâmica dos propulsores e a HPU (`tests/physicsThrusters.test.ts`), o umbilical (`tests/tether.test.ts`), o comportamento perto do fundo (`tests/physicsSeabed.test.ts`) e as transições, o anti-windup e a precisão sob corrente de 0,5 m/s (`tests/controller.test.ts`).

## Sensores e instrumentos

Todos os valores do HUD vêm do estado da simulação:

- **Profundidade:** posição vertical do CG.
- **Rumo, pitch e roll:** orientação do corpo.
- **Altitude:** distância vertical da base do veículo ao leito ou ao topo de estruturas; alcance de 60 m.
- **Velocidade:** DVL. Só é exibida com *bottom lock* (altitude < 90 m); fora disso, o HUD mostra "SEM LOCK".
- **Empuxo:** saída real de cada propulsor; carga de potência por propulsor e da HPU.
- **Navegação (USBL):** posição simulada, sem ruído.

## Óptica submarina

- **Luz solar:** atenuação espectral difusa por canal (Kd R/G/B ≈ 0,36 / 0,058 / 0,036 m⁻¹), da ordem de águas oceânicas claras. O vermelho some nos primeiros metros e, a ~120 m, praticamente só resta a iluminação do ROV.
- **Imagem:** um passe de pós-processamento reconstrói a distância de cada pixel pelo depth buffer. Sobre ela aplica extinção por canal e espalhamento (*in-scattering*) dependente da direção de visada e da profundidade, com turbidez extra perto do fundo.
- **Iluminação artificial:** 4 luzes spot no veículo, com sombras nas qualidades média e alta. Os feixes volumétricos e a neve marinha são iluminados por essas luzes e oclusos pelo depth buffer.
- **Visualização:** na câmera externa abaixo de 15 m há uma luz auxiliar de observação junto à câmera. Ela não faz parte do veículo e não afeta a câmera operacional.

## Pesquisa de referência

- UUV Simulator / RexROV: arranjo de propulsores, coeficientes hidrodinâmicos e modelo de Fossen.
- Project DAVE: cenários de inspeção e sensores (DVL, USBL, altímetro).
- ArduSub: modos Manual/Stabilize/Depth Hold e mapeamento padrão de gamepad.
- Literatura de óptica oceânica (tipos de água de Jerlov): atenuação espectral.
- WebHID e protocolo HID do SpaceMouse: ver `docs/SPACEMOUSE.md`.

Os modelos 3D (ROV, manifold, árvore de natal, duto, embarcação) são originais, gerados proceduralmente no código. Não há assets de terceiros.


## TMS Top-Hat e tether (v3.1)

Aproximação de treinamento, sem reproduzir um fabricante específico.

- **Máquina de estados** (`src/sim/topHat.ts`): CONVÉS → DESCENDO → ACOPLADO na profundidade de liberação (configurável de 40 a 100 m) ⇄ LIBERADO → captura → SUBINDO → CONVÉS.
  - Enquanto acoplado, o ROV fica rigidamente preso sob o Top-Hat e não tem movimento livre. Ele só é liberado por comando na profundidade de operação.
  - A captura arma depois que o ROV se afasta mais de 2 m. Ela exige alinhamento horizontal e vertical da trava com o receptáculo, rumo, baixa velocidade relativa e tether recolhido.
  - Envelope assistido: 0,9 m, 20°, 0,4 m/s, até 12 m de tether. Sem assistência: 0,35 m, 8°, 0,25 m/s, até 8 m.
  - Após a captura, a trava puxa o ROV suavemente até a posição de encaixe.
  - O Top-Hat oscila com a corrente e com a tração do tether, de forma amortecida e limitada a 3 m.
- **Tether** (`src/physics/segmentTether.ts`): 32 segmentos resolvidos por PBD.
  - Considera peso aparente configurável, arrasto normal e tangencial na corrente local e contato com o fundo, as estruturas e o casco do ROV.
  - A força atua na terminação de ré no topo do ROV (−0,6; 1,05; 0 m), o que gera torque.
  - Há limites de comprimento (3 a 300 m) e de velocidade (1,5 m/s pagando, 1,0 m/s recolhendo, com rampa).
  - Acima de 4,5 kN o recolhimento é bloqueado; acima de 7 kN o freio desliza.
  - Não modelado: enroscamento entre segmentos do próprio cabo, torção e contato com o Top-Hat.
- **Pitch**: os 4 propulsores verticais (x = ±0,7 m) produzem momento de pitch. Com estabilização, o comando define uma atitude-alvo de até ±15°; ao soltar, o veículo volta ao nível. No modo manual o comando é um momento direto, limitado pela estabilidade hidrostática.
- **Sonar** (`src/render/sonar.ts`): FLS com leque de 130°, eixo inclinado 15° para baixo, ecos do fundo e dos colliders das estruturas, sombra acústica, ganho variável com a distância e speckle.

## Estação, iluminação e Top-Hat (v3.1.1)

- **Profundidade do Top-Hat** (`safeTmsDepth`, `src/sim/simulation.ts`): o operador escolhe a profundidade (padrão 50 m). Ela é limitada pelo fundo sob o ponto de lançamento menos o ROV acoplado (≈2,4 m abaixo do centro do Top-Hat) e uma altitude mínima de 6 m. O conjunto nunca desce indefinidamente e nunca atravessa o fundo. As missões não impõem mais 80–95 m.
- **Partidas**: treinamento e condições adversas começam com o ROV já liberado na posição original da missão e com o tether pago (corda até o Top-Hat + folga de trabalho). A tarefa T5 volta a ser relativa à profundidade real de partida. As missões TMS e livre começam acopladas na profundidade escolhida. Na pilotagem livre, `O` recolhe o conjunto ao convés e o desce de novo.
- **Guincho**: aceleração de 1,0 m/s². Ao soltar a tecla, o guincho para em cerca de 1,5 s.
- **Iluminação frontal**: dois faróis direcionais (32°, os únicos que podem projetar sombra) e dois abertos (62°, abertos 30° para os lados e 10° para baixo). Há multiplicador nas Configurações.
- **Luz superior/traseira** no topo do ROV, apontada para a terminação do tether e os primeiros metros de cabo.
- **Tether**: jaqueta amarela, com o diâmetro físico inalterado. Há um realce opcional (emissivo), apresentado como auxílio visual.
- **TMS**: duas luminárias próprias, independentes das luzes do ROV. Os metais têm metalness menor (sem ambiente para refletir, o aço muito metálico ficava preto). A câmera foi movida para o canto superior dianteiro, de onde vê o tambor, o cabo enrolado e a estrutura.
- **Câmera externa assistida**: luz de observação não física e +0,6 EV, apenas nas visões externas. As câmeras operacionais não são afetadas. A turbidez continua definida pelas condições.
- **Painéis**: cada câmera física (principal, auxiliar, tether) tem um único estado de pan/tilt/zoom, compartilhado pelos painéis que a mostram e salvo nas configurações. A câmera externa orbita de forma independente em cada painel.
- **Desempenho**: as visões secundárias (painéis 2–4 e monitor) renderizam com resolução de 0,7, 0,85 ou 1,0 conforme a qualidade. Com frames lentos (>40 ms), a resolução cai em degraus de 25 %, até 50 %, e volta quando há folga (<24 ms). Partículas e feixes volumétricos aparecem só no painel 1. O monitor secundário usa um único contexto WebGL para os dois painéis.


## Física do tether, guincho e ciclo Top-Hat (v3.2)

Verificação por métricas (testes determinísticos em `tests/tetherDynamics.test.ts`, `tests/operationCycle.test.ts`, `tests/physicsMetrics.test.ts`, `tests/tms.test.ts`, `tests/topHat.test.ts`) e correções:

- **Ponto de aplicação**: a força do tether age na terminação do ROV (−0,6; 1,05; 0 m no corpo), gerando momento em torno do CG: um puxão lateral para boreste gera roll boreste-abaixo e guinada para bombordo, com braços exatos de 1,05 m e 0,6 m.
- **Liberação sem tranco**: o ROV acoplado sobrepunha 0,11 m a caixa de contato do TMS e era empurrado para baixo no primeiro passo livre; a caixa agora termina acima da saia (onde fica o topo do ROV acoplado). A catenária inicial do tether limitava mal a flecha (segmentos das pontas começavam 17 % esticados, ~9 kN) e atravessava o ROV; agora a flecha é limitada, o laço é colocado para ré e o contato cabo–ROV fica suspenso enquanto a saída do TMS está junto ao veículo.
- **Tranco de cabo (snap)**: o amortecimento axial é limitado pelo termo elástico (Kelvin–Voigt); antes, um cabo frouxo que ficava esticado a 1 m/s indicava 15 kN com milímetros de alongamento.
- **Guincho do TMS**: o recolhimento é limitado por torque — entre o alerta (2,5 kN) e o limite (4,5 kN) a velocidade de recolhimento cai linearmente; acima do limite o tambor para no mesmo passo (antes desacelerava em rampa e passava do limite em vários kN). Após a captura o modo do guincho (AUTO/MANUAL) é mantido.
- **Ciclo Top-Hat**: o guincho principal acelera e freia (0,3 m/s², sem degrau de 0,9 m/s), a descida nunca passa da profundidade segura, o balanço do TMS é de 2ª ordem (sem degrau de velocidade ao submergir) e o puxamento do ROV após a captura é limitado a 0,3 m/s relativo ao TMS, com encaixe rígido só após convergir posição (< 0,5 mm) e rumo (< 0,06°). Métricas do ciclo completo: maior deslocamento por passo 13 mm (voo livre), variação por passo < 0,8 mm.
- **Renderização**: `polyline()` devolve exatamente os 33 nós físicos (o parâmetro de quantidade é ignorado); o nó da terminação é ressincronizado após a integração do ROV, então as pontas coincidem com a saída do TMS e a terminação.
- **Diagnóstico**: `SegmentTether.debugState()` devolve (sem alocar após a primeira chamada) os nós, a tensão estimada e a deformação por segmento, as marcas de contato por nó (`TETHER_CONTACT`: fundo, estrutura, ROV), a força na terminação e os escalares (tensão, comprimento pago, corda, folga, alongamento). A tensão por segmento é max(EA·deformação, λ/dt²) do último passo; o último segmento informa a tensão aplicada na terminação.

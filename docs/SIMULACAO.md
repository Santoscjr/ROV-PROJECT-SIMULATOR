# Modelo de simulação e simplificações

Este documento descreve o que é simulado, de onde vieram as ordens de grandeza e o que foi simplificado. Trata-se de um simulador educacional/recreativo, **não** de um modelo dinâmico certificado de qualquer equipamento real.

## Veículo

- **Configuração:** ROV *work class* fictício (WC-150), ~1,9 t, 2,6 × 1,6 × 1,6 m, com 8 propulsores. São 4 horizontais vetoriais a 45° (surge, sway e yaw) e 4 verticais (heave, roll e pitch). O arranjo vetorial é o usado em ROVs de trabalho e no modelo RexROV do UUV Simulator.
- **Massa, inércia, massa adicional e amortecimento:** ordens de grandeza do RexROV (`uuvsimulator/uuv_simulator`, Apache-2.0). Usei apenas os valores numéricos publicados como referência; nenhum código foi reutilizado. Dois ajustes:
  - Aumentei o amortecimento linear de baixa velocidade (surge/sway) para representar o arrasto do umbilical.
  - Aumentei o amortecimento rotacional para obter taxas de giro de ~40–60°/s.
- **Propulsores:** limites de empuxo diferentes para frente e ré, e resposta de 1ª ordem (τ = 0,3 s). A alocação usa a pseudo-inversa da matriz de configuração 6×8. Quando um propulsor satura, a solução inteira é escalonada para preservar a direção da força pedida.

## Dinâmica (6 graus de liberdade)

Forma vetorial de Fossen, `M·ν̇ + C(ν)·ν + D(ν)·ν + g(η) = τ`, integrada por Euler semi-implícito em passo fixo de 1/120 s, separada da renderização. Simplificações:

| Item | Implementação | Simplificação |
|---|---|---|
| Massa adicional | diagonal | sem termos cruzados |
| Coriolis | apenas corpo rígido (ω×v, ω×Iω) | sem Coriolis da massa adicional |
| Amortecimento | linear + quadrático, diagonal, sobre a velocidade relativa à água | aplicado num centro de pressão deslocado (o veículo se alinha à corrente e "senta" ao acelerar) |
| Restauração | peso no CG, empuxo no CB (18 cm acima) | flutuabilidade positiva de 0,8 %; empuxo proporcional à fração submersa perto da superfície |
| Corrente | perfil com a profundidade, camada-limite no fundo, oscilações lentas | determinística, sem turbulência |
| Contatos | pontos dos skids contra o leito; esferas contra caixas/cápsulas das estruturas | resposta por projeção, inelástica, com atrito simples |
| Umbilical | desenhado com curvatura pela corrente; o arrasto entra no amortecimento | sem dinâmica de cabo |
| Lançamento/recuperação | guindaste cinemático até 8 m de profundidade | sem LARS/TMS completos |

## Modos de pilotagem

Baseados no comportamento documentado do ArduSub:

- **MANUAL:** comandos diretos de força/torque. Só existe estabilidade passiva em roll/pitch (CB acima do CG). O veículo sobe devagar e deriva com a corrente.
- **STABILIZE:** PID de roll/pitch nos propulsores verticais, com setpoint 0° (ou o comando do eixo, se mapeado). O comando de giro vira demanda de taxa; ao soltá-lo, o rumo é capturado e mantido.
- **DEPTH HOLD:** STABILIZE mais PID de profundidade, com integrador que aprende a flutuabilidade. Com o comando vertical ativo, o veículo sobe/desce livremente; ao soltar, freia e mantém a nova cota.

Os testes em `tests/physics.test.ts` verificam que os modos produzem comportamentos diferentes. Por exemplo, sem comando, o DEPTH HOLD mantém a cota com tolerância de ±0,25 m, enquanto o MANUAL deriva; e o STABILIZE segura o rumo sob corrente cruzada.

## Sensores e instrumentos

Todos os valores do HUD vêm do estado da simulação:

- **Profundidade:** posição vertical do CG.
- **Rumo, pitch e roll:** orientação do corpo.
- **Altitude:** distância vertical da base do veículo ao leito ou ao topo de estruturas; alcance de 60 m.
- **Velocidade:** DVL. Só é exibida com *bottom lock* (altitude < 90 m); fora disso, o HUD mostra "SEM LOCK".
- **Empuxo:** saída real de cada propulsor.
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

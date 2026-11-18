# Tether e TMS: configuração, profundidade e comportamento

Data: 2026-11-06. As referências estão em [references.md](references.md).

**O que já está decidido em R1:**
- Máquina de estados do Top Hat (§3).
- Duas travas com intertravamento (Dec. 5).
- Tether XPBD com N fixo e Morison por nó (Dec. 6).
- Umbilical quase estático (Dec. 7).

**Estado do código:**
- `tms.ts`: capacidade de tether de 300 m.
- `settings.ts`: `tmsDepth` com padrão de 50 m, faixa aceita de 20–100 m, e opção `tetherBuoyancy`.
- Leito do sítio: ~113–121 m.

---

### F1 — Top Hat × garagem
- **Fonte/URL:** R27 https://f-e-t.com/subsea/tether-management-systems/ ; P6 (patentes) ; R43. Consulta em 2026-11-06, nível [V2].
- **Informação:**

  | Aspecto | Top Hat | Garagem (cage) |
  |---|---|---|
  | Como recebe o ROV | por baixo, ROV pendurado e travado sob o TMS | na horizontal, ROV dentro da gaiola |
  | Proteção na zona de splash | ROV exposto | gaiola protege o ROV |
  | Porte | conjunto separado montado sobre ROVs work-class grandes | comum em ROVs menores e médios |
  | Capacidade de tether (FET) | ~440–1500 m conforme o diâmetro | ~750–1150 m (tether de 27 mm) |
  | Pontos críticos | trava ou travas (dupla em alguns fabricantes) | porta, guia e alinhamento de entrada |

  Uma fonte observa que boa parte do downtime histórico de ROVs vem de falhas de TMS (R27). Referência de porte: um Top Hat de 2,4 × 2,2 m, 4,6 t no ar, com 425 m de tether (R22).
- **Decisão técnica:** manter o **Top Hat** como único tipo na v3.2. A garagem fica como possível cenário futuro.

### F2 — Comprimentos típicos de tether
- **Fonte:** R27, R22, P6 [V2].
- **Informação:** a capacidade fica em algumas centenas de metros até ~1,5 km. 300–1000 m é a faixa mais comum em work-class [V2 + CONHECIMENTO]. A excursão útil é menor que a capacidade, por causa de folga, curva e voltas no tambor.
- **Decisão técnica:**
  - Capacidade padrão de **300 m** (a atual), com opções de 450 e 600 m no cenário.
  - **Excursão útil = 80% da capacidade** [APROX] para cálculo de alcance e alertas.

### F3 — Profundidade do TMS: um Top Hat a 20–30 m é realista?
- **Fontes/URL:** R37 https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12365430 ; R35 ; R36 ; R1 §3. Consulta em 2026-11-06, nível [V2].
- **O que as fontes dizem:**
  - Uma patente descreve baixar o conjunto TMS/ROV **apenas alguns metros**, para ficar abaixo da camada turbulenta da superfície, e então liberar o ROV (R37).
  - A zona de splash é a fase de maior risco para ROV, TMS e embarcação (R35).
  - O motivo de existir um TMS é levar o ROV à profundidade num umbilical pesado e voar a partir dali num tether leve, menos sensível à corrente (R35).
  - **Nenhum procedimento de operador** sobre onde estacionar o TMS foi encontrado.
- **Análise [APROX]:**
  - Neste sítio (leito a ~117 m, ROV trabalhando a ~115 m), com o TMS a 25 m, a queda vertical é de ~90 m.
  - Com 80% de 300 m, o raio horizontal fica em √(240² − 90²) ≈ **222 m**. Com o TMS a ~92 m, ele fica em √(240² − 23²) ≈ 239 m. Perde-se pouco alcance.
  - O custo real é ter **~90 m de tether atravessando a coluna d'água**, onde a corrente é mais forte (o `ocean.ts` chega a 0,32 m/s na superfície).
  - Arrasto normal ≈ ½·ρ·Cd·D·u² por metro. Com D = 0,03 m, Cd = 1,2 e u = 0,3–0,5 m/s, dá ~1,7–4,6 N/m, ou **~150–420 N** em 90 m.
  - Isso é uma carga lateral contínua que o piloto sente e que forma uma barriga no tether. Somam-se o risco de o tether se aproximar do casco e dos propulsores da embarcação e uma descida mais longa do ROV a cada recuperação.
  - O heave da embarcação chega ao TMS **em qualquer profundidade** pelo umbilical, a menos que haja AHC (R28). Estacionar raso não elimina o heave.
- **Resposta:**
  - **Sim, é realista em configurações específicas:**
    - (a) **águas rasas** (lâmina de até ~100–150 m), em que a queda vertical é pequena frente à capacidade do tether;
    - (b) **trabalho na coluna d'água superior**: risers, jaqueta, casco, amarras, inspeção perto da superfície;
    - (c) **restrições junto ao fundo**: zona de objetos caídos, SIMOPS ou estruturas altas e congestionadas em que o TMS não pode descer perto;
    - (d) **ponto de espera curto** logo abaixo da zona de splash para liberar o ROV num lançamento de mau tempo (R37).
  - **Para trabalho no leito a ~115 m com corrente, não é a configuração típica.** O usual é descer o TMS **perto do local de trabalho**: ~10–30 m acima do fundo ou da estrutura mais alta e afastado lateralmente dela, deixando a excursão quase horizontal e curta [CONHECIMENTO, sem procedimento verificado].
- **Decisão técnica:** ver "Decisões para a v3.2", itens 1–3.

### F4 — Flutuabilidade do tether e gestão de folga
- **Fontes/URL:** R40 https://www.lindenphotonics.com/?p=7497 ; R41 ; R42 https://mdpi.com/2077-1312/12/2/279 ; R38 ; R39 ; R43. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Tether **neutro** costuma ser preferido, porque reduz a carga no veículo e limita flutuação e barriga (R40).
  - **Positivo demais:** sobe, forma laços e é empurrado por corrente e ondas (R40). Puxa o ROV para trás em profundidade (relato, R41).
  - **Negativo:** afunda, arrasta no fundo e enrosca [CONHECIMENTO].
  - Tether frouxo e passivo aumenta o risco de enroscar e de arrastar no fundo. Um TMS passivo ajuda pouco sem controle ativo de comprimento (R42).
  - TMS levemente negativo mantém o cabo do guindaste tensionado (R37, R38).
  - Sistemas de **tensão constante** no tambor (R43).
- **Decisão técnica:**
  - `tetherBuoyancy` padrão = **neutro**, com opções levemente positivo e levemente negativo, cada uma com efeito visível (laços subindo ou barriga no fundo).
  - Dois modos de tambor: **manual** (o piloto comanda pay-out e haul-in) e **tensão constante** (mantém a tensão entre T_min e T_max, como o deslizamento `slipTension` atual).
  - Alerta de "tether frouxo perto do fundo" quando um nó toca o leito com folga maior que 15% [APROX].

### F5 — Restritores de curvatura e terminação
- **Fontes/URL:** R44 https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10024482 ; R45 ; R46 ; R43. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - O **bend stiffener** na terminação impede que o cabo dobre abaixo do raio mínimo (R44).
  - Restritores de vértebras intertravadas são outra opção (R45).
  - Curvas fechadas no TMS (roldanas) e os movimentos do veículo degradam o membro de tração. Por isso é preciso **reterminar** o cabo periodicamente (R46).
  - Fornecedores oferecem soquetes de terminação e roldana vertical→horizontal (R43).
- **Decisão técnica:**
  - O primeiro e o último segmento do tether (TMS e ROV) ganham rigidez à flexão de "restritor" (restrição angular XPBD).
  - Registro de **curvatura mínima excedida**, que conta como evento no log de treino e não como dano simulado.

### F6 — Lições de incidentes (reuso)
- **Fonte:** P4, P5 (IMCA SF 11/11 e 13/24).
- **Decisão técnica:** sem mudança. Trava dupla, indicador, câmera de trava e intertravamento (R1 Dec. 5).

---

## Decisões para a v3.2

1. **Profundidade do TMS configurável de 15 m até `leito_local − 4 m (TMS+ROV) − 10 m`**, ou seja, ~100–103 m neste sítio. O limite também fica ≥ 10 m acima da estrutura mais alta num raio de 15 m. Isso substitui o teto fixo de 100 m.
2. **Padrão "perto do local de trabalho" = leito sob o TMS − 25 m** (≈ 90 m neste sítio), no lugar dos 50 m atuais. Rótulo: "TMS próximo ao fundo (operação de leito)".
3. **Preset "TMS raso (20–30 m)"** permitido e documentado como configuração de **águas rasas, coluna superior, restrição junto ao fundo ou espera abaixo da zona de splash**. A UI avisa que há ~90 m de tether na coluna, sob a corrente mais forte, e mostra o raio útil.
4. **Verificação de alcance:** `√(L_útil² − Δz²)` com `L_útil = 0,8·capacidade`. Alertas de tether restante abaixo de 30 m e de 10%.
5. **Tether neutro por padrão.** Os modos positivo e negativo têm efeitos visíveis. Tambor manual ou de tensão constante.
6. **Restritores de curvatura** nas duas pontas, com evento de "raio mínimo excedido" no log.
7. Capacidade de 300 m por padrão (opções de 450 e 600 m). Top Hat como único tipo de TMS.

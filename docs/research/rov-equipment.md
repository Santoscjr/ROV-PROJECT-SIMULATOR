# Referências visuais e estruturais de ROVs work-class

Data: 2026-11-06. As referências estão em [references.md](references.md).

> **Regra.** O ROV e o TMS do simulador são **fictícios**. Os números abaixo são faixas típicas de equipamentos reais, todos [V2]. Servem para dar proporção e plausibilidade ao modelo. **Nunca** atribuir uma especificação real ao nosso veículo, nem usar nomes ou marcas nele.

---

### F1 — Classe e porte (faixas típicas)
- **Fontes/URL:**
  - R18 https://www.saabseaeye.com/uploads/leopard-datasheet-12.pdf
  - R19 (Unique Group)
  - R20 https://www.technipfmc.com/media/5b4p2j2r/data-sheet-schilling-uhd-iii.pdf
  - R24 https://www.oceaneering.com/products/millennium-plus-rov/
  - R25 (Robotomated, terceiros)
  - R26 https://f-e-t.com/?p=2924
  - R34 https://videoray.com/wp-content/uploads/2025_SpecSheet_Defender-2.0.1.pdf

  Consulta em 2026-11-06, nível [V2].
- **Informação:**

  | Referência | Classe | Profundidade | Potência / empuxo | Massa / dimensões | Observação |
  |---|---|---|---|---|---|
  | Saab Seaeye Leopard | work-class elétrico leve | 2000 (3000) m | até 11 propulsores, > 500 kgf à frente | 2150 × 1204 × 1160 mm | 6 câmeras; payload 200 kg (EN) × 240 kg (PT), fontes divergem |
  | Schilling UHD-III | work-class pesado | 3000/4000 m | 250 hp + 150 hp auxiliar | 5600 kg no ar; docking SWL 13.025 kg | — |
  | Oceaneering Millennium Plus | work-class pesado | 3000 m (agregador) | 220 hp; TMS 110 hp | 8 propulsores, payload 350 kg (terceiros) | câmeras HD e 3D HD |
  | FET XLX-C | work-class | 3000/4000 m (fontes divergem) | 150 hp, opção 200 hp | — | manipulador de 7 funções (R29); skid de ferramentas; LARS Dynacon com AHC (R28) |
  | VideoRay Defender | inspeção / observação | 300 m (opção 1000 m) | 4 horizontais vetorados + 3 verticais; ~23,6 kgf à frente | ~17–18 kg | só para contraste de escala |
- **Aplicabilidade:** um work-class "médio" plausível tem 2–3 m de comprimento, 1,5–2 m de largura, 1,2–2 m de altura, 3–5 t no ar, 7–8 propulsores e 100–250 hp. O `rovParams.ts` (caixa do RexROV, 2,6 × 1,5 × 1,6 m e ~1,9 t, R1 P10) está no limite inferior. É coerente para um work-class leve.
- **Decisão técnica:** manter as dimensões atuais e rotular a classe na UI como "work-class (fictício)".

### F2 — Estrutura e espuma sintática
- **Fonte:** nenhuma ficha aberta tratou disso nesta sessão. [CONHECIMENTO]
- **Informação:**
  - Chassi aberto de alumínio ou aço, com o bloco de **espuma sintática** no topo (normalmente amarelo ou laranja, para visibilidade), o que deixa o centro de empuxo acima do centro de gravidade e dá estabilidade passiva em roll/pitch.
  - Embaixo ficam o skid de ferramentas, o HPU e os manipuladores.
  - No topo fica o ponto de docking/latch, que no Top Hat é o "bullet" ou pino de engate.
- **Decisão técnica:** o modelo fictício mantém esse arranjo (espuma no topo, cores de alta visibilidade, chassi visível) **sem** reproduzir o desenho de nenhum fabricante. Variar proporções e detalhes.

### F3 — Propulsores e grades
- **Fonte:** R18, R34, R25 [V2]; [CONHECIMENTO] para as grades.
- **Informação:**
  - O arranjo típico tem 4 propulsores horizontais vetorados a ~45° nos cantos e 2–4 verticais.
  - Os propulsores têm dutos (Kort) e **grades de proteção** contra o tether e detritos.
  - Os hidráulicos ficam em ROVs pesados e os elétricos em leves e médios.
- **Decisão técnica:** o modelo mostra 4 vetorados com duto e grade e 3 verticais, coerente com `thrusters.ts`. O jato dos verticais alimenta a pluma de sedimento (rov-physics.md).

### F4 — Iluminação
- **Fontes/URL:** R30 https://www.marinetechnologynews.com/news/bowtech-install-lights-cameras-477450 ; R31 (Pegaso) ; R32 (ISE Hysub) ; R23 (Bourbon HD). Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Um pacote para um Schilling HD: 3 refletores LED de **20.000 lm** e 6 luzes LED menores.
  - Pegaso: 3 refletores de 20 klm difusos e 4 spots de 4 klm.
  - ISE Hysub: 8 LEDs.
  - Bourbon HD: 8 LEDs.
  - **Padrão:** 3 a 8 lâmpadas, refletores de alguns milhares até 20 klm, mais spots. Dimerizáveis.
- **Aplicabilidade:** a posição importa mais que a contagem. Lâmpadas nos cantos superiores, afastadas da câmera principal, reduzem o retroespalhamento (P20).
- **Decisão técnica:**
  - O ROV fictício terá 6 lâmpadas: 2 refletores dianteiros superiores afastados ±0,6–0,8 m da câmera, 2 spots dianteiros inferiores, 1 traseira e 1 na câmera de pan/tilt.
  - Dimerização de 0–100% por grupo e intensidade relativa, não lúmens de fabricante.
  - O TMS tem 2–4 lâmpadas voltadas para baixo (área de docking).

### F5 — Câmeras e pan/tilt
- **Fonte:** R18 (6 câmeras), R22 (1 pan & tilt elétrico), R23 (2 câmeras zoom), R32 (6 câmeras, 1080p zoom), R33 (PTZ: zoom óptico de 10×, tilt de 270°, pan de 350°, 4 LEDs). [V2]
- **Decisão técnica:**
  - Câmera principal HD com zoom no pan/tilt (faixas fictícias: pan ±170°, tilt +90/−90°, zoom 10×).
  - Câmeras fixas: proa grande-angular, pulso do manipulador (o Titan 4 oferece câmera de pulso, R21), ré e câmera de trava/docking no TMS.
  - Um quad com 4 dessas na estação (R1 Dec. 1).

### F6 — Manipuladores
- **Fonte/URL:** R21 https://www.technipfmc.com/media/hpkjrigr/titan-4-datasheet.pdf ; R18 ; R29. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Titan 4: alcance de 1922 mm, 122 kg na extensão máxima, 7000 msw, garras de 3 ou 4 dedos e câmera de pulso opcional.
  - Leopard: aceita Schilling Orion ou Hydro-Lek.
  - O arranjo comum é um braço de 7 funções (posicional) e um de 5 funções (garra/agarre).
- **Decisão técnica:**
  - Se modelados, os braços têm alcance de ~1,5–2 m (fictício), um "dexterous" de 7 funções e um "grabber" de 5.
  - Na v3.2, os braços são **estáticos e visuais**, sem cinemática nem contato.

### F7 — Terminação do tether e restritor de curvatura
- **Fonte:** R44, R45, R46 [V2]. Detalhes em [tether-and-tms.md](tether-and-tms.md).
- **Decisão técnica:**
  - O tether entra no topo traseiro do ROV por uma **terminação mecânica** (soquete) com restritor de curvatura cônico ou de vértebras de ~0,6–1 m.
  - No modelo, o último segmento do `segmentTether.ts` tem rigidez à flexão maior.

### F8 — TMS Top Hat e sistema de lançamento
- **Fonte:** R22 (Top Hat 2,4 × 2,2 m, 4,6 t no ar, 425 m de tether, como referência), R27 (capacidades FET), R43 (trava dupla, tensão constante, roldana vertical→horizontal), R28 (LARS com compensação ativa de heave), R35/R36. [V2]
- **Informação:** o Top Hat combina tambor, level-wind, motor de tensão constante, trava (dupla) com câmera, lâmpadas para baixo, olhal para o umbilical e terminação.
- **Decisão técnica:**
  - O TMS fictício tem ~2,4 m de diâmetro (envelope), tambor e level-wind visíveis, 2 travas com indicador, câmera de trava e 2–4 lâmpadas.
  - LARS: A-frame ou guindaste com cursor/snubber opcional e indicação de AHC ligado/desligado.

---

## Decisões para a v3.2

1. O **ROV fictício** fica com as proporções atuais (2,6 × 1,5 × 1,6 m, ~1,9 t), na faixa de um work-class leve. Nunca exibir nomes ou números de fabricante.
2. Arranjo visual: **espuma no topo**, chassi aberto, 4 vetorados com duto e grade, 3 verticais e skid inferior.
3. **6 lâmpadas** com refletores afastados da câmera principal (reduz o retroespalhamento) e dimerização por grupo. O TMS tem 2–4 lâmpadas para baixo.
4. Câmeras: principal com zoom no **pan/tilt**, proa, pulso, ré e **câmera de trava no TMS**.
5. Manipuladores 7F + 5F **só visuais** na v3.2.
6. Terminação com **restritor de curvatura** e último segmento do tether mais rígido.
7. TMS Top Hat com tambor, level-wind, **trava dupla** com indicador e lâmpadas, coerente com R1 Dec. 5.

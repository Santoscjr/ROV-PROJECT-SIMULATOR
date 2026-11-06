# Renderização subaquática realista em Three.js/WebGL

Data: 2026-11-06. Este documento parte de R1 §7 (Jerlov, Kd, Jaffe–McGlamery, fórmula `J·T + B∞(1−T)`) e não repete aquele material. As referências R#/P# estão em [references.md](references.md).

**O que o código já faz.** O `src/render/optics.ts` usa Kd RGB = 0,36 / 0,058 / 0,036 e extinção c = 0,36 / 0,10 / 0,08 m⁻¹, o que corresponde ao preset "clara" abaixo. O leito do sítio fica a ~113–121 m (`terrain.ts`).

---

## 1. Jogos: o que serve e o que é fantasia

### F1 — Subnautica (H2.0) e Below Zero
- **Fonte/URL:** R2 https://gamedeveloper.com/design/how-i-subnautica-i-plunges-deeper-into-rendering-realistic-water ; R3 https://forums.unknownworlds.com/discussion/comment/2187138 ; R4 (PCGH). Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - A revisão gráfica H2.0 buscou um tom azul forte e luz solar que não penetra fundo.
  - Os parâmetros de água e luz vêm de **dados volumétricos que variam pelo mundo**, misturados na tela. Os designers ganharam controle sobre eles.
  - A luz ambiente externa foi removida no fundo das cavernas.
  - No fórum, o estúdio diz que **evitou de propósito** a neblina claustrofóbica, porque seria monótona ao longo do jogo.
  - Em Below Zero, a névoa vem em boa parte de **profundidade de campo**, motion blur e TAA (R4).
- **Aplicabilidade:**
  - *Transferível:* volumes de parâmetros por região (água do canal × pluma junto ao manifold), mistura suave entre volumes e luz ambiente em função da profundidade e da oclusão.
  - *Fantasia:* alcance visual muito maior que o real e DoF fazendo papel de turbidez.
- **Limitações:** não há palestra técnica do estúdio. A informação é de entrevista e fórum.
- **Decisão técnica:** criar `WaterVolume` (caixa ou esfera com c, Kd, ω e cor) misturado por distância ao ROV, com no máximo 2–3 volumes ativos. **Não** usar DoF para simular água turva: DoF só aparece como efeito óptico da lente com foco/zoom.

### F2 — ABZÛ
- **Fonte/URL:** R5 https://www.gdcvault.com/play/1024409/Creating-the-Art-of-ABZ ; R6 (80.lv) ; R7 (PCGamesN). Consulta em 2026-11-06, nível [V2]. O vídeo não foi assistido.
- **Informação:**
  - A distância da neblina é usada como alavanca **emocional**.
  - Um motor feito para o ar "funciona debaixo d'água se a neblina for bem espessa".
  - O engenheiro-chefe admite que **a água real é bem mais turva** do que o jogo podia mostrar, porque o jogador precisa enxergar.
- **Aplicabilidade:** a lição é inversa. Num treinador realista, a turbidez **é** o desafio, e o operador compensa com sonar, luzes e posicionamento. Cores saturadas e água límpida são fantasia.
- **Decisão técnica:** nenhum preset do simulador passa da visibilidade "clara" calculada no §3. Um modo "demonstração" pode existir, mas rotulado como irrealista.

### F3 — Under the Waves e Beyond Blue
- **Fonte/URL:** R8 https://en.wikipedia.org/wiki/Under_the_Waves ; R9 https://techraptor.net/gaming/features/beyond-blue-e-line-bbc-collaboration. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Under the Waves usa Unreal Engine. Nenhuma fonte técnica sobre visibilidade foi encontrada.
  - Beyond Blue teve consultoria científica (Joye, Gruber, Earle, Bakker) e acesso ao acervo de vídeo da BBC para calibrar o mundo.
  - Também não há fonte de técnica de renderização.
- **Aplicabilidade:** o que serve é o **processo**: calibrar o visual contra filmagem real.
- **Limitações:** nada técnico verificável.
- **Decisão técnica:** calibrar os presets comparando lado a lado com vídeos públicos de ROV em águas de plataforma (por exemplo, transmissões do NOAA Okeanos), sem copiar quadros. Registrar as capturas em `docs/validacao-v3.2`.

### F4 — Shaders de comunidade e tutoriais
- **Fonte/URL:** R10 (Catlike Coding) ; R17 (shaderpack Abyss). Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - A neblina é uma aproximação ruim da física, mas barata e controlável (R10).
  - O Abyss combina absorção por profundidade, lanterna com retroespalhamento e neve marinha com movimento (R17).
- **Licença:** R17 não verificada. Não usar código.
- **Decisão técnica:** confirma o conjunto mínimo do §2: extinção por canal + retroespalhamento das luzes + neve marinha.

---

## 2. Técnicas e custo em WebGL

### F5 — Extinção por canal e in-scatter (base)
- **Fonte:** P18, P20, R15, R16. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Por fragmento: `L = L₀·e^{−c·d} + B∞·(1 − e^{−c·d})`, por canal RGB.
  - B∞ é a radiância de fundo da água: luz solar residual `∝ e^{−Kd·z}` mais a luz das lâmpadas espalhada.
  - Monzón et al. (R16) aproximam o espalhamento múltiplo com o próprio Kd em função da profundidade, o que justifica usar Kd para a luz ambiente e c para a linha de visada.
- **Aplicabilidade:** custo desprezível, uma exponencial por canal. O `FogExp2` do three.js tem cor única e densidade ao quadrado, então **não serve**.
- **Decisão técnica:** manter o caminho atual (`underwaterPass.ts`/`optics.ts`) com **c e Kd separados por canal**. Ler c, Kd e ω do preset ativo e dos volumes do F1.

### F6 — Luz artificial na água
- **Fonte:** R1 §7 (fórmula), R15. Consulta em 2026-11-06, níveis [V2] e [APROX].
- **Informação:** irradiância no alvo `I₀·cosⁿθ·e^{−c·d_L}/d_L²`; o caminho de volta à câmera é atenuado por `e^{−c·d_C}`. Sun et al. (R15) integram analiticamente o espalhamento simples de uma fonte pontual em meio homogêneo, incluindo o **halo** em volta da lâmpada, que a neblina comum não produz.
- **Aplicabilidade:**
  - Spots do three.js com `decay = 2` mais um fator `e^{−c·d}` injetado no shader (`onBeforeCompile` em `lights_fragment`).
  - De 2 a 6 spots sem sombra e no máximo 1 com sombra.
  - [APROX] Em água turva, parte da luz espalhada para a frente ainda ilumina. Usar `c_luz = mix(c, Kd, 0,3)` evita que tudo fique preto a 2 m.
- **Decisão técnica:**
  - Atenuação por canal nas luzes do ROV e do TMS.
  - Halo aditivo barato: sprite na posição da lâmpada, com intensidade ∝ ω·e^{−c·d}, só quando a lâmpada está no campo de visão.

### F7 — Retroespalhamento (cone de luz visível)
- **Fonte:** P20 (Jaffe), R15. Nível [V2].
- **Informação:** o retroespalhamento cresce com a turbidez e com a proximidade entre o eixo da luz e o da câmera. Separar as lâmpadas da câmera estende o alcance útil para ~2–3 comprimentos de atenuação.
- **Aplicabilidade:** ray-march em meia resolução no cone de cada lâmpada, com 8–16 amostras (R1 Dec. 10), ou integral analítica de R15 numa tabela 2D.
- **Decisão técnica:**
  - Ray-march em meia resolução com 8 amostras na qualidade média e 16 na alta. Na baixa, só partículas.
  - O ganho é proporcional a `b·β(θ)` com função de fase de pico frontal. [APROX] Henyey–Greenstein com g ≈ 0,9.

### F8 — Raios de sol (light shafts) e cáusticas
- **Fonte:** [CONHECIMENTO] + P18 (profundidade de 1% da luz ≈ 34–88 m conforme o tipo de Jerlov).
- **Informação:** raios e cáusticas exigem sol direto e superfície ondulada. Os dois somem em poucas dezenas de metros, e as cáusticas antes dos raios.
- **Aplicabilidade:** no sítio, a ~115 m, **não existem**. Só aparecem na descida e na zona de splash.
- **Decisão técnica:**
  - Raios só entre a superfície e ~40 m de profundidade, com intensidade ∝ `e^{−Kd_G·z}` e desligados abaixo disso.
  - Cáusticas só nos 10 m iniciais. Nada disso perto do fundo.

### F9 — Neve marinha
- **Fonte:** R17 (conceito), [APROX].
- **Informação:** partículas em suspensão só ficam visíveis quando estão **dentro do cone** das lâmpadas e perto da câmera. Elas dão a principal pista de movimento relativo à água.
- **Aplicabilidade:**
  - Um único `Points`, com 2.000 a 6.000 partículas numa caixa de ~20 m que acompanha a câmera e "dá a volta" (wrap) em coordenadas do mundo.
  - Iluminação calculada no vertex shader pela distância ao eixo de cada spot.
  - Rastro esticado na direção da velocidade relativa à corrente.
  - Densidade ∝ turbidez.
- **Decisão técnica:** um único draw call de neve marinha, compartilhado por todas as viewports, que leem a mesma posição de mundo. Densidade de 2k na baixa e 6k na alta.

### F10 — Perda de contraste e espalhamento frontal
- **Fonte:** P20, [APROX].
- **Decisão técnica:** blur leve em meia resolução misturado por `1 − e^{−b·d}`, limitado a ~30%. Ruído de sensor que cresce com o ganho da câmera em baixa luz, como numa câmera real de ROV.

### F11 — Exposição e tonemapping
- **Fonte:** [CONHECIMENTO]. O three.js oferece os tonemappings ACES Filmic, AgX e Neutral (não reverificado nesta sessão).
- **Decisão técnica:**
  - Exposição automática lenta (τ ≈ 1–2 s), com limites de EV, por câmera.
  - Tonemapping AgX ou Neutral, que preservam melhor os tons azul-esverdeados que o ACES.
  - O overlay do HUD é desenhado **depois** do tonemapping.

---

## 3. Presets de água (parâmetros propostos)

**Base física [V2]:**

- **Visibilidade horizontal de alvo preto:** V ≈ 4,8 / c_fotópico (Zaneveld & Pegau, erro médio < 10%, R11). Fabricantes usam 4,6 / c(532) (R12). O c em 532 nm (canal G) serve como substituto do fotópico (R11).
- **Limiar de turbidez:** a atenuação por partículas c_p(660) > 1,5 m⁻¹ marca águas dominadas por sedimento (R13).
- **Água pura:** absorção mínima de 0,0044 m⁻¹ em 418 nm (R14). [CONHECIMENTO] Ela vale ~0,009 em 450 nm, ~0,057 em 550 nm e ~0,34 m⁻¹ em 650 nm. Isso é o **piso** do canal R, que nunca fica abaixo de ~0,35.

**Valores propostos [APROX], calibrados com essas âncoras.** Não são medidas de um sítio.

| Preset | Analogia | c (R,G,B) m⁻¹ | L = 1/c (m) | Kd (R,G,B) m⁻¹ | ω = b/c (G) | V preto ≈ 4,8/c_G | Alcance prático com luzes do ROV |
|---|---|---|---|---|---|---|---|
| **Clara** | oceânica, Jerlov IB–II | 0,42 / 0,11 / 0,09 | 2,4 / 9,1 / 11 | 0,38 / 0,06 / 0,04 | 0,55 | ≈ 44 m | 15–25 m |
| **Moderada** | plataforma perto do fundo, Jerlov III / costeira 1 | 0,65 / 0,32 / 0,30 | 1,5 / 3,1 / 3,3 | 0,45 / 0,12 / 0,12 | 0,75 | ≈ 15 m | 6–10 m |
| **Turva** | costeira 5–9 / sedimento | 1,40 / 1,20 / 1,35 | 0,7 / 0,8 / 0,7 | 0,70 / 0,30 / 0,40 | 0,85 | ≈ 4 m | 1,5–3 m |
| *Pluma local* | jato de propulsor perto do fundo | soma de +0,5 a +3 em todos os canais | — | — | 0,9 | < 2 m | < 1 m |

Observações:
- No preset turvo, o canal B é mais atenuado que o G (matéria orgânica dissolvida e sedimento). Isso dá o tom verde-amarronzado das águas costeiras.
- O "alcance prático" é a faixa em que o alvo iluminado ainda se distingue do retroespalhamento: ~2–3 L com luzes afastadas (P20). Ele cai se as luzes ficarem junto da câmera.
- Os valores atuais do `optics.ts` (c ≈ 0,36 / 0,10 / 0,08) equivalem ao preset **Clara**. Basta mapear `visibility` para os três presets em vez de somar uma turbidez escalar.

---

## Decisões para a v3.2

1. **Três presets de água** (Clara / Moderada / Turva) com os c, Kd e ω da tabela do §3, todos rotulados "aproximação calibrada", mais o termo aditivo de **pluma local**, alimentado por `sediment.ts`.
2. **c e Kd separados por canal** no shader. Proibido usar `FogExp2`. O preset Clara é o limite superior de visibilidade: nada de água "ABZÛ".
3. **Luzes do ROV e do TMS com atenuação `e^{−c·d}` por canal**, halo barato junto à lâmpada e retroespalhamento em ray-march de meia resolução (8/16 amostras), com queda para partículas apenas na qualidade baixa.
4. **Neve marinha** num único `Points` iluminado só dentro dos cones, com rastro por velocidade relativa e densidade ∝ turbidez.
5. **Raios de sol abaixo de 40 m e cáusticas abaixo de 10 m estão desligados.** No sítio (~115 m) a única luz é artificial, além de um ambiente residual azul ∝ e^{−Kd·z}.
6. **DoF não simula turbidez.** Exposição automática lenta por câmera e tonemapping AgX/Neutral. O HUD é desenhado depois do tonemapping.
7. **Volumes de água regionais** (2–3 ativos) para variar a turbidez junto às estruturas, no estilo Subnautica, mas com valores físicos.
8. **Calibração visual** contra vídeo público de ROV, registrada em `docs/validacao-v3.2`.

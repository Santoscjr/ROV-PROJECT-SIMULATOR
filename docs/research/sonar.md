# Sonar e altímetro: complemento

Data: 2026-11-06. As referências estão em [references.md](references.md).

**O que já está decidido:**
- Modelo de FLS de R1 §6 e Dec. 3–4: intensidade = refletividade × cosᵏθ, perda `20log10R + αR` com TVG, sombra por feixe e ruído multiplicativo + aditivo.
- Especificação atual em `docs/SONAR.md`: 130° × 20°, alcances de 10–60 m, sensor geométrico sobre a função de altura e os colisores.
- Este documento cobre **o altímetro** e **como o FLS deve enxergar rochas, terreno e dutos**.

**Estado do código.** `RovPhysics.altitude()` devolve a distância **vertical** do fundo do chassi ao leito ou a uma estrutura, com teto de 60 m. Um altímetro real não mede isso.

---

### F1 — Altímetros reais: feixe, faixa, resolução
- **Fontes/URL:** R47 https://www.tritech.co.uk/products/pa200-pa500-altimeters ; R48 https://manuals.online/valeport/measuring-instrument/va500/user-manual/1xmej. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - **PA500:** 500 kHz, **feixe cônico de 6°**; o PA200 tem 20°. O alcance aparece como 0,3–50 m numa ficha, e as fontes divergem. Resolução de 1 mm. O MK2 inclui inclinômetro com precisão de ±0,5°.
  - **VA500:** 500 kHz, faixa de 0,1–100 m, resolução de 1 mm, ângulo de feixe de **±3°** (≈ 6° total). Assume velocidade do som de 1500 m/s, e a precisão melhora ao inserir a velocidade local.
- **Aplicabilidade:** o modelo padrão de ROV é um ecobatímetro monofeixe com cone de ~6°, que mede o **primeiro eco** (o mais próximo) dentro do cone.
- **Limitações:** a precisão absoluta não foi verificada. As faixas divergem entre fontes.
- **Decisão técnica:** altímetro fictício "500 kHz, cone de 6°, 0,3–50 m", sem nome de fabricante.

### F2 — Pegada e o que o altímetro mede sobre rochas e taludes
- **Fonte:** [APROX], geometria derivada do F1.
- **Pegada:** diâmetro = 2·h·tan 3° ≈ **0,105·h**, ou seja, 0,5 m a 5 m de altitude, 1,05 m a 10 m e 5,2 m a 50 m.
- **Sobre rochas ou estruturas:** devolve a distância até o **ponto mais alto dentro da pegada**. Uma rocha de 1 m dentro do cone, a 10 m, faz a leitura cair para ~9 m. A leitura "pula" quando o ROV passa sobre blocos, o que é um comportamento real e útil para o piloto.
- **Em talude de inclinação α**, com o veículo nivelado e meia-abertura β = 3°:
  - α ≤ β: `r = h·cos α` (pé da perpendicular dentro do cone);
  - α > β: `r = h·cos α / cos(α − β)`.
  - Exemplos a h = 10 m: α = 20° → 9,83 m; α = 45° → 9,51 m. A leitura fica **curta** em relação à vertical.
- **Com o ROV inclinado θ sobre fundo plano:** se |θ| > β, `r = h / cos(|θ| − β)`. A leitura fica **longa**, exceto se o inclinômetro compensar. O PA500 MK2 tem inclinômetro (F1).
- **Perda de eco:** fora da faixa (> 50 m ou < 0,3 m), incidência rasante sobre lama (baixa refletividade) ou pluma densa → leitura inválida ("---"), não zero.
- **Decisão técnica:**
  - O altímetro passa a lançar **7 raios**: o eixo e um anel de 6 a 3°, presos ao corpo do ROV (inclinam com pitch/roll).
  - Cada raio é testado contra a função de altura (marcha + bisseção) e os colisores, e o resultado é o **mínimo** dos raios com retorno acima do limiar.
  - Ruído de σ = 0,01 m + 0,1%·r, atualização a **5 Hz**, exibição em cm e "---" fora da faixa [APROX].
  - O `altitude()` vertical continua existindo só para a física e o autopiloto. O HUD mostra o **altímetro**.

### F3 — Como o FLS deve ver terreno, rochas e dutos
- **Fonte:** R1 §6 (P11 Stonefish, P12 Cerqueira: conceitos), `docs/SONAR.md`, [APROX].
- **Refletividade relativa por material [APROX]**, alimentada pela máscara de sedimento (seabed-generation F4):

  | Material | Refletividade | Comentário |
  |---|---|---|
  | rocha / bloco | 0,8–1,0 | face voltada ao sonar brilhante, sombra longa atrás |
  | cascalho / conchas | 0,5–0,7 | textura granulada |
  | areia | 0,3–0,45 | ripples em listras fracas |
  | lama | 0,1–0,2 | quase escura em incidência rasante |
  | aço (estrutura, duto) | 1,0 + termo especular | brilho máximo quando o feixe é ~perpendicular à superfície |

- **Sombra acústica:** objeto de altura H a alcance R, com o sonar a altura h_s acima do fundo → sombra de comprimento ≈ `H·R/(h_s − H)`. O modelo atual de "primeiro eco forte por feixe" já reproduz isso geometricamente. Só precisa de colisores para os objetos.
- **Dutos:**
  - Aparecem como **linha brilhante** com sombra paralela atrás.
  - O brilho é máximo quando o duto é perpendicular ao feixe e cai muito quando ele é quase paralelo, porque o termo especular depende do ângulo.
  - Um duto parcialmente enterrado tem eco mais fraco e sombra curta.
  - Em vão livre (free span), a sombra fica **separada** do eco por uma faixa de fundo iluminado. É o sinal clássico de vão.
- **Rochas:** só os **blocos de 0,8 m ou mais** entram como colisores simples (elipsoide ou esfera) no conjunto do sonar, gerados pela mesma semente por tile. As pedras menores entram como ruído de refletividade da máscara.
- **Ripples:** sem geometria. Modulam a intensidade por `1 + 0,15·sin(fase_ripple)` quando a incidência é rasante, avaliando a mesma função do shader na CPU.
- **Decisão técnica:**
  - Adicionar refletividade por material, termo especular para aço, colisores de blocos e modulação de ripples.
  - Manter a regra do `docs/SONAR.md`: se o objeto não existe na cena, não há eco.

---

## Decisões para a v3.2

1. **Altímetro de cone de 6°** (7 raios presos ao corpo), devolvendo o **primeiro eco** dentro do cone. Faixa de 0,3–50 m, ruído de 1 cm + 0,1%, 5 Hz e "---" fora da faixa ou sem eco.
2. O HUD mostra o altímetro. O `altitude()` vertical fica para a física e o autopiloto.
3. Comportamento esperado e testável: **leitura curta em taludes, saltos sobre blocos e leitura longa com pitch/roll** acima de 3°. Um teste unitário por caso.
4. FLS com **refletividade por material** (rocha > cascalho > areia > lama) a partir da máscara de sedimento, e **aço com termo especular**.
5. **Dutos:** linha brilhante + sombra, eco fraco quando enterrado e sombra separada em vão livre.
6. **Blocos ≥ 0,8 m como colisores** do sonar (deterministas por tile). Ripples só como modulação de intensidade.

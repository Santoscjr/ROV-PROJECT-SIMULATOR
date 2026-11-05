# Sonar de imageamento frontal (FLS): modelo e limitações

Código: `src/render/sonar.ts` · Testes: `tests/sonarGeometry.test.ts`, `tests/sonar.test.ts`

O sonar do simulador é um **sensor geométrico**: cada eco vem de uma interseção
real entre os feixes acústicos e a geometria da cena (fundo marinho + colisores
das estruturas). Não há imagem pré-desenhada, animação nem eco "sintético".
Se um objeto não existe na cena, ele não gera retorno; se existe, o retorno
depende do alcance, da marcação, da incidência, da oclusão, do alcance
selecionado, do ganho e da resolução.

> **Todos os parâmetros abaixo são aproximações escolhidas para o simulador.**
> Nenhum valor foi copiado de especificação de fabricante. Os números são
> plausíveis para um FLS de inspeção de ROV, mas não representam nenhum
> equipamento comercial.

## 1. Sensor modelado

Sonar de imageamento frontal multifeixe (*Forward-Looking Sonar*, FLS)
montado no ROV, apontado para a proa e inclinado para baixo.

| Parâmetro | Valor | Observação |
|---|---|---|
| Abertura horizontal (FOV) | 130° | `SONAR_FOV`, fixo (`sonar.fov`) |
| Abertura vertical | 20° (±10° em torno do eixo) | `SONAR_HALF_BEAM_V` |
| Inclinação (tilt) | 0–45°, padrão 15° abaixo da horizontal | `setTilt`, ajuste do operador |
| Alcances | 10 / 20 / 40 / 60 m | `SONAR_RANGES` |
| Feixes × bins | baixa 48 × 80 · média 96 × 128 · alta 128 × 192 | `setQuality` |
| Espaçamento angular | 2,71° · 1,35° · 1,02° | 130° / feixes |
| Taxa de ping | ≈ 4,3 Hz a 60 fps (1 ping a cada ≈ 14 quadros) | medida e exibida no cabeçalho |

Resolução em alcance (tamanho do bin = alcance / bins), em metros:

| Qualidade | 10 m | 20 m | 40 m | 60 m |
|---|---|---|---|---|
| baixa (80) | 0,125 | 0,25 | 0,50 | 0,75 |
| média (128) | 0,078 | 0,156 | 0,31 | 0,47 |
| alta (192) | 0,052 | 0,104 | 0,21 | 0,31 |

### Convenções

- Mundo: +Y para cima, norte = −Z, leste = +X. Rumo 0 = norte, 90 = leste
  (mesma convenção de `RovPhysics.heading`).
- Feixe 0 é a borda de **bombordo** (marcação relativa −65°); o índice cresce
  para **boreste**. Na tela, boreste fica à direita. `beamBearing(b, beams)`
  devolve a marcação relativa do centro do feixe `b`.
- Bin `i` cobre alcances inclinados (*slant range*) `[i·Δr, (i+1)·Δr)`.
- `lastPing()` devolve `{ data, beams, bins, range, heading, tilt }`, com
  `data[b·bins + i]` = nível de eco (0…≈1), sem ruído.

### Cadência de atualização

- O ping é calculado **incrementalmente**: `scan(pos, rumo, n)` processa `n`
  feixes por quadro (mínimo `ceil(feixes / 14)`), então um ping completo leva
  ≈ 14 quadros.
- Posição e rumo são **travados no início de cada ping** (todos os feixes do
  ping usam a mesma pose) e a tela mostra sempre o **último ping completo**
  (buffer duplo, sem "rasgo" de imagem).
- `app.ts`/`monitorWindow.ts` só chamam `scan` enquanto um painel exibe o
  sonar.
- Simplificação: a taxa de ping não depende do alcance. Num sonar real o limite
  físico é 2·R/c (≈ 12 Hz a 60 m); aqui a taxa depende do quadro de renderização.

## 2. Modelo de eco

Cada feixe é um leque vertical fino na marcação do feixe, de `−tilt − 10°` a
`−tilt + 10°` de elevação.

### 2.1 Estruturas (colisores de `site.ts`)

- 21 sub-raios (1° de espaçamento) varrem a abertura vertical do feixe.
- Cada sub-raio é testado **analiticamente** contra os colisores candidatos:
  caixa girada em Y (método das placas/slabs) e cápsula (cilindro + calotas).
  Só o **primeiro** impacto de cada sub-raio gera eco → objetos mais próximos
  escondem os mais distantes (oclusão entre estruturas).
- Cada sub-raio é um cone fino (meia-abertura = metade do espaçamento entre
  feixes ou sub-raios, o maior). Objetos mais finos que o espaçamento (dutos a
  longa distância) são detectados mesmo quando o raio central passa ao lado;
  nesse caso o alcance reportado é o da **superfície real** do objeto (ponto
  especular da cápsula voltado ao sonar / ponto mais próximo da caixa) e a
  intensidade é multiplicada pela fração do cone preenchida.
- Um impacto de estrutura que esteja atrás do fundo (o sub-raio bate no fundo
  antes) é descartado.

### 2.2 Fundo marinho (função de altura do terreno)

- Para cada bin (alcance r), encontra-se a elevação em que a esfera de raio r
  toca o fundo dentro do feixe (±2° de margem para oclusão). Solução por
  *regula falsi* em sen(elevação): exata para fundo plano, 1–3 amostras do
  terreno por bin.
- **Sombra de terreno**: um ponto do fundo cuja elevação está abaixo do
  "horizonte" já visto em alcances menores (crista de relevo) não gera eco.
- **Sombra acústica de estruturas**: a linha de visada até o ponto do fundo é
  testada (exatamente, sem cone) contra os colisores atingidos naquele feixe; se
  cruzar algum, o ponto não gera eco. A sombra resulta da geometria (altura do
  objeto, ângulo rasante), não de um comprimento fixo.

### 2.3 Intensidade (nível no `data` do ping)

```
eco_estrutura = 1,0 × preenchimento × (0,2 + 0,8·|cos θ_inc|) × P(δ) × L(r)
eco_fundo     = (0,1 + 0,5·sen(α_rasante)^0,7)            × P(δ) × L(r)
P(δ) = 0,35 + 0,65·cos²(90°·δ/10°)   se |δ| ≤ 10°, senão 0   (padrão vertical)
L(r) = 0,6 + 0,4 / (1 + 0,02·r)                               (espalhamento + absorção)
```

- θ_inc: ângulo entre a normal da superfície e o raio; α_rasante: ângulo entre
  o raio e o plano tangente do fundo (gradiente do terreno).
- Refletividade de estrutura (aço) 1,0 contra no máximo ≈ 0,6 do fundo
  (sedimento): estruturas se destacam do fundo no mesmo alcance.
- Por bin guarda-se o **máximo** dos ecos que caem nele (independe do número de
  sub-raios).

### 2.4 Exibição (só afeta a tela, nunca o ping)

`sonarDisplayLevel(eco, fraçãoDeAlcance, ganho, speckle)`:

```
v0    = eco · TVG · ganho · (0,8 + 0,4·s) + 0,02 + 0,03·s·(0,4 + fração)
TVG   = 1 + 2,2·fração          (ganho variável no tempo)
nível = 1 − exp(−1,7·v0)        (compressão)
```

- `s` é speckle uniforme [0,1] de uma tabela fixa, deslocada a cada ping.
- O ganho multiplica só o eco. O piso de ruído é fixo e fica **sempre abaixo de
  `SONAR_DETECT_LEVEL` (0,2)**, em qualquer ganho: ruído nunca forma alvo. Um
  eco fraco de fundo (0,06 no fim do alcance) já passa do limiar.
- Paleta azul sobre preto (preto → azul-marinho → azul → ciano → branco).
- Sobreposições: anéis de alcance em passo "redondo" (2/5/10 m) com rótulos ao
  longo da radial de +30°; radiais e marcas de marcação relativa a cada 10°
  (rótulos a cada 30°, + = boreste); cabeçalho com FOV, alcance, ganho, tilt,
  rumo e taxa de ping. Texto com contorno escuro; o cabeçalho escolhe uma
  versão compacta e/ou fonte menor para não ser cortado (testado de 160×100 a
  1920×1080).

## 3. Limitações (o que NÃO é modelado)

- Multipercurso, reflexão na superfície, refração (perfil de velocidade do som),
  lóbulos laterais, reverberação de volume, Doppler, interferência entre pings.
- Feixe horizontal: só a linha central do feixe ilumina o fundo; estruturas
  usam o cone. Não há padrão de feixe horizontal (o "borrão" lateral é de
  ±1 feixe).
- Fundo com "dobras" (mais de um cruzamento na mesma esfera de alcance dentro
  do feixe) usa apenas o cruzamento superior.
- Sombra de estrutura no fundo é testada com um ponto por bin; sombras menores
  que um bin podem desaparecer.
- Colisores são aproximações das malhas visuais (caixas e cápsulas); detalhes
  finos das estruturas (válvulas, grades) não aparecem.
- Sem ruído no dado do ping (determinístico); o ruído existe só na tela.
- Tilt e FOV são fixos durante o ping; o rolamento/arfagem do ROV não inclina o
  leque (o sonar usa só posição e rumo).

## 4. Custo

- Medido no teste `tests/sonar.test.ts` (Node, máquina de CI):
  média ≈ 0,2–0,4 ms/quadro em qualidade média (cena sintética) e ≈ 2 ms/quadro
  em qualidade alta no sítio real (90 cápsulas do duto + terreno procedural).
- O custo dominante é a avaliação de `terrainHeight` (≈ 0,2 µs/chamada):
  ≈ 5 chamadas por bin. Os colisores custam pouco graças ao corte em dois
  níveis (setor do ping e plano do feixe).
- A imagem só é redesenhada quando um ping termina ou o painel muda de tamanho;
  a tabela pixel → (feixe, bin) é cacheada.

## 5. Cenas de referência (testes)

`tests/sonarGeometry.test.ts` usa terreno analítico e colisores sintéticos:

| Teste | O que prova |
|---|---|
| (a) parede vertical | pico na faixa de alcance geométrica da parede (±1 bin) nos feixes centrais; eco contínuo; nada atrás (sombra total), enquanto a cena sem parede mostra fundo ali |
| (a2) parede, tilt 0 | pico no alcance normal `D/cos(marcação)` ±1 bin |
| (b) duto atravessando o leque | eco no alcance do duto em todos os feixes que ele cruza, ≥ 2× o fundo no mesmo alcance |
| (c) caixa pequena a ±30° | retorno só nos feixes dentro da extensão angular (±1 feixe), lado correto (bombordo/boreste), alcance correto |
| (c2) rumo | objeto a leste fica no centro com rumo 90 e some com rumo 270 |
| (d) fundo plano × tilt | primeiro retorno = h / sen(tilt + 10°) ±2 bins, decrescente com o tilt |
| (d2) fundo inclinado lateralmente | primeiro retorno decresce de bombordo para boreste e bate com a fórmula analítica |
| (d3) crista de relevo | sombra de terreno atrás da crista, fundo volta a aparecer onde a geometria prevê |
| (e) objeto atrás de outro | o objeto oculto não aparece nos feixes ocluídos e aparece nos não ocluídos |
| (f) cena vazia | zero absoluto em todos os alcances |
| (f2) objetos fora do leque / além do alcance / acima ou abaixo do feixe vertical | zero absoluto |
| (f3) ruído de tela | piso de ruído < limiar de detecção em qualquer ganho |
| (g) alcance | o bin da parede reescala com o alcance; parede além do alcance some |
| (g2) ganho | dado do ping idêntico bit a bit; só o nível exibido muda |
| (g3) qualidade | alcance medido igual (±1,5 bin) em baixa/média/alta |

## 6. API pública

Inalterada: `new Sonar(terreno, colisores)`, `.canvas`, `.scan()`, `.draw()`,
`.configure()`, `.setRange/.setTilt/.setGain/.setQuality`, `.lastPing()`,
`range`, `fov`, `tilt`, `gain`, `quality`, `SONAR_RANGES`, `SonarQuality`.

Novos: `SonarPing` (tipo do ping), `SONAR_FOV`, `SONAR_HALF_BEAM_V`,
`SONAR_DETECT_LEVEL`, `beamBearing()`, `sonarDisplayLevel()`, `sonarLayout()`,
`Sonar.binSize`.

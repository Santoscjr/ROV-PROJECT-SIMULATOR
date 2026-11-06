# Geração procedural do leito marinho

Data: 2026-11-06. As referências estão em [references.md](references.md).

**O que o código já faz.**
- `src/sim/terrain.ts` tem value noise com hash inteiro e fBm determinístico. A altura é compartilhada entre física e render.
- `src/render/seabed.ts` cobre a área `SEABED_BOUNDS` = 370 × 340 m (x −140…230, z −230…110) com uma `PlaneGeometry` de 140 a 300 subdivisões.
- Rochas, seixos, vida e conchas são instanciados (260–1100 rochas) em 2 a 4 "chunks".

---

### F1 — Determinismo e sementes
- **Fonte:** [CONHECIMENTO]. O padrão já está no código (`hash2`).
- **Informação:** a mesma semente deve gerar o mesmo leito em física, render, sonar e altímetro, em qualquer ordem de carga.
- **Aplicabilidade:** cada tile deriva sua semente de `hash(semente_global, ix, iz, camada)`. O PRNG é local ao tile (xorshift/mulberry32) e nunca `Math.random`.
- **Limitações:** ponto flutuante entre GPUs. Por isso a altura usada pela física **não** pode vir do shader.
- **Decisão técnica:** toda geometria e todo posicionamento são calculados na CPU a partir do `terrain.ts`. O shader só acrescenta detalhe visual sem efeito físico (normal map de ripples). Um teste de regressão compara hashes das alturas por tile.

### F2 — Formas de leito: ripples, megaripples, ondas de areia
- **Fonte/URL:** R52 https://repository.si.edu/server/api/core/bitstreams/6fcdd87f-dbdd-4f78-babf-168421f017c9/content. Consulta em 2026-11-06, nível [V2].
- **Informação (Vineyard Sound, correntes de maré):**

  | Forma | Altura | Comprimento de onda |
  |---|---|---|
  | Ripples | < 10 cm | < 1 m |
  | Megaripples | até 1 m | 1–20 m |
  | Ondas de areia | de 1 a vários metros | 20–200 m |

  A classificação de Ashley (1990) não foi lida.
- **Aplicabilidade:** as cristas ficam perpendiculares à corrente dominante. A ~115 m, numa plataforma com corrente moderada, o realista é ripples e no máximo megaripples baixas [APROX].
- **Limitações:** são dados de um sítio raso de maré.
- **Decisão técnica:**
  - **Ripples** (λ 0,3–0,8 m): só normal map procedural no shader, ao longo da direção da corrente média, com fase deformada por ruído para não ficarem paralelas demais.
  - **Megaripples** (λ 4–12 m, H 0,1–0,4 m): na geometria, com máscara de ruído para que existam só em manchas de areia.
  - **Ondas de areia:** uma ondulação de baixa frequência opcional (λ 60–120 m, H ≤ 1 m).
  - Ripples **nunca** entram na física.

### F3 — Espalhamento de rochas: Poisson-disc com agrupamento
- **Fonte/URL:** R51 https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf. Consulta em 2026-11-06, nível [V2].
- **Informação:** o algoritmo de Bridson gera amostras Poisson-disc em tempo O(N). Os candidatos são sorteados num anel ao redor das amostras ativas, e k = 30 tentativas é a convenção usual.
- **Aplicabilidade:**
  - Poisson-disc puro deixa as rochas **uniformes demais**, com cara artificial.
  - Leitos reais têm campos de cascalho, blocos isolados e zonas limpas. A combinação prática é Poisson-disc (raio mínimo por classe de tamanho) com **aceitação modulada por uma máscara de ruído de baixa frequência** (clusters) e **zonas de exclusão**.
- **Limitações:** Poisson-disc em tiles exige tratar a borda. Ou se gera numa grade global por classe, ou se replicam as amostras dos vizinhos.
- **Decisão técnica:**
  - Três classes: blocos de 0,8–2,5 m com r_min 6 m; pedras de 0,2–0,8 m com r_min 1,5 m; seixos de < 0,2 m só como textura ou instâncias pequenas perto da câmera.
  - Densidade = máscara de ruído com limiar ~0,55 para formar clusters.
  - Exclusão: raio de 8–15 m em volta de manifold, árvore, PLET e dutos, e corredor de 3 m ao longo de dutos. Nas cicatrizes de instalação (`SCARS`), mais cascalho.
  - As rochas ficam **enterradas** 20–40% da altura e levemente alinhadas à normal. Nada flutuando.

### F4 — Manchas de sedimento e materiais
- **Fonte:** [APROX], com a mesma lógica de "splat map" usada em terrenos de jogos.
- **Decisão técnica:**
  - Máscara procedural de 4 canais (areia, lama, cascalho/conchas, área perturbada) avaliada na CPU por tile e gravada como atributo de vértice ou textura de tile de 64².
  - A mesma máscara alimenta (a) a cor e a rugosidade, (b) a refletividade do sonar (ver sonar.md) e (c) a facilidade de ressuspensão pelo propulsor (`sediment.ts`).

### F5 — Tiles e LOD: CDLOD × geomipmapping × LOD por distância
- **Fonte/URL:** R49 https://github.com/fstrugar/CDLOD ; R50 (quadtree restrita). Consulta em 2026-11-06, nível [V2]. Geomipmapping/skirts: [CONHECIMENTO], de Boer (2000), não reaberto.
- **Informação:**
  - **CDLOD:** quadtree de grades regulares com LOD função da distância 3D real. Uma faixa de *morph* (por exemplo, 30% do nó) desloca os vértices para a grade grossa no shader, sem costuras nem "popping".
  - **Quadtree restrita:** vizinhos diferem no máximo um nível, e as bordas recebem vértices extras.
  - **Geomipmapping:** tiles com níveis 2ⁿ+1. As fendas entre níveis são fechadas com faixas de costura ou **skirts**, abas verticais na borda que escondem a fenda.
- **Aplicabilidade ao nosso caso:**
  - A água limita a visão a ≤ ~45 m no preset mais claro e a 1,5–10 m nos demais (underwater-rendering §3). Além de ~60–80 m, o terreno fica **totalmente invisível** na câmera.
  - O sonar e o altímetro usam a função de altura e não a malha (`docs/SONAR.md`).
  - Por isso, CDLOD completo é exagero. Morph no shader exige a altura na GPU, o que conflita com o F1.
- **Limitações:** as skirts aparecem em vista rasante muito próxima, o que é raro com ROV perto do fundo e neblina.
- **Decisão técnica:**
  - **Tiles fixos com LOD discreto por distância + skirts.**
  - Tile de **32 × 32 m** (12 × 11 tiles = 132 para 370 × 340 m, com as bordas cortadas).
  - Três níveis: 65² vértices (0,5 m) até 40 m; 33² (1 m) até 90 m; 17² (2 m) além disso.
  - Skirt de 1–2 m na cor do leito.
  - Histerese de ±5 m para não oscilar.
  - Tiles além de `5/c_G + 20 m` ficam desligados para a câmera, e a distância se recalcula ao trocar de preset.

### F6 — Instanciamento e "sem poluição visual"
- **Fonte/URL:** R55 https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221 ; R56. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - `InstancedMesh` atende uma geometria por draw call.
  - `BatchedMesh` atende várias geometrias com *culling* e ordenação por instância.
  - Nenhum dos dois tem LOD nativo, e extensões de terceiros (R56) suprem isso.
  - O culling só compensa se a economia de vértices superar o custo de chamadas.
- **Aplicabilidade e prática de jogos** [CONHECIMENTO]:
  - Leitos convincentes usam **poucos modelos-base** (3–5 por classe) com variação de escala, rotação e tom por instância.
  - Concentram detalhe onde a câmera trabalha (perto das estruturas) e deixam grandes áreas planas e limpas.
  - Detalhe miúdo vira textura, não geometria.
- **Decisão técnica:**
  - Um `InstancedMesh` por (classe de rocha × bloco de 4 × 4 tiles), o que dá culling grosso por bounding sphere do bloco e ~10–20 draw calls de rochas visíveis.
  - Seixos e conchas só nos tiles a menos de 25 m da câmera.
  - Densidade-alvo [APROX]: blocos ≤ 1 por 100 m² em média, concentrados em clusters.

### F7 — Carga progressiva
- **Fonte:** [APROX] + performance.md (fatiamento de trabalho).
- **Decisão técnica:**
  - **Na partida:** gerar primeiro o tile do ROV e os 8 vizinhos em LOD0 e o restante em LOD2. Isso basta para a primeira imagem.
  - **Depois:** completar e refinar numa fila priorizada por distância, com orçamento de **2–3 ms por quadro**.
  - **Opcional:** um Web Worker gera alturas, normais e máscara (ArrayBuffers transferíveis). A física usa a função analítica e não espera a malha.
  - **Durante a descida do TMS:** o leito não é visível, o que dá tempo para concluir tudo antes de o ROV chegar a ~50 m de altitude.

---

## Decisões para a v3.2

1. **Grade de tiles de 32 m** sobre os 370 × 340 m, com **3 LODs discretos** (0,5 / 1 / 2 m), skirts e histerese. **CDLOD descartado**: a turbidez esconde o horizonte e a altura precisa ficar na CPU para física e sonar.
2. **Determinismo:** semente por tile `hash(seed, ix, iz, camada)`, PRNG local e teste de hash das alturas.
3. **Formas de leito:** ripples só no normal map, megaripples em manchas e ondas de areia opcionais, todas orientadas pela corrente média do sítio.
4. **Rochas:** Poisson-disc (Bridson) por classe, aceitação por máscara de clusters, zonas de exclusão nas estruturas e dutos, e enterramento de 20–40%.
5. **Máscara de sedimento de 4 canais** compartilhada por cor, refletividade do sonar e ressuspensão.
6. **Instâncias** por (classe × bloco 4 × 4 tiles). Seixos e conchas só a menos de 25 m da câmera.
7. **Carga progressiva** por distância com orçamento de 2–3 ms por quadro, concluída durante a descida.

# Desempenho em WebGL/Three.js

Data: 2026-11-06. As referências estão em [references.md](references.md).

**Contexto.** A janela principal renderiza para os monitores via `window.opener` (R1 Dec. 12), com várias viewports (câmera principal, quad, sonar). O alvo é GitHub Pages estático com GPUs integradas comuns.

---

### F1 — Instancing: InstancedMesh × BatchedMesh
- **Fonte/URL:** R55 https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221 ; R56 https://www.npmjs.com/package/@three.ez/instanced-mesh. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Os dois desenham muitas instâncias de um material num draw call.
  - `InstancedMesh` atende **uma** geometria. `BatchedMesh` usa multi-draw para **várias** geometrias, com culling e ordenação por instância.
  - Nenhum dos dois tem LOD nativo. O InstancedMesh2 (R56, licença não verificada) acrescenta culling por instância com BVH e LOD.
  - Culling por instância só compensa se poupar mais vértices do que custa.
- **Decisão técnica:**
  - `InstancedMesh` por (classe de rocha × bloco de tiles), já que o culling grosso vem do bloco (seabed-generation F6).
  - `BatchedMesh` só se o número de modelos distintos de detritos passar de ~8.
  - Sem dependência de terceiros.

### F2 — LOD e culling por distância
- **Fonte:** seabed-generation F5, [CONHECIMENTO].
- **Decisão técnica:**
  - O `frustumCulled` padrão do three.js por objeto (tile ou bloco).
  - Um **corte por distância de visibilidade da água** (`5/c_G + 20 m`) aplicado antes do frustum, por câmera.
  - Câmeras de ré e de pulso usam distância de corte menor (< 20 m).

### F3 — Várias viewports: um renderer, scissor
- **Fontes/URL:** R57 https://threejs.org/manual/en/multiple-scenes.html ; R58 ; R59. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Cada `WebGLRenderer` cria um contexto WebGL. O limite do navegador fica em torno de 8 pelo manual ou ~16 conforme o dispositivo (R58), e ao passar dele o contexto mais antigo é perdido.
  - Contextos **não compartilham** recursos: modelo e texturas são carregados de novo em cada um.
  - O padrão recomendado é **um canvas, um renderer** e `setViewport` + `setScissor` + `setScissorTest` por vista.
  - No backend WebGPU (r184), há relato de viewport e scissor ignorados no RenderPipeline (R59).
- **Aplicabilidade:**
  - O custo de N viewports é ~N× o custo de vértices e draw calls da cena visível em cada uma, mais os pós-processos por vista.
  - O que pesa é o **pós-processo em resolução cheia por vista**.
- **Decisão técnica:**
  - Manter um único renderer WebGL.
  - Orçamento por vista: a principal leva o pós-processo completo; as vistas do quad usam a extinção no material (sem pass), sem ray-march de retroespalhamento (só partículas) e resolução de render de 50–75%.
  - Câmeras do quad atualizadas em rodízio: 2 por quadro, ou seja, 30 Hz cada a 60 fps.
  - **Não migrar para WebGPU** na v3.2 sem testar o split-screen.

### F4 — Render targets: reutilização
- **Fonte:** [CONHECIMENTO].
- **Decisão técnica:**
  - Um pool de `WebGLRenderTarget` por tamanho, com chave (w, h, formato) e alocado uma única vez.
  - No resize, realocar só quando o tamanho muda mais de 10%, com debounce de 200 ms.
  - Os passes de meia resolução (retroespalhamento, blur) compartilham 2 alvos de ping-pong entre todas as vistas, porque são renderizados em sequência.
  - Chamar `dispose()` explicitamente ao trocar a qualidade.

### F5 — Streaming de chunks sem travar
- **Fonte:** seabed-generation F7, [APROX].
- **Decisão técnica:**
  - Fila de trabalho com orçamento de **2–3 ms por quadro**, medido com `performance.now()`.
  - Geração de alturas e máscaras opcionalmente num Worker, com ArrayBuffers transferíveis.
  - Upload de geometria limitado a 1–2 tiles por quadro.
  - Reutilizar `BufferGeometry` de tiles descartados (pool), porque a topologia é idêntica por LOD.

### F6 — Medição
- **Fontes/URL:** R53 https://web3dsurvey.com/webgl2/extensions/EXT_disjoint_timer_query_webgl2 ; R54 https://bugzilla.mozilla.org/show_bug.cgi?id=1255805. Consulta em 2026-11-06, nível [V2]. `renderer.info`: [CONHECIMENTO].
- **Informação:**
  - O `EXT_disjoint_timer_query_webgl2` está disponível no Chrome **só em algumas plataformas**. No Firefox, não há suporte em WebGL2.
  - A extensão já foi removida de todos os navegadores por segurança (ataque GLitch) e voltou de forma parcial.
  - O `renderer.info` do three.js dá `render.calls`, `triangles`, `points`, `lines`, `memory.geometries` e `memory.textures`. Ele zera a cada `render()`, a menos que `info.autoReset = false`, que é o necessário com várias viewports.
- **Decisão técnica:**
  - Painel de diagnóstico (`src/diag`) com: tempo de CPU do quadro (`performance.now`), FPS, chamadas e triângulos somados por quadro (`autoReset = false` e `info.reset()` manual) e tempo de GPU **quando a extensão existir**. Sem ela, mostrar "GPU: n/d".
  - Nunca condicionar a lógica de qualidade automática à extensão. Usar o tempo de quadro.

### F7 — SwiftShader (render por software)
- **Fontes/URL:** R60 https://chromium.googlesource.com/chromium/src/+/da170c2267b2201954efe1c8fa5d2d89ab09f7bf/docs/gpu/swiftshader.md ; R61. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - O fallback automático de WebGL para SwiftShader foi **descontinuado**. A depreciação começou no Chrome 130, com remoção no desktop prevista para o 137, e a criação do contexto passa a **falhar**.
  - Para testes headless ou sem GPU, há opt-in com `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`.
  - O SwiftShader era ~2,7% dos contextos WebGL e não é usado no mobile.
- **Aplicabilidade:**
  - (a) Usuários sem GPU acelerada passam a ver **falha de contexto**, não lentidão.
  - (b) As validações automatizadas (`docs/validacao-v3.2`) em CI ou container rodam em SwiftShader. Os números de FPS medidos lá **não representam** GPU real e servem só para checar correção visual e funcional.
- **Decisão técnica:**
  - Tela de erro amigável quando `getContext('webgl2')` falhar ("aceleração gráfica indisponível").
  - Detectar `UNMASKED_RENDERER` contendo "SwiftShader" e forçar a qualidade baixa com aviso.
  - Os scripts de validação passam o opt-in explicitamente e rotulam as métricas como "software".

---

## Decisões para a v3.2

1. **Um renderer, várias viewports com scissor.** A principal leva o pós-processo completo. O quad tem extinção no material, 50–75% de resolução e atualização em rodízio de 2 câmeras por quadro.
2. **InstancedMesh por classe × bloco de tiles.** `BatchedMesh` só se houver mais de ~8 modelos distintos. Sem bibliotecas de terceiros.
3. **Corte por distância de visibilidade da água** por câmera, antes do frustum culling.
4. **Pool de render targets** e 2 alvos de ping-pong de meia resolução compartilhados. `dispose()` ao trocar a qualidade.
5. **Streaming com orçamento de 2–3 ms por quadro**, no máximo 1–2 uploads de tile por quadro e pool de geometrias.
6. **Diagnóstico:** `renderer.info` com `autoReset = false` somado por quadro. Tempo de GPU só se `EXT_disjoint_timer_query_webgl2` existir; senão, "n/d".
7. **SwiftShader:** detectar, forçar a qualidade baixa e avisar. Mensagem clara se não houver contexto. Métricas de CI rotuladas como "software".

# Pesquisa técnica — simulador de ROV work class

Pesquisa feita em **05/11/2026** pelo Agente 7 (Pesquisa Técnica), na branch `recovery/v3.2`. Usei buscas na web (WebSearch), leitura de páginas (WebFetch), arquivos brutos do GitHub (`raw.githubusercontent.com`) e o pacote npm `@mdn/browser-compat-data` **8.1.8** (publicado em 02/11/2026), consultado localmente para os dados de compatibilidade dos navegadores. Fiz cerca de 30 consultas.

**Restrição de rede desta sessão.** Os hosts abaixo **não resolveram** no ambiente de pesquisa. Nenhum conteúdo deles foi lido diretamente:

- `www.imca-int.com` (os dois links IMCA pedidos);
- `developer.mozilla.org`;
- `uuvsimulator.github.io`;
- `robots.et.byu.edu` e `holoocean.readthedocs.io`;
- `arxiv.org` e `omlc.org`.

Quando a informação veio só do resumo que o mecanismo de busca devolve, sem abrir a página, ela aparece como **V2**.

**Níveis de evidência usados neste documento:**

- **VERIFICADO-V1:** conteúdo lido diretamente, seja a página, o arquivo bruto ou os dados do BCD.
- **VERIFICADO-V2:** trecho devolvido pela busca, página não aberta. É confiável para orientar decisões, mas convém conferir antes de citar como especificação.
- **HIPÓTESE / APROXIMAÇÃO:** conhecimento geral de engenharia ou escolha de modelagem, sem fonte confirmada aqui.

Nenhum código de terceiros foi copiado para o projeto nem para este documento. Os números citados são dados publicados, usados como referência de ordem de grandeza.

---

## 1. Tabela principal de referências

| # | Referência | URL | Tipo de fonte | O que foi efetivamente verificado | Relevância | Solução aplicável | Limitações | Licença (se código) | Decisão técnica |
|---|---|---|---|---|---|---|---|---|---|
| 1 | IMCA – documento 60d8d35a… | https://www.imca-int.com/resources/technical-library/document/60d8d35a-c55b-ee11-8def-6045bdd2c0c0/ | Norma/guia setorial | **Nada.** O host não resolveu. A busca pelo GUID não identificou o título. | Alta (presumida) | — | Inacessível nesta sessão; downloads da IMCA podem exigir login de membro (V2) | — | Não citar conteúdo. Revisar quando o domínio for liberado. |
| 2 | IMCA – documento aed42e5e… | https://www.imca-int.com/resources/technical-library/document/aed42e5e-c55b-ee11-8def-6045bdf1ea43/ | Norma/guia setorial | **Nada.** Mesmo caso do item 1. | Alta (presumida) | — | Idem | — | Idem |
| 3 | IMCA R 004 (operação segura e eficiente de ROVs) | https://legacy.imca-int.com/?p=28381 | Guia setorial (página de catálogo) | V2: Rev. 6 de fev/2024, com inclusão de ROC (operação remota). Seções: classificação, tarefas, ferramentas, ambiente, operações, certificação, pessoal. | Média | Vocabulário e escopo de operações | Texto integral não lido | — | Usar só como referência de terminologia |
| 4 | IMCA Safety Flash SF 11/11 (ROV/TMS caído) | https://imca-int.com/resources/safety/safety-flashes/1111-equipment-damage-dropped-rovtether-management-system-tms | Relato de incidente | V2: lançamento com as duas travas não engatadas; a de ré só foi checada visualmente. Ações: alarmes, marcas pintadas, câmeras de trava e intertravamento planejado. | **Alta** | Intertravamento e indicação de trava no treino | Resumo da busca | — | Implementar indicador e intertravamento de trava (Dec. 5) |
| 5 | IMCA SF 13/24 (ROV caiu ao leito) | https://imca-int.com/safety-events/rov-dropped-to-seabed | Relato de incidente | V2: TMS não travou no LARS (graxa contaminada). O operador não via o indicador de trava antes de aliviar a tensão, e o umbilical rompeu. | Alta | Cenário de falha para treino | Resumo da busca | — | Cenário opcional "trava não confirmada" |
| 6 | Patentes US 6.276.625 e US 9.855.999 (TMS) | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6276625 | Patente | V2: TMS do tipo garagem × top hat; o top hat fica sobre o ROV e guarda o tether em carretel. O ROV é liberado e sai nadando; no retorno, é preso por pino de docking. A excursão é limitada pelo tether disponível. | Alta | Máquina de estados do top hat | Linguagem de patente, não procedimento | — | Confirma o modelo `topHat.ts` atual |
| 7 | Seadrift Offshore (top hat, trava dupla) | https://www.offshore-technology.com/?p=34827 | Catálogo de fornecedor | V2: top hat com sistema de trava dupla ("twin latching") para controle no lançamento e na recuperação | Média | Duas travas no modelo | Material comercial | — | Modelar 2 travas (Dec. 5) |
| 8 | Rigzone, Nautilus Live, ISE, Sapura, Bourbon | https://www.rigzone.com/insights/how-it-works-3/how-do-rovs-work-1148 · https://nautiluslive.org/career/rov-pilot · https://ise.bc.ca/product/control-systems-consoles/ · https://www.bourbonoffshore.com/sites/default/files/2021-08/uhd_ver02.pdf | Educacional / ficha técnica | V2: van de controle com consoles, matriz de vídeo, gravadores e navegação. Pilotos lado a lado; vídeo principal em monitores de 32" (ISE). Overlay com rumo (Sapura). Auto heading ±2° e auto depth ±15 cm (Bourbon UHD). | **Alta** | Layout da estação e HUD | Fichas de fornecedor, configurações variam | — | Layouts padrão (Dec. 1) |
| 9 | VideoRay Pro 4 – Turns Indicator | https://download.videoray.com/documentation/pro_4/html/instrument_turns.html | Manual de fabricante | V2: contagem de voltas consecutivas de 360°, seta de "desenrolar", reset com o ROV no rumo de referência e fundo vermelho após mais de 3 voltas. No mapa, horário = positivo. | **Alta** | Contador de voltas no HUD | ROV de inspeção, não work class | — | Contador de voltas com alerta (Dec. 2) |
| 10 | Fossen / RexROV (UUV Simulator) | https://github.com/uuvsimulator/uuv_simulator | Código + parâmetros | **V1:** LICENSE Apache-2.0; repositório arquivado em 06/02/2023. `rexrov.gazebo.xacro`: modelo `fossen`, massa adicional 6×6 cheia (diagonal 779,79 / 1222 / 3659,9 / 534,9 / 842,69 / 224,32), amortecimento linear −74,82 / −69,48 / −728,4 / −268,8 / −309,77 / −105 e quadrático −748,22 / −992,53 / −1821,01 / −672 / −774,44 / −523,27. Massa 1862,87 kg. Caixa de 2,6 × 1,5 × 1,6 m. | **Alta** | Ordens de grandeza já usadas em `rovParams.ts` | Valores de Berg (2012), modelo sem manutenção | Apache-2.0 | Manter Fossen diagonal (Dec. 8) |
| 11 | Stonefish | https://github.com/patrykcieslak/stonefish | Código (C++) + docs | **V1:** README declara GPL v3.0. Física sobre Bullet, hidrodinâmica pela geometria real dos corpos, absorção e espalhamento dependentes do comprimento de onda, OpenGL 4.3. `docs/sensors.rst` (V1): FLS com feixes em leque, ruído multiplicativo + aditivo (desvios ajustáveis), feixe vertical largo que projeta ecos de várias partes na mesma linha. Exemplo de configuração: 512 feixes, 500 bins, FOV 120° × 30°. V2: suporte a tethers (artigo ICRA 2025). | **Alta** | Modelo de ruído do FLS | GPL: não reutilizar código | **GPL-3.0** | Usar só como referência conceitual (Dec. 3) |
| 12 | sonar_simulation (Cerqueira) | https://github.com/romulogcerqueira/sonar_simulation | Código (Rock/OSG) + artigos | **V1:** pipeline GPU (`normal_depth_map`) que calcula intensidade de eco e distância na rasterização; suporta MSIS e FLS. **Nenhuma licença declarada na página** (V1). V2 (resumo do artigo, Graphical Models 2020): ruído speckle, perda de transmissão, reverberação e material dos objetos. | **Alta** | Normal + profundidade → intensidade × alcance | Sem licença = todos os direitos reservados | **Não declarada** | Ideia (normal/profundidade em GPU) apenas como conceito (Dec. 3) |
| 13 | HoloOcean (BYU) | https://byu-holoocean.github.io/holoocean-docs/ | Simulador (Unreal) + docs | V2: sonares imaging, profiling, sidescan e echosounder, com ruído realista no imaging. A 2.0 trouxe dinâmica Fossen e UE 5.3. Exemplo de sidescan: azimute 170°, 2000 bins, 0,5–40 m. Instruções ajustadas ao EULA da Unreal. **Licença não verificada** (repositório não encontrado na URL tentada; docs bloqueadas). | Média | Parâmetros de referência de sonar | Unreal, não web | **Não verificada** | Só referência de parâmetros |
| 14 | POSIM (IOES-Lab) | https://github.com/IOES-Lab/POSIM | Código (Gazebo/ROS 2) | **V1:** LICENSE Apache-2.0 para o código próprio. Partes do DAVE mantêm os avisos originais; o Wave Sim externo é GPL. Gazebo Sim Jetty + ROS 2. Efeitos de cena e neve marinha. Hidrodinâmica, tether e sonar não descritos na página. | Baixa | — | Pouca documentação técnica | Apache-2.0 (+ partes GPL) | Não usar |
| 15 | Buckham – tethers de baixa tensão (UVic) | https://dspace.library.uvic.ca/handle/1828/3644 | Tese | V2: massa concentrada é o método mais usado; elementos pequenos restringem o passo de tempo; geometria de ordem superior permite elementos 35–50% maiores | Alta | Justifica poucos segmentos + subpassos | Resumo | — | Tether XPBD com N fixo (Dec. 6) |
| 16 | Modelica / NTNU – cabo com Morison | https://ep.liu.se/ecp/174/007/ecp2020174007.pdf | Artigo | V2: cargas de fluido por Morison aplicadas como forças nos nós de massa concentrada; validado contra OrcaFlex | Alta | Arrasto por nó | Carga submarina genérica | — | Arrasto normal + tangencial por nó |
| 17 | XPBD (Macklin, Müller, Chentanez 2016) | https://matthias-research.github.io/pages/publications/XPBD.pdf | Artigo | V2: no PBD a rigidez depende do passo e do número de iterações; o XPBD introduz a complacência α (α = 0 → restrição rígida) | **Alta** | Rigidez axial física e independente do passo | Resumo | — | Migrar a restrição de distância para XPBD (Dec. 6) |
| 18 | Jerlov / Austin & Petzold / Kd(490) | https://repository.ias.ac.in/98963 · https://www.mdpi.com/2077-1312/8/8/558 | Artigos | V2: 5 tipos oceânicos (I, IA, IB, II, III) e 5 costeiros (1, 3, 5, 7, 9). Kd(490): IA 0,035–0,040; IB 0,042–0,065; II 0,07–0,1; III 0,115–0,14 m⁻¹; costeiro amostrado 0,15–0,35 m⁻¹. Profundidade de 1% de luz ≈ 88/68/58/34 m (IA/IB/II/III). Austin & Petzold (1986) é o recomendado para I–III. | **Alta** | Presets de água | Valores regionais (Golfo de Kutch) | — | Presets de turbidez (Dec. 9) |
| 19 | Água pura – Pope & Fry (1997) | https://omlc.org/spectra/water/abs/pope97.html | Dados espectrais | V2: mínimo de absorção 0,0044 ± 0,0006 m⁻¹ em 418 nm. Valores em 450/550/650 nm **não obtidos** (host bloqueado). | Média | Ordem espectral R ≫ G > B | Tabela não lida | — | Manter canal R mais atenuado |
| 20 | Jaffe / McGlamery – formação de imagem | https://tos.org/oceanography/assets/docs/1-2_jaffe.pdf | Artigo | V2: imagem = direto + espalhamento frontal + retroespalhamento. Com câmera e luzes separadas, imageia-se até ~2–3 comprimentos de atenuação antes do retroespalhamento dominar. Espalhamento frontal não desprezível em água turva (2025). | **Alta** | Termo de retroespalhamento e separação luz–câmera | Resumo | — | Retroespalhamento com luzes do ROV (Dec. 9) |
| 21 | Oculus M750d (Blueprint) | https://www.blueyerobotics.com/specsheet/BPS-OCU-M750D/pdf | Ficha técnica | V2: 130° × 20°, até 512 feixes, resolução angular 1°/0,6°, 750 kHz/1,2 MHz, até 120 m (revendedor), 500 m de profundidade | **Alta** | Preset de FLS | Fontes divergem em alcance e profundidade | — | Preset "130° / até 120 m" marcado como típico |
| 22 | Tritech Gemini 720is | https://www.manualslib.com/manual/1083557/Gemini-720is.html?page=10 | Manual | V2: FOV 120°, 720 kHz, até 30 Hz, resolução de alcance ~8 mm. Número de feixes e alcance **não confirmados**. | Média | Taxa de atualização | Dados incompletos | — | Ping de 10–30 Hz |
| 23 | MDN browser-compat-data 8.1.8 | https://www.npmjs.com/package/@mdn/browser-compat-data | Dados oficiais de compatibilidade | **V1** (ver §7): Window Management, BroadcastChannel, WebHID, Gamepad, fullscreen `screen` | **Alta** | Matriz de suporte | Não cobre detalhes de comportamento | CC0 (dados) | Detecção de recursos + fallback (Dec. 11–13) |
| 24 | web.dev – multiple screens; Chrome – fullscreen popups | https://web.dev/patterns/web-apps/multiple-screens · https://developer.chrome.com/blog/fullscreen-popups-origin-trial | Documentação de fornecedor | V2: detectar `getScreenDetails`, consultar a permissão `window-management` e usar `availLeft/availTop/availWidth/availHeight` da tela-alvo em `window.open`. Popup em tela cheia ficou em origin trial no Chrome 119–122 (status atual não verificado). Proposta W3C de N ativações = N telas (não confirmada como implementada). | **Alta** | Abrir monitores em telas físicas | Status de recursos novos incerto | — | Dec. 11 |
| 25 | W3C Gamepad – issues de visibilidade/foco | https://lists.w3.org/Archives/Public/public-webapps-github/2024Sep/0476.html | Discussão de especificação | V2: o Chromium exige página visível para despachar eventos; em algumas plataformas as APIs do SO exigem foco; o acesso fora de primeiro plano é intencional na especificação, mas os comportamentos divergem | **Alta** | Entrada centralizada na janela principal | Discussão, não norma | — | Dec. 13 |
| 26 | Docs internas (SPACEMOUSE.md) | `docs/SPACEMOUSE.md` | Documento do projeto | V1: VID/PID e formato dos relatórios já levantados com fontes (spacenavd, Blender, WICG) | Alta | — | — | — | Mantido; não repeti a pesquisa |

---

## 2. Sala de controle e estação do piloto

**VERIFICADO-V2 (Rigzone, Nautilus Live, ISE, Sapura, Bourbon):**
- A van de controle tem consoles de piloto e copiloto, matriz de vídeo, gravadores e uma suíte de navegação. Na Nautilus, os pilotos ficam lado a lado com monitores touch, joysticks e teclados. A ISE descreve uma bandeja de joystick, computador de controle, monitores de gráficos e vídeo e controles de manipulador, com vídeo principal em monitores de 32".
- O overlay de vídeo exibe pelo menos o rumo, e o operador controla o overlay (Sapura). Um sistema citado tem 3 monitores, switcher de vídeo matricial, profundímetro, sensor de rumo e auto-depth/auto-heading.
- Tolerâncias publicadas de um WROV (Bourbon UHD): auto heading ±2° e auto depth ±15 cm. Altitude hold também existe, sem tolerância vista.
- Contador de voltas (VideoRay, V2): conta voltas consecutivas de 360°, mostra a seta de "desenrolar", faz reset no rumo de referência, fica vermelho após mais de 3 voltas e usa horário = positivo.

**HIPÓTESE / APROXIMAÇÃO (prática comum, sem fonte confirmada aqui):**
- O overlay típico de câmera tem rumo, profundidade, altitude, pitch/roll, voltas, tether lançado (TMS), data/hora, KP/posição e nome do trabalho.
- A estação típica tem 3 a 5 telas: (a) câmera principal em tela cheia com overlay; (b) quad de câmeras (pan&tilt, auxiliares, câmera do TMS e da trava); (c) sonar; (d) navegação/survey (posição USBL, mapa); (e) telemetria e alarmes (HPU, pressões, temperaturas, isolação elétrica, estado do TMS).

## 3. Operação do TMS Top Hat

**VERIFICADO-V2 (patentes US 6.276.625 / 9.855.999, Seadrift, IMCA SF 11/11 e 13/24):**
- No top hat, o TMS fica sobre o ROV, preso por gancho ou trava. O tether fica em carretel ou cesto. Na separação, a trava abre e o ROV sai com a própria propulsão. Na recuperação, o ROV é trazido de volta (o tether é recolhido) e a trava fecha de novo (pino de docking). A excursão é limitada pelo tether disponível no TMS.
- Há fabricantes com trava dupla.
- Lições de incidentes: lançar sem as duas travas engatadas; indicador de trava fora da visão do operador; aliviar a tensão do umbilical sem confirmar a trava. As medidas citadas foram alarmes, marcas de posição, câmeras de trava e um intertravamento que bloqueia lançamento ou recuperação sem a trava engatada.

**Não verificado:** os dois documentos IMCA pedidos (host inacessível). Não há procedimento passo a passo de fabricante.

**HIPÓTESE / APROXIMAÇÃO (sequência operacional usada no simulador):**
`convés → checagem das travas → overboard pela zona de splash → descida travada → parada na profundidade de trabalho (TMS acima do fundo) → liberação → excursão com pay/haul do tether → retorno e alinhamento sob o TMS → captura (envelope de posição, alinhamento e velocidade) → travas fechadas e confirmadas → içamento → convés`. O `topHat.ts` atual já segue esse fluxo. Falta o intertravamento explícito das duas travas.

## 4. Dinâmica do tether/umbilical

**VERIFICADO-V2:**
- A massa concentrada (nós + molas + arrasto de Morison por nó) é o método padrão para tethers de ROV (Buckham, NTNU/Modelica, COBEM 2009). Elementos pequenos obrigam a passos pequenos (Buckham).
- No XPBD, a rigidez deixa de depender do passo e das iterações graças à complacência α. Com α = 0, a restrição é rígida.

**HIPÓTESE / APROXIMAÇÃO (para tempo real no navegador):**
- Usar de 24 a 64 nós para o tether TMS–ROV (algumas centenas de metros no máximo), com o comprimento de repouso dos segmentos acompanhando o comprimento lançado. É o que o `segmentTether.ts` já faz.
- Integrar com XPBD em subpassos (por exemplo, 4 a 8 subpassos dentro do passo de física de 1/120 s, 1 iteração cada). A complacência axial vem de α = 1/(EA/ℓ). Isso mantém o alongamento físico e estável ao variar o passo.
- Forças externas por nó, antes da projeção:
  - peso molhado `(ρ_cabo − ρ_água)·A·g·ℓ`;
  - arrasto normal `½ρ·Cd_n·D·ℓ·|uₙ|uₙ` com Cd_n ≈ 1,0–1,5;
  - arrasto tangencial `½ρ·Cd_t·πD·ℓ·|u_t|u_t` com Cd_t ≈ 0,01–0,03.
  
  Os coeficientes são ordens de grandeza usuais, não verificadas aqui.
- Força no ROV = reação da última restrição (λ/Δt²), limitada para robustez.
- Umbilical principal navio–TMS: manter o modelo quase estático já existente. Uma catenária com arrasto basta, porque o piloto não o vê de perto.

## 5. Hidrodinâmica do ROV e simuladores de referência

**VERIFICADO-V1 (`rexrov.gazebo.xacro`, UUV Simulator, Apache-2.0):** forma de Fossen com massa adicional 6×6 cheia, amortecimento linear e quadrático diagonais, massa de 1862,87 kg e caixa de 2,6 × 1,5 × 1,6 m. Os valores estão na tabela, item 10. O `docs/SIMULACAO.md` já registra que só a ordem de grandeza do RexROV foi usada, com massa adicional diagonal.

**VERIFICADO-V1 (Stonefish README):** a hidrodinâmica usa a geometria real dos corpos, uma alternativa aos modelos simbólicos. É cara demais para o navegador.

**HIPÓTESE:** para um treinador web, Fossen diagonal + Coriolis do corpo rígido + amortecimento linear + quadrático sobre a velocidade relativa à corrente é o equilíbrio certo. Os termos cruzados da massa adicional do RexROV (por exemplo, X–Z de −103, Y–K de 409) mudam pouco a sensação de pilotagem e complicam a integração.

## 6. Sonar imageador frontal (FLS)

**VERIFICADO-V1 (Stonefish `docs/sensors.rst`):** o FLS forma uma imagem de intensidade em coordenadas cilíndricas (feixe × alcance). O feixe vertical largo faz ecos de alturas diferentes caírem na mesma linha. O ruído é a combinação de um componente multiplicativo e um aditivo, com desvios padrão configuráveis. Exemplo de configuração: 512 feixes, 500 bins, 120° × 30°, 0,5–10 m.

**VERIFICADO-V1 (sonar_simulation):** a intensidade e a distância de cada pixel saem da rasterização em GPU (mapa de normal + profundidade) e são depois decodificadas em feixes e bins. V2 (artigo de 2020): o modelo inclui speckle, perda de transmissão, reverberação e propriedades de material. Uma crítica de 2021 (Frontiers) aponta que falta speckle coerente nessa abordagem.

**VERIFICADO-V2 (equipamentos, tratar como "típico"):**
- Oculus M750d: 130° × 20°, até 512 feixes, 1°/0,6°, até ~120 m.
- Gemini 720is: 120°, até 30 Hz.
- Exemplo de sidescan no HoloOcean: 170°, 2000 bins.

**HIPÓTESE / APROXIMAÇÃO (modelo recomendado):**
- Intensidade de retorno ∝ refletividade do material × f(ângulo de incidência θ). Usar f = cosᵏθ (Lambert para k = 1; k = 2 a 4 deixa o leito mais escuro em incidência rasante).
- Perda de alcance por espalhamento esférico + absorção. Em dB: `TL = 20·log10(R) + α·R` (ida e volta = 2·TL). Normalizar com TVG parcial (ganho variável com o tempo) controlado pelo usuário, como nos equipamentos.
- Sombra acústica: bins atrás do primeiro eco forte de cada feixe ficam em 0 (o `sonar.ts` atual já faz algo assim).
- Ruído: multiplicativo (speckle, tipo Rayleigh/gama por pixel) + aditivo gaussiano, no estilo Stonefish.
- Resolução: 96 a 256 feixes e 128 a 512 bins bastam para um treinador. 512 feixes é o teto típico de equipamento real.

## 7. Óptica subaquática para renderização

**VERIFICADO-V2:**
- Classes de Jerlov e Kd(490) por tipo (item 18). A água pura tem mínimo de absorção perto de 418 nm (0,0044 m⁻¹).
- O vermelho é muito mais absorvido: o Kd cai de 380 a 490 nm e sobe de 490 a 683 nm.
- Modelo Jaffe–McGlamery: direto + frontal + retroespalhamento. Com luzes separadas da câmera, o alcance útil fica em ~2–3 comprimentos de atenuação.

**Comparação com o código atual (V1, `src/render/optics.ts`):** Kd RGB = 0,36 / 0,058 / 0,036 m⁻¹. O valor azul fica na faixa IA (0,035–0,040). É coerente com águas oceânicas claras.

**HIPÓTESE / APROXIMAÇÃO (técnicas WebGL/Three.js):**
- Por fragmento: `cor = J·T + B∞·(1 − T)`, com `T = exp(−c_rgb·d)` (d = distância à câmera) e B∞ = cor da água na profundidade (decaindo com Kd·profundidade).
- Luzes artificiais: holofote com `I₀·cosⁿ·exp(−c·d_luz)/d_luz²`, e o caminho de volta atenuado por `exp(−c·d_cam)`.
- Retroespalhamento das luzes: partículas (neve marinha) iluminadas só dentro do cone, ou ray-march de baixa resolução no cone (8–16 amostras, meia resolução). Aumentar com turbidez e com luz próxima ao eixo da câmera.
- Espalhamento frontal: blur leve dependente de profundidade e turbidez, num pós-processamento barato.

## 8. Navegador: múltiplas janelas e entrada

**VERIFICADO-V1 (`@mdn/browser-compat-data` 8.1.8):**

| Recurso | Chrome | Edge | Firefox | Safari | Opera | Status |
|---|---|---|---|---|---|---|
| `window.getScreenDetails()` / `ScreenDetailed` / `screen.isExtended` / `screenschange` | 100 | 100 | não | não | 86 | experimental |
| Permissão `window-management` (Permissions API) | 111 | 111 | não | não | 97 | experimental |
| `Permissions-Policy: window-management` | 100 | 100 | não | não | 86 | experimental |
| `requestFullscreen({ screen })` | 100 | — | não | não | — | — |
| `BroadcastChannel` | 54 | 79 | 38 | 15.4 | 41 | padrão |
| WebHID (`navigator.hid`) | 89 (desktop; Android não) | 89 | não | não | 75 | experimental |
| Gamepad API / `getGamepads()` | 21 / 35 | 12 | 29 | 10.1 | 15 / 22 | padrão |
| `window.opener` | 1 | 12 | 1 | 1 | 3 | padrão |

A especificação de referência é `w3c.github.io/window-management`.

**VERIFICADO-V2 (web.dev, blog do Chrome, testes do Chromium):**
- Fluxo recomendado: detectar `'getScreenDetails' in window`, consultar `navigator.permissions.query({name:'window-management'})` e chamar `getScreenDetails()`, que dispara o pedido de permissão.
- Para abrir na tela X: `window.open(url, nome, 'popup,left=…,top=…,width=…,height=…')` com `availLeft/availTop/availWidth/availHeight` dessa tela. Sem a permissão, o popup não é movido para outra tela.
- Fallback sem a API: `window.screen`, que só conhece a tela atual.

**BroadcastChannel × `window.opener` (V2 MDN via busca + V1 código atual):**
- O BroadcastChannel entrega por nome, a todos os contextos da mesma origem e da mesma partição de armazenamento. Os dados passam por clone estruturado (custo de cópia, sem memória compartilhada), e o canal não depende de referência de janela nem é afetado por `noopener`.
- O `window.opener`, na mesma origem, dá acesso direto a objetos JS (zero cópia). O `src/monitor.ts` atual usa isso: a janela principal renderiza no canvas do monitor.

**Gamepad e foco (V2):** a especificação permite acesso em segundo plano, mas o Chromium só despacha eventos a páginas visíveis, e algumas APIs do SO exigem foco. O `requestAnimationFrame` pausa em abas ocultas. **HIPÓTESE:** janelas minimizadas ou totalmente ocluídas podem ser estranguladas (há implementação em Firefox; o comportamento do Chrome não foi confirmado).

## 9. Licenças dos repositórios consultados

| Repositório | Licença | Como foi verificado |
|---|---|---|
| patrykcieslak/stonefish | **GPL-3.0** | V1: seção License do README (o arquivo LICENSE não foi achado nos caminhos tentados) |
| uuvsimulator/uuv_simulator | **Apache-2.0** (arquivado em 06/02/2023) | V1: arquivo LICENSE bruto + página do GitHub |
| IOES-Lab/POSIM | **Apache-2.0** no código próprio; partes do DAVE com avisos originais; Wave Sim externo GPL | V1: LICENSE bruto + README |
| romulogcerqueira/sonar_simulation | **Nenhuma licença declarada** (todos os direitos reservados por padrão) | V1: página e README sem LICENSE |
| HoloOcean (byu-holoocean) | **Não verificada** | Repositório não encontrado na URL tentada; docs bloqueadas. V2: instalação ajustada ao EULA da Unreal |
| @mdn/browser-compat-data | CC0 (dados) | Pacote npm |

**Declaração:** nenhum código desses repositórios foi copiado para o simulador nem para este documento. Usei apenas conceitos de modelagem e valores numéricos publicados (parâmetros do RexROV, especificações de sonar), sempre citados. O código GPL (Stonefish) e o sem licença (sonar_simulation) **não** podem ser incorporados.

---

## 10. Decisões para o simulador

1. **Layouts padrão da estação (§2).** Preset "Piloto, 3 telas": câmera principal + overlay | quad de câmeras (pan&tilt, auxiliar, TMS/trava, ré) | sonar + navegação. Preset "1 tela": câmera principal com miniaturas de sonar e quad. Preset "Supervisor": telemetria, alarmes e estado do TMS. Os layouts devem ser configuráveis e persistidos por visualizador.
2. **Overlay de vídeo (§2).** Rumo, profundidade, altitude, pitch/roll, **voltas** (horário positivo, seta de desenrolar, alerta após mais de 3 voltas, botão de reset que avisa se |voltas| ≥ 1), tether lançado / restante no TMS, modo de pilotagem, data/hora. Overlay ligável e desligável por monitor.
3. **Sonar (§6).** Manter o FLS por geometria da cena, com intensidade = refletividade × cosᵏθ, perda `20log10R + αR` com TVG ajustável, sombra por feixe e ruído multiplicativo + aditivo à la Stonefish. Preset "típico" de 130° (nunca rotular como modelo de fabricante) e alcances de 10–120 m. Não reutilizar código GPL ou sem licença.
4. **Taxa de ping (§6).** Ping completo a 10–15 Hz (fatiado em quadros, como hoje). Qualidade alta com 256 feixes × 384 bins só se o orçamento de quadro permitir.
5. **Top Hat (§3).** Modelar **duas travas** com indicador visual, câmera de trava e **intertravamento**: içar ou baixar o TMS com o ROV não travado gera alarme e exige confirmação. Cenário de treino opcional "trava não confirmada" (inspirado nas IMCA SF 11/11 e 13/24, sem reproduzir texto).
6. **Tether TMS–ROV (§4).** Migrar as restrições de distância do `segmentTether.ts` de PBD para **XPBD**: complacência axial a partir de EA, 4–8 subpassos e 1 iteração. Manter N fixo de nós (24–64) com comprimento de repouso adaptativo e arrasto normal/tangencial de Morison por nó. Validar com teste de alongamento estático (força ≈ EA·ε independente do passo).
7. **Umbilical navio–TMS (§4).** Manter o modelo quase estático atual. Não vale o custo de outra cadeia dinâmica.
8. **Hidrodinâmica (§5).** Manter Fossen diagonal (massa adicional, amortecimento linear + quadrático na velocidade relativa) com ordens de grandeza do RexROV (Apache-2.0, só valores). Documentar que os termos cruzados de massa adicional foram omitidos de propósito.
9. **Óptica (§7).** Presets de água: "Oceânica clara" (≈ IA, Kd azul ~0,04), "Plataforma" (≈ II–III, ~0,1) e "Costeira turva" (Kd 0,15–0,35), com o canal vermelho sempre bem mais atenuado. Adicionar o retroespalhamento das luzes do ROV dentro do cone e permitir ajustar a separação luz–câmera, para mostrar o efeito descrito por Jaffe.
10. **Desempenho da óptica (§7).** Ray-march do cone de luz em meia resolução com até 16 amostras, com queda automática para partículas apenas quando o FPS cair.
11. **Janelas dos monitores (§8).** Usar a Window Management API **só como melhoria progressiva**. Com ela, oferecer "Distribuir monitores nas telas", que abre cada popup com `left/top/width/height` da tela-alvo após a permissão. Sem ela (Firefox/Safari, ou permissão negada), abrir popups normais para o usuário arrastar e lembrar o tamanho no `localStorage`. Um clique por janela; não depender de várias aberturas por ativação.
12. **Sincronização entre janelas (§8).** Manter o caminho atual via `window.opener` (mesma origem, zero cópia, a janela principal renderiza) como **primário**. Adicionar **BroadcastChannel** como canal de controle leve (heartbeat, troca de layout, "recarreguei", reconexão) e como fallback quando o `opener` for perdido (recarga da principal). Nunca enviar quadros pelo BroadcastChannel.
13. **Entrada centralizada (§8).** Ler Gamepad, WebHID (SpaceMouse) e teclado **somente na janela principal** e avisar no HUD quando ela perder visibilidade ou foco, porque o Chromium pode parar de entregar entrada e o rAF pausa. Recomendar ao usuário manter a janela principal visível (não minimizada).
14. **Compatibilidade declarada (§8).** Na tela inicial, detectar recursos e informar: "Multi-tela automática e SpaceMouse: Chrome/Edge/Opera desktop; Firefox/Safari: monitores manuais, só gamepad e teclado".
15. **Pendências de pesquisa.** Reabrir os dois documentos IMCA, MDN, docs do HoloOcean (licença e parâmetros do ImagingSonar), a tabela de Pope & Fry e o artigo de Cerqueira (arXiv 2001.03539) quando esses domínios forem liberados na rede da sessão.

# Referências — pesquisa v3.2 (subsea)

Pesquisa feita em **2026-11-06** pelo líder de pesquisa, na branch `release/v3.2-subsea`. Ela continua a pesquisa de 05/11/2026 registrada em [`docs/PESQUISA_TECNICA.md`](../PESQUISA_TECNICA.md). Os itens daquele documento são citados como **P#**, com o número da tabela §1 de lá, e não foram pesquisados de novo.

**Como a pesquisa foi feita.** Foram 35 operações web: 32 buscas e 3 tentativas de abrir páginas. As três aberturas falharam com `ENOTFOUND`, porque os hosts estão fora da rede permitida da sessão: `gamedeveloper.com`, `80.lv` e `f-e-t.com`. Por isso, **nenhuma página nova foi aberta**. Tudo o que está abaixo veio do trecho devolvido pela busca (equivale ao nível **V2** do documento anterior). Antes de citar qualquer número como especificação, confira na fonte.

**Níveis usados nos arquivos de tópico:**

- **[V2]:** trecho de busca.
- **[P]:** herdado da pesquisa anterior.
- **[CONHECIMENTO]:** conhecimento técnico geral, sem fonte aberta nesta sessão.
- **[APROX]:** escolha de modelagem do simulador.

**Declaração.** Nenhum código, modelo 3D ou textura de terceiros foi copiado. Todo conteúdo foi parafraseado. Os números de fabricantes servem só como faixa típica e **nunca** são atribuídos ao ROV fictício do simulador.

| # | Fonte | URL | Data de consulta | Tipo | Verificado | Licença | Usado em |
|---|---|---|---|---|---|---|---|
| R1 | Pesquisa técnica anterior (P1–P26) | `docs/PESQUISA_TECNICA.md` | 2026-11-06 | Documento interno | aberto (local) | — | todos |
| R2 | Game Developer: entrevista sobre a revisão gráfica H2.0 de Subnautica (M. McGuire) | https://gamedeveloper.com/design/how-i-subnautica-i-plunges-deeper-into-rendering-realistic-water | 2026-11-06 | Entrevista | trecho de busca (abertura falhou: ENOTFOUND) | — | underwater-rendering |
| R3 | Fórum Unknown Worlds: "Underwatery look" | https://forums.unknownworlds.com/discussion/comment/2187138 | 2026-11-06 | Fórum de desenvolvedor | trecho de busca | — | underwater-rendering |
| R4 | PC Games Hardware: análise técnica de Subnautica Below Zero | https://www.pcgameshardware.de/Subnautica-Spiel-55121/Specials/Below-Zero-Early-Access-Benchmarks-Technik-Test-1282822/ | 2026-11-06 | Análise técnica | trecho de busca | — | underwater-rendering |
| R5 | GDC Vault: "Creating the Art of ABZÛ" (M. Nava, 2017) | https://www.gdcvault.com/play/1024409/Creating-the-Art-of-ABZ | 2026-11-06 | Palestra GDC | trecho de busca (vídeo não assistido) | — | underwater-rendering |
| R6 | 80.lv: resumo da palestra GDC 2017 sobre ABZÛ | https://80.lv/articles/gdc-2017-creating-the-art-of-abzu | 2026-11-06 | Resumo de palestra | trecho de busca (abertura falhou: ENOTFOUND) | — | underwater-rendering |
| R7 | PCGamesN: entrevista com o time de ABZÛ | https://www.pcgamesn.com/abzu/abzu-journey-developer-interview | 2026-11-06 | Entrevista | trecho de busca | — | underwater-rendering |
| R8 | Wikipedia: Under the Waves | https://en.wikipedia.org/wiki/Under_the_Waves | 2026-11-06 | Enciclopédia | trecho de busca | — | underwater-rendering |
| R9 | TechRaptor: E-Line, cientistas e BBC em Beyond Blue | https://techraptor.net/gaming/features/beyond-blue-e-line-bbc-collaboration | 2026-11-06 | Matéria | trecho de busca | — | underwater-rendering |
| R10 | Catlike Coding: "Looking Through Water" | https://catlikecoding.com/unity/tutorials/flow/looking-through-water/ | 2026-11-06 | Tutorial | trecho de busca | Código do tutorial: não usado | underwater-rendering |
| R11 | Zaneveld & Pegau (2003), visibilidade × atenuação de feixe | https://misclab.umeoce.maine.edu/ftp/classes/OO2017/readings/Zaneveld_visibility_OX2003.pdf | 2026-11-06 | Artigo | trecho de busca | — | underwater-rendering |
| R12 | Sea-Bird: Water visibility | https://www.seabird.com/water-visibility | 2026-11-06 | Nota de fabricante | trecho de busca | — | underwater-rendering |
| R13 | Gould & Arnone (1997), c(660) em águas costeiras | https://acnpsearch.tweb-dev.unibo.it/singlejournalindex/9716505 | 2026-11-06 | Artigo (índice) | trecho de busca | — | underwater-rendering |
| R14 | Pope & Fry (1997), absorção da água pura (OMLC) | https://omlc.org/spectra/water/abs/pope97.html | 2026-11-06 | Dados | trecho de busca: só o mínimo (0,0044 m⁻¹ em 418 nm). Valores em 450/550/650 nm = [CONHECIMENTO] | — | underwater-rendering |
| R15 | Sun, Ramamoorthi, Narasimhan, Nayar (2005), espalhamento simples analítico | https://www.ri.cmu.edu/publications/a-practical-analytic-single-scattering-model-for-real-time-rendering | 2026-11-06 | Artigo SIGGRAPH | trecho de busca | — | underwater-rendering |
| R16 | Monzón et al. (2022), espalhamento múltiplo subaquático em tempo real | https://diglib.eg.org/handle/10.2312/stag20221264 | 2026-11-06 | Artigo | trecho de busca | — | underwater-rendering |
| R17 | Shaderpack "Abyss" (Minecraft) | https://www.modpackindex.com/shader/204091/abyss | 2026-11-06 | Mod | trecho de busca | **não verificada**: não usar | underwater-rendering |
| R18 | Saab Seaeye Leopard: datasheet | https://www.saabseaeye.com/uploads/leopard-datasheet-12.pdf | 2026-11-06 | Ficha técnica | trecho de busca | — | rov-equipment |
| R19 | Unique Group: Seaeye Leopard | https://www.uniquegroup.com/wp-content/uploads/2022/10/Seaeye_Leopard.pdf | 2026-11-06 | Ficha de distribuidor | trecho de busca | — | rov-equipment |
| R20 | TechnipFMC: datasheet Schilling UHD-III | https://www.technipfmc.com/media/5b4p2j2r/data-sheet-schilling-uhd-iii.pdf | 2026-11-06 | Ficha técnica | trecho de busca | — | rov-equipment |
| R21 | TechnipFMC: datasheet Titan 4 | https://www.technipfmc.com/media/hpkjrigr/titan-4-datasheet.pdf | 2026-11-06 | Ficha técnica | trecho de busca | — | rov-equipment |
| R22 | Bourbon: ficha do WROV UHD (= P8) | https://www.bourbonoffshore.com/sites/default/files/2021-08/uhd_ver02.pdf | 2026-11-06 | Ficha de operador | trecho de busca | — | rov-equipment, tether-and-tms |
| R23 | Bourbon: ficha do WROV HD | https://www.bourbonoffshore.com/sites/default/files/2021-08/hd_ver02.pdf | 2026-11-06 | Ficha de operador | trecho de busca | — | rov-equipment |
| R24 | Oceaneering: Millennium Plus | https://www.oceaneering.com/products/millennium-plus-rov/ | 2026-11-06 | Página de produto | trecho de busca | — | rov-equipment |
| R25 | Robotomated: ficha comparativa do Millennium Plus | https://robotomated.com/explore/underwater/oceaneering-millennium | 2026-11-06 | Agregador (terceiros) | trecho de busca | — | rov-equipment |
| R26 | FET: Work Class ROVs (XLX-C, XLX Evo II) | https://f-e-t.com/?p=2924 | 2026-11-06 | Página de produto | trecho de busca | — | rov-equipment |
| R27 | FET: Tether Management Systems | https://f-e-t.com/subsea/tether-management-systems/ | 2026-11-06 | Página de produto | trecho de busca (abertura falhou: ENOTFOUND) | — | tether-and-tms |
| R28 | World Pipelines: FET entrega ROVs com LARS Dynacon AHC | https://www.worldpipelines.com/business-news/08062022/fet-delivers-two-additional-work-class-rovs-to-oceanica/amp/ | 2026-11-06 | Notícia setorial | trecho de busca | — | rov-equipment |
| R29 | Inspenet: FET entrega ROV com manipulador de 7 funções | https://inspenet.com/en/news/forum-energy-delivery-rov-to-mexican-company/ | 2026-11-06 | Notícia setorial | trecho de busca | — | rov-equipment |
| R30 | Marine Technology News: luzes e câmeras Bowtech num Schilling HD | https://www.marinetechnologynews.com/news/bowtech-install-lights-cameras-477450 | 2026-11-06 | Notícia setorial | trecho de busca | — | rov-equipment |
| R31 | L3Harris/Calzoni: datasheet ROV Pegaso | https://www.l3harris.com/sites/default/files/2020-10/ims-maritime-datasheet-calzoni-ROV-Pegaso_0.pdf | 2026-11-06 | Ficha técnica | trecho de busca | — | rov-equipment |
| R32 | Geo-matching: ISE Hysub | https://geo-matching.com/products/ise-hysub-work-class-rovs | 2026-11-06 | Agregador | trecho de busca | — | rov-equipment |
| R33 | Imenco: Lizard Shark HD (pan/tilt/zoom com luzes) | https://imenco.no/product/lizard-shark-hd-pan-tilt-hd-zoom-camera-with-lights | 2026-11-06 | Página de produto | trecho de busca | — | rov-equipment |
| R34 | VideoRay: spec sheet do Defender 2.0.1 (2025) | https://videoray.com/wp-content/uploads/2025_SpecSheet_Defender-2.0.1.pdf | 2026-11-06 | Ficha técnica | trecho de busca | — | rov-equipment |
| R35 | Marine Technology News: "Understanding ROV LARS", parte 1 | https://www.marinetechnologynews.com/blogs/understanding-rov-launch-and-recovery-systems-e28093-part-1-700531 | 2026-11-06 | Blog técnico | trecho de busca | — | tether-and-tms, operator-experience |
| R36 | Marine Technology News: "Understanding ROV LARS", parte 2 | https://www.marinetechnologynews.com/blogs/understanding-rov-launch-and-recovery-systems-e28093-part-2-700532 | 2026-11-06 | Blog técnico | trecho de busca | — | tether-and-tms |
| R37 | Patente USPTO 12.365.430 (lançamento de veículos não tripulados) | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12365430 | 2026-11-06 | Patente | trecho de busca | — | tether-and-tms |
| R38 | Patente USPTO 10.093.402 (sistema para operações submarinas) | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10093402 | 2026-11-06 | Patente | trecho de busca | — | tether-and-tms |
| R39 | Patente US 4.686.927 (gestão de tether) | https://patents.google.com/patent/US4686927 | 2026-11-06 | Patente | trecho de busca | — | tether-and-tms |
| R40 | Linden Photonics: flutuabilidade de tether | https://www.lindenphotonics.com/?p=7497 · https://www.lindenphotonics.com/how-to-choose-the-right-rov-tether-buoyancy-for-your-underwater-mission | 2026-11-06 | Nota de fabricante | trecho de busca | — | tether-and-tms |
| R41 | Fórum Blue Robotics: tether positivo em mergulho profundo | https://discuss.bluerobotics.com/t/tether-buoyancy-very-positive-in-deep-dives/12981 | 2026-11-06 | Fórum (relato) | trecho de busca | — | tether-and-tms |
| R42 | MDPI JMSE 12(2):279: revisão sobre gestão de tether | https://mdpi.com/2077-1312/12/2/279 | 2026-11-06 | Artigo de revisão | trecho de busca | CC BY (MDPI, não verificada) | tether-and-tms |
| R43 | Offshore Technology: Seadrift Offshore (Top Hat, trava dupla; = P7) | https://www.offshore-technology.com/contractors/pipeline_inspec/seadrift-offshore/ | 2026-11-06 | Catálogo de fornecedor | trecho de busca | — | tether-and-tms |
| R44 | Patente USPTO 10.024.482 (bend stiffener) | https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10024482 | 2026-11-06 | Patente | trecho de busca | — | tether-and-tms |
| R45 | Lankhorst: bend restrictors sem parafusos | https://www.lm-offshore.com/files/4/5/9/5/LM%20Boltless%20Bend%20Restrictors.pdf | 2026-11-06 | Ficha de fabricante | trecho de busca | — | tether-and-tms |
| R46 | Wirecable.in: Nexans e a retensão/reterminação de tether | https://www.wirecable.in/?p=4696 | 2026-11-06 | Notícia setorial | trecho de busca | — | tether-and-tms |
| R47 | Tritech: altímetros PA200/PA500 | https://www.tritech.co.uk/products/pa200-pa500-altimeters · https://www.tritech.co.uk/files/Datasheets/Alt-MK2-DFP-0715-SOM-00001-Issue-02_Updated.pdf | 2026-11-06 | Ficha técnica | trecho de busca | — | sonar |
| R48 | Valeport: manual do VA500 | https://manuals.online/valeport/measuring-instrument/va500/user-manual/1xmej | 2026-11-06 | Manual | trecho de busca | — | sonar |
| R49 | F. Strugar: CDLOD (artigo + código, 2010) | https://github.com/fstrugar/CDLOD | 2026-11-06 | Artigo + código | trecho de busca | código: **não verificada**, não usar | seabed-generation |
| R50 | Tese (ZČU), quadtree restrita e LOD de terreno | https://dspace5old.zcu.cz/bitstream/11025/912/1/Sumengen.pdf | 2026-11-06 | Tese | trecho de busca | — | seabed-generation |
| R51 | Bridson (2007), Poisson-disc rápido | https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf | 2026-11-06 | Artigo (sketch SIGGRAPH) | trecho de busca | — | seabed-generation |
| R52 | Smithsonian: formas de leito em Vineyard Sound | https://repository.si.edu/server/api/core/bitstreams/6fcdd87f-dbdd-4f78-babf-168421f017c9/content | 2026-11-06 | Artigo | trecho de busca | — | seabed-generation |
| R53 | web3dsurvey: EXT_disjoint_timer_query_webgl2 | https://web3dsurvey.com/webgl2/extensions/EXT_disjoint_timer_query_webgl2 | 2026-11-06 | Estatística de suporte | trecho de busca | — | performance |
| R54 | Mozilla Bugzilla 1255805 | https://bugzilla.mozilla.org/show_bug.cgi?id=1255805 | 2026-11-06 | Bug tracker | trecho de busca | — | performance |
| R55 | Fórum three.js: InstancedMesh × BatchedMesh | https://discourse.threejs.org/t/how-to-choose-between-instancedmesh-and-batchedmesh/81221 | 2026-11-06 | Fórum | trecho de busca | — | performance, seabed-generation |
| R56 | npm `@three.ez/instanced-mesh` (InstancedMesh2) | https://www.npmjs.com/package/@three.ez/instanced-mesh | 2026-11-06 | Biblioteca | trecho de busca | **não verificada** | performance |
| R57 | Manual do three.js: Multiple Canvases, Multiple Scenes | https://threejs.org/manual/en/multiple-scenes.html | 2026-11-06 | Documentação oficial | trecho de busca | — | performance |
| R58 | Fórum three.js: "How many renderers is too many?" | https://discourse.threejs.org/t/how-many-renderers-is-too-many/58774 | 2026-11-06 | Fórum | trecho de busca | — | performance |
| R59 | Fórum three.js: viewport/scissor ignorados no WebGPU RenderPipeline | https://discourse.threejs.org/t/renderpipeline-does-not-support-split-screen-multiple-viewports-with-webgpu-backend/92444 | 2026-11-06 | Fórum | trecho de busca | — | performance |
| R60 | Chromium: "Using Chromium with SwiftShader" | https://chromium.googlesource.com/chromium/src/+/da170c2267b2201954efe1c8fa5d2d89ab09f7bf/docs/gpu/swiftshader.md | 2026-11-06 | Documentação oficial | trecho de busca | — | performance |
| R61 | blink-dev: Intent to Remove SwiftShader Fallback | https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM | 2026-11-06 | Lista de desenvolvimento | trecho de busca | — | performance |
| R62 | MDPI JMSE 13(6):1183: CFD de ROV perto de parede | https://www.mdpi.com/2077-1312/13/6/1183 | 2026-11-06 | Artigo | trecho de busca | CC BY (MDPI, não verificada) | rov-physics |
| R63 | EGU2020-7710: pluma de teste de veículo de mineração | https://presentations.copernicus.org/EGU2020/EGU2020-7710_presentation.pdf | 2026-11-06 | Apresentação científica | trecho de busca | — | rov-physics |
| R64 | Hexagon CAESAR II: perfis de corrente | https://docs.hexagonppm.com/r/en-US/CAESAR-II-Users-Guide/Version-12/336360 | 2026-11-06 | Manual de software | trecho de busca | — | rov-physics |
| R65 | DNV Bladed: SubSurfaceCurrent (expoente ~1/7) | https://bladednextgen.dnv.com/schemaDoc/0.4.1/TimeDomainSimulation/Environment/SeaState/Current/SubSurfaceCurrent/SubSurfaceCurrent.html | 2026-11-06 | Documentação de software | trecho de busca | — | rov-physics |
| R66 | Lewis et al. (2017): perfil de velocidade em sítios de maré | https://tethys-engineering.pnnl.gov/publications/characteristics-velocity-profile-tidal-stream-energy-sites | 2026-11-06 | Artigo (índice) | trecho de busca | — | rov-physics |
| R67 | Alderney Race: medições de velocidade em trânsito | https://tethys-engineering.pnnl.gov/publications/underway-velocity-measurements-alderney-race-towards-three-dimensional-representation | 2026-11-06 | Artigo (índice) | trecho de busca | — | rov-physics |
| R68 | Wikipedia: Iron Lung (jogo) | https://en.wikipedia.org/wiki/Iron_Lung_(video_game) | 2026-11-06 | Enciclopédia | trecho de busca | — | operator-experience |
| R69 | PC Gamer: lançamento completo de Barotrauma | https://www.pcgamer.com/barotrauma-the-sci-fi-submarine-sim-inspired-by-dwarf-fortress-and-fever-dreams-gets-a-full-release | 2026-11-06 | Matéria | trecho de busca | código-fonte disponível, **licença não verificada** | operator-experience |
| R70 | VideoRay: referência rápida do controlador Workhorse (checagens pré-mergulho) | https://videoray.com/wp-content/uploads/2023/10/workhorse_splashproof_controller_quick_reference.pdf | 2026-11-06 | Manual | trecho de busca | — | operator-experience |
| R71 | ROV Field Manual: procedimentos de campo | https://rov-field-manual.github.io/field-procedures | 2026-11-06 | Guia comunitário | trecho de busca (github.io bloqueado antes) | não verificada | operator-experience |
| R72 | WHOI: operações do Alvin (coordenador de lançamento, checklists) | https://www.whoi.edu/marine/PDF/ATL%2007.9%20ALVIN%20Operations.pdf | 2026-11-06 | Procedimento institucional | trecho de busca | — | operator-experience |
| P3–P5 | IMCA R 004 e Safety Flashes 11/11 e 13/24 | ver R1 §1 | 2026-11-05 | Guia setorial / incidente | herdado (V2) | — | tether-and-tms, operator-experience |
| P6 | Patentes de TMS (US 6.276.625 / 9.855.999) | ver R1 §1 | 2026-11-05 | Patente | herdado (V2) | — | tether-and-tms |
| P8–P9 | Sala de controle (Rigzone, ISE, Sapura, Bourbon); contador de voltas VideoRay | ver R1 §1 | 2026-11-05 | Fichas / manual | herdado (V2) | — | operator-experience |
| P10 | RexROV / UUV Simulator | ver R1 §1 | 2026-11-05 | Código + parâmetros | herdado (V1) | Apache-2.0 | rov-physics |
| P11–P12 | Stonefish; sonar_simulation | ver R1 §1 | 2026-11-05 | Código | herdado (V1) | GPL-3.0; não declarada | sonar |
| P15–P17 | Buckham; Modelica/NTNU; XPBD | ver R1 §1 | 2026-11-05 | Tese / artigos | herdado (V2) | — | tether-and-tms |
| P18–P20 | Jerlov / Kd(490); Pope & Fry; Jaffe–McGlamery | ver R1 §1 | 2026-11-05 | Artigos / dados | herdado (V2) | — | underwater-rendering |
| P21–P22 | Oculus M750d; Gemini 720is | ver R1 §1 | 2026-11-05 | Fichas | herdado (V2) | — | sonar |

**Pendências.** Abrir R2, R6, R27 e o vídeo R5 quando `gamedeveloper.com`, `80.lv`, `f-e-t.com` e `youtube.com` forem liberados na rede da sessão. Conferir a tabela de Pope & Fry (R14) e as fichas Tritech/Valeport (R47, R48) antes de citar números como especificação.

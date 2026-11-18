# Experiência do operador: jogos, sala de controle, lançamento e HUD

Data: 2026-11-06. As referências estão em [references.md](references.md).

**Já decidido em R1:**
- Layouts da estação (Dec. 1).
- Overlay com contador de voltas (Dec. 2).
- Intertravamento das travas (Dec. 5).
- Entrada centralizada (Dec. 13).

Aqui entram as lições de jogos, o **guia de lançamento não bloqueante** e as convenções de HUD.

---

## 1. Jogos

### F1 — Barotrauma: sistemas interligados e falhas
- **Fonte/URL:** R69 https://www.pcgamer.com/barotrauma-the-sci-fi-submarine-sim-inspired-by-dwarf-fortress-and-fever-dreams-gets-a-full-release. Consulta em 2026-11-06, nível [V2].
- **Informação:** sim cooperativo em que a tripulação pilota, conserta vazamentos e **opera maquinário**. O código-fonte está disponível (licença **não verificada**; não usar).
- **Aplicabilidade** [CONHECIMENTO de jogo]: o valor está na **interdependência visível** (energia → bombas → lastro → navegação) e em falhas que se propagam e se diagnosticam por instrumentos. O que é fantasia: monstros e o tom de caos cômico.
- **Decisão técnica:**
  - Uma falha simulada deve ter **causa, sintoma em instrumento e ação corretiva**. Exemplo: queda de isolação elétrica → alarme de fuga à terra → isolar o circuito de luzes.
  - A cadeia é mostrada no painel do supervisor. Nada de falha "mágica" sem indicação.

### F2 — Iron Lung: pilotar só por instrumentos
- **Fonte/URL:** R68 https://en.wikipedia.org/wiki/Iron_Lung_(video_game). Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - O jogador navega um submarino **sem janela**, por coordenadas num mapa, e fotografa pontos com uma câmera.
  - A tensão vem da **restrição de informação**.
- **Aplicabilidade:** é o mesmo regime de um piloto de ROV em água turva (preset Turva): confiar em sonar, altímetro, rumo e posição USBL em vez do vídeo. O horror é fantasia, mas a **disciplina de instrumentos** é real.
- **Decisão técnica:** cenário de treino "visibilidade zero" (preset Turva + pluma) com tarefa de navegação até uma estrutura usando só sonar, altímetro e posição. Pontuação por desvio e por contato.

### F3 — Aquanox e Dave the Diver
- **Fonte:** **não pesquisados** nesta sessão (orçamento de buscas). [CONHECIMENTO geral]
- **Aplicabilidade:** baixa. Aquanox é ação arcade de submarino. Dave the Diver é gestão e coleta com pixel art. O único ponto aproveitável é a clareza de UI de recursos, como oxigênio e carga, em ícones simples.
- **Decisão técnica:** nenhuma dependência. Não citar como referência de realismo.

---

## 2. Sala de controle real (reuso + complemento)

### F4 — Coordenação e checklists
- **Fontes/URL:** R72 https://www.whoi.edu/marine/PDF/ATL%2007.9%20ALVIN%20Operations.pdf ; R70 ; R71 ; P8. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - No Alvin (análogo tripulado), um **coordenador de lançamento** único controla navio e veículo durante lançamento e recuperação. O lançamento só ocorre após checklists **assinados** pelas funções-chave (R72).
  - VideoRay: na pré-imersão, conferir se cada propulsor responde ao comando e se a câmera faz o tilt completo (R70).
  - Guia de campo: o work-class segue o protocolo do próprio operador. Testar o transceptor USBL na água antes do lançamento (R71).
  - A zona de splash é a fase de maior risco (R35).
- **Decisão técnica:** o simulador oferece o guia do §3 como **lista de verificação não bloqueante**, com papéis (piloto, copiloto/navegação, operador de LARS, supervisor) que podem ser todos o mesmo usuário.

---

## 3. Guia operacional de lançamento e recuperação (NÃO bloqueante)

**Princípio.** O guia é um painel lateral com passos marcáveis. Ele **nunca impede** o usuário de agir. Pular um passo gera um registro e, quando houver risco físico simulado, um **alarme**. A única exceção já decidida em R1 Dec. 5 é a confirmação extra das travas. O conteúdo é parafraseado de práticas gerais [V2/APROX] e não é procedimento de nenhuma empresa.

| # | Etapa | Itens de verificação (exemplos) | O que o simulador observa |
|---|---|---|---|
| 1 | **Preparação** | briefing da tarefa; condições (mar, corrente, visibilidade); papéis definidos; zona de convés liberada | cenário e condições carregados; registro de hora |
| 2 | **Configuração da estação** | layout de monitores; overlay ligado; gravação de vídeo; sonar no alcance inicial | layout ativo; janelas abertas (BroadcastChannel) |
| 3 | **Verificação de instrumentos** | profundímetro e altímetro coerentes no convés; bússola/rumo; isolação elétrica OK; propulsores respondem (teste em baixa potência); pan/tilt em curso completo; luzes por grupo; USBL na água respondendo | teste de cada eixo de entrada; leituras dentro da faixa; falhas injetadas aparecem aqui |
| 4 | **Preparação do lançamento** | **duas travas engatadas e confirmadas** (indicador + câmera); tether do tambor em tensão; AHC/LARS pronto; comunicação com o passadiço | estado das travas; tensão do tether; alarme se tentar içar destravado (R1 Dec. 5) |
| 5 | **Descida do conjunto** | passagem pela zona de splash sem parar; descida em velocidade controlada; monitorar a tensão do umbilical e o heave; paradas de checagem (por exemplo, a 20 m) | velocidade do guincho; picos de tensão; profundidade do TMS |
| 6 | **Posicionamento** | TMS na profundidade planejada (ver tether-and-tms.md F3); posição horizontal afastada das estruturas; verificar corrente e raio útil | alerta se o TMS ficar abaixo do limite ou perto de estrutura; raio útil exibido |
| 7 | **Liberação do ROV** | ROV com propulsão ativa e auto-heading/depth prontos; abrir as travas; afastar sem tensionar o tether; pay-out inicial | estado `released`; tensão no momento da saída; contador de voltas zerado |
| 8 | **Início da operação** | registro de "on bottom"; altímetro válido; sonar no alcance de trabalho; gestão de folga do tether | tempo até a primeira tarefa; eventos de folga e contato |
| ↩ | **Recuperação** (inverso) | voltar e desenrolar as voltas; alinhar sob o TMS; capturar; **travas confirmadas**; içar; splash; convés | envelope de captura atual (`topHat.ts`); intertravamento |

**Decisão técnica:**
- Painel "Guia de operação" com as 8 etapas mais a recuperação, todas com estado (pendente/feito/pulado) e marcação de hora.
- Exportar como log de treino em JSON.
- Os itens são editáveis em `config`, para instrutores adaptarem ao procedimento da própria empresa.

---

## 4. Convenções de HUD/overlay

### F5 — Conteúdo e disposição
- **Fonte:** P8 (Sapura: overlay com rumo e controlado pelo operador), P9 (VideoRay: voltas), R1 §2 [V2/APROX].
- **Decisão técnica (convenção do simulador):**
  - **Faixa superior:** rumo (fita de bússola), com as voltas à direita.
  - **Lateral esquerda:** profundidade.
  - **Lateral direita:** altitude do altímetro, com "---" se inválida.
  - **Centro:** horizonte artificial discreto (pitch/roll) só na câmera principal.
  - **Faixa inferior:** tether lançado/restante, modo (manual / auto-heading / auto-depth / auto-altitude), data/hora UTC e nome do trabalho.
  - **Canto:** alarmes com cor por severidade (âmbar = aviso, vermelho = crítico) e texto curto. Piscar só no crítico.
  - Fonte monoespaçada, branca com contorno escuro (legível sobre água clara e escura). Unidades sempre visíveis.
  - Overlay ligável por monitor (R1 Dec. 2). O overlay da câmera do TMS mostra o **estado das travas**.

---

## Decisões para a v3.2

1. **Guia de lançamento e recuperação não bloqueante**, em 8 etapas mais a recuperação: preparação, configuração da estação, verificação de instrumentos, preparação do lançamento, descida do conjunto, posicionamento, liberação do ROV e início da operação. Cada etapa tem estado e hora, e o resultado é exportado como log.
2. A **única barreira** continua sendo a confirmação das travas (R1 Dec. 5). Todo o resto gera alarme ou registro.
3. **Falhas com causa → sintoma → ação** visíveis no painel do supervisor (lição de Barotrauma).
4. Cenário de treino **"visibilidade zero"**: só instrumentos (lição de Iron Lung).
5. Convenção fixa de HUD: rumo no topo, profundidade à esquerda, altímetro à direita, tether/modo/hora embaixo e alarmes no canto. Estado das travas no overlay da câmera do TMS.
6. Itens do guia **editáveis por instrutor**, sem procedimento de empresa embutido.

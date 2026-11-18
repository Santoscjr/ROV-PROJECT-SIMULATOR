# Física do ROV: complemento

Data: 2026-11-06. As referências estão em [references.md](references.md).

**O que já está decidido (R1 §5, Dec. 8, sem mudança):**
- Fossen diagonal com massa adicional, Coriolis de corpo rígido e amortecimento linear + quadrático sobre a velocidade relativa à corrente.
- Ordens de grandeza do RexROV (P10, Apache-2.0, só valores).
- Os termos cruzados de massa adicional foram omitidos de propósito.
- Ver também `docs/SIMULACAO.md`.

---

### F1 — Efeito de parede / solo
- **Fonte/URL:** R62 https://www.mdpi.com/2077-1312/13/6/1183. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Num ROV de forma complexa, a resistência total **aumenta** com a proximidade da parede, e mais em velocidades altas.
  - A parcela que domina é a de **pressão**. A viscosa quase não muda.
  - Em estudos de submarinos perto do fundo, a proximidade muda pouco o arrasto, mas gera **sustentação negativa**, que é sucção para o fundo.
  - Não foi achada quantificação de massa adicional × altura.
- **Aplicabilidade:** nas velocidades de ROV (≤ 1,5 m/s, e < 0,5 m/s perto do fundo), o efeito é pequeno em relação ao amortecimento e ao empuxo.
- **Limitações:** CFD de geometrias específicas. Não há coeficientes transferíveis.
- **Decisão técnica:** [APROX] só se a altitude for menor que 1 altura do casco:
  - arrasto horizontal multiplicado por `1 + 0,15·(1 − h/H)`;
  - força vertical para baixo ∝ `0,05·½ρ·A·u²`.

  O efeito é **opcional** e vem desligado por padrão. Não mexer na massa adicional.

### F2 — Jato dos propulsores (thruster wash) e pluma
- **Fonte/URL:** R63 https://presentations.copernicus.org/EGU2020/EGU2020-7710_presentation.pdf. Consulta em 2026-11-06, nível [V2]. Teste de veículo de mineração, um análogo e não um ROV.
- **Informação:**
  - Perto da fonte (< 100 m), a pluma ficou a **≤ 2 m do fundo** e subiu com a distância.
  - A turbidez **caiu rápido** com a distância.
  - As correntes junto ao fundo eram de ~5–10 cm/s, sobre lama fina.
- **Aplicabilidade:** para o piloto, o efeito que importa perto do fundo é **visual**. O jato vertical para baixo, ou o horizontal rente ao fundo, levanta sedimento e "apaga" a câmera. Esse é um erro clássico de pilotagem [CONHECIMENTO].
- **Decisão técnica:** no `sediment.ts`, a emissão é proporcional a `|empuxo vertical para baixo| · f(altitude)`, com f = 1 a < 1 m e 0 a > 3 m, e a `máscara de lama` (seabed-generation F4). A pluma é:
  - advectada pela corrente local;
  - subida até ~2 m;
  - decaída em 30–120 s conforme o sedimento.

  A pluma soma c_extra ao preset de água (underwater-rendering §3, linha "pluma local").

### F3 — Perfil de corrente
- **Fontes/URL:** R64 (CAESAR II) ; R65 (DNV Bladed) ; R66 ; R67. Consulta em 2026-11-06, nível [V2].
- **Informação:**
  - Softwares de engenharia usam lei de potência `u(z) = u_ref·(z/z_ref)^{1/7}` (R64). O expoente "tipicamente ~1/7" aparece no DNV Bladed (R65).
  - Em campo, 1/7 descreve bem o perfil médio (R66), mas o expoente varia de ~1/6 a 1/14 com a maré e a rugosidade (R67).
  - O DNV-RP-C205 **não** foi lido.
- **Aplicabilidade:** o `ocean.ts` usa decaimento exponencial com a profundidade, rampa linear nos 8 m finais e rotação da direção com a profundidade. É razoável, mas a camada limite linear subestima a corrente a 1–3 m do fundo.
- **Decisão técnica:**
  - Na camada limite (altitude < 10 m), trocar a rampa linear por `u = u₁₀·(h/10)^{1/7}`, com piso em 0,05 m (h = 1 m → 72% de u₁₀; h = 0,1 m → 52%).
  - Manter o restante do perfil.
  - Expor o expoente (1/6–1/10) como parâmetro avançado do cenário.

### F4 — Tether como carga no ROV
- **Fonte:** R1 §4 / Dec. 6 (XPBD + Morison por nó). Ver tether-and-tms.md.
- **Decisão técnica:** sem mudança. A reação do tether entra como força externa no corpo, limitada para robustez.

---

## Decisões para a v3.2

1. Manter **Fossen diagonal** (R1 Dec. 8). Nenhum termo novo obrigatório.
2. **Efeito de solo opcional e desligado por padrão:** +≤ 15% de arrasto horizontal e uma pequena sucção abaixo de 1 altura do casco. Sem mudar a massa adicional.
3. **Pluma de jato dos propulsores** acoplada a empuxo, altitude e máscara de lama, até ~2 m de altura, advectada pela corrente e alimentando c_extra na óptica.
4. **Camada limite 1/7** nos 10 m inferiores no lugar da rampa linear. O expoente é configurável.

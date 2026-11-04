# SpaceMouse (3Dconnexion) — integração opcional

O simulador pode ler um mouse 3D 3Dconnexion (foco: **SpaceMouse Pro**) direto pelo navegador via **WebHID**.
É opcional: sem o dispositivo, teclado e gamepad continuam funcionando.
Página de diagnóstico: `spacemouse.html` (link "Voltar ao simulador" no topo).

## Como funciona

1. O usuário clica em **Conectar SpaceMouse…**. O navegador abre o seletor de dispositivos HID (é obrigatório um gesto do usuário).
2. O dispositivo é aberto e envia *input reports*:
   - `0x01`: translação X, Y, Z (3 × int16 LE, 6 bytes) **ou**, em modelos mais novos (VID 0x256f), os 6 eixos em 12 bytes;
   - `0x02`: rotação RX, RY, RZ (3 × int16 LE), só nos modelos antigos (VID 0x046d);
   - `0x03`: botões, bitmask little-endian (bit n = botão n+1, 1 = pressionado).
3. `hidParser.ts` decodifica; `SpaceMouseDevice` aplica offset de calibração → normalização (±350) → zona morta → curva → ganho → inversão, e entrega `AxisCommand` ao `InputManager`.
4. Na próxima visita, `reconnectGranted()` reabre sem prompt o dispositivo já autorizado (`navigator.hid.getDevices()`).
5. Configuração em `localStorage["rov.spacemouse.v1"]`.

Mapeamento padrão: empurrar para frente → avanço (surge) · para a direita → lateral (sway) · puxar para cima → vertical (heave) ·
girar horário → guinada (yaw) · inclinar para trás → tilt da câmera para cima · inclinação lateral → nenhum (roll desligado).
Botões: bit 0 (esquerdo / Menu) → alternar câmera; bit 1 (direito / Fit) → alternar luzes; Pro: T/R luzes +/−, F centraliza câmera,
1/2/3 modos Manual/Estabilizar/Profundidade, 4 ciclo de modos, Esc pausa, Shift controle fino. Tudo editável na página de diagnóstico.

## Requisitos do navegador

- **Chrome, Edge ou Opera para desktop**, versão 89+ (Windows, macOS, Linux, ChromeOS). Firefox e Safari **não** têm WebHID; Chrome Android também não.
- Contexto seguro: HTTPS (GitHub Pages serve) ou `localhost`.
- Dentro de `<iframe>` é preciso `allow="hid"` (Permissions Policy).

## Driver (3DxWare / 3DxService)

- **macOS:** o driver 3DxWare toma o dispositivo de forma exclusiva; com ele rodando, o WebHID abre o dispositivo mas não recebe dados (confirmado por moderador da 3Dconnexion). Encerre o 3DxWare (ou desinstale) para usar aqui.
- **Windows:** relatos da comunidade dizem que funciona melhor com o 3DxService parado. *Não verificado* se ele bloqueia sempre.
- **Linux:** sem 3DxWare. Se o `spacenavd` estiver rodando, pode segurar o dispositivo; pare-o. É preciso permissão de leitura no `/dev/hidraw*` (regra udev, ex.: `KERNEL=="hidraw*", ATTRS{idVendor}=="256f", MODE="0660", TAG+="uaccess"`; para o Pro com fio use `046d`).
- Sintoma típico de driver segurando: estado "conectado", taxa **0 Hz** e aviso "nenhum relatório chegou".

## Testes que o USUÁRIO precisa fazer (não temos hardware)

Abra `spacemouse.html` no Chrome desktop e anote os resultados:

1. **Conexão:** clique em *Conectar*, escolha o SpaceMouse. Anote nome, VID:PID e layout mostrados.
2. **Fluxo de dados:** mova a tampa. A taxa (Hz) deve subir e o hex dump mudar. Anote o ID e o tamanho (`id 0x01 · 6 B` ou `12 B`; aparece `0x02`?).
3. **Sinais dos eixos brutos** (o mais importante; registre o sinal de cada um):
   - empurrar para a **direita** → TX = ? (esperado +)
   - empurrar para **frente** (longe de você) → TY = ? (esperado −)
   - **puxar para cima** → TZ = ? (esperado −) ; apertar para baixo → TZ = ? (esperado +)
   - inclinar o topo para **trás** (para você) → RX = ? (esperado +)
   - inclinar o topo para a **direita** → RY = ? (esperado −)
   - girar no sentido **horário** visto de cima → RZ = ? (esperado +)
   Se algum sinal divergir, marque *Inverter* no eixo, salve e nos informe.
4. **Faixa:** com deflexão máxima, os valores ficam perto de ±350? (fontes citam ±350 típico e −512..511 de faixa lógica). Ajuste *Fundo de escala* se necessário.
5. **Repouso/calibração:** solte a tampa. Os valores voltam a 0? Se sobrar deriva, clique *Calibrar zero* e confira se "Comandos do piloto" fica em 0.
6. **Botões:** pressione cada botão; o indicador com o nome correto deve acender (Menu, Fit, T, R, F, Rot, 1–4, Esc, Alt, Shift, Ctrl, Lock). Anote qualquer botão que acenda com nome errado ou não acenda (o hex de `0x03` ajuda).
7. **Reconexão:** recarregue a página: deve reconectar sozinho. Desconecte o cabo/receptor e reconecte: o estado deve mudar e voltar.
8. **Gamepad API:** com o driver ativo e sem conectar via WebHID, pressione um botão e veja se aparece algo na seção *Gamepad API* (anote id e número de eixos).
9. **No simulador:** pilote e confirme que frente/direita/subir/girar horário movem o ROV no sentido esperado.

## Solução de problemas

| Sintoma | Causa provável / ação |
|---|---|
| "WebHID indisponível" | Navegador sem suporte (Firefox/Safari) ou página fora de HTTPS. Use Chrome/Edge desktop. |
| Seletor vazio | Dispositivo não conectado, filtro não reconhece o PID, ou (Linux) sem permissão no hidraw. |
| Conecta mas 0 Hz | Driver 3DxWare/3DxService/spacenavd segurando o dispositivo. Encerre e reconecte. |
| Erro `NotAllowedError` / "Failed to open" | Dispositivo em uso exclusivo por outro programa ou permissão negada. |
| Eixo anda sozinho | Calibre o zero com a tampa solta; aumente a zona morta. |
| Direção trocada | Marque *Inverter* no eixo correspondente e salve. |
| Receptor sem fio não aparece | Receptor universal usa PID 0xc652 (às vezes 0xc658 no Windows). Se o PID for outro, informe o VID:PID mostrado. |

## Verificado × não verificado

**Verificado em fontes (ver lista abaixo):**
- IDs USB: SpaceMouse Pro com fio `046d:c62b`; Pro Wireless `256f:c631` (cabo) / `c632` (receptor) / `c638` (BT via cabo); receptor universal `256f:c652` (Blender o trata como Pro Wireless).
- Formato dos reports `0x01`/`0x02`/`0x03`, int16 LE, 12 bytes combinados nos dispositivos 0x256f.
- Bits dos botões do Pro (0 Menu, 1 Fit, 2 T, 4 R, 5 F, 8 Rot, 12–15 = 1–4, 22 Esc, 23 Alt, 24 Shift, 25 Ctrl, 26 Lock): spacenavd e Blender concordam.
- WebHID: `SecureContext`, `requestDevice` exige ativação do usuário, `data` não inclui o byte de report ID; Chrome/Edge 89+, sem Firefox/Safari/Chrome Android.
- Chromium no Windows registra o uso HID 0x08 (multi-axis controller) para a Gamepad API.
- 3DxWare no macOS bloqueia o acesso HID.

**Não verificado (depende de hardware):**
- Sinais dos eixos brutos (convenção assumida: X+ direita, Y+ para o usuário, Z+ para baixo, rotações pela regra da mão direita).
- Faixa real de cada unidade (±350 é "usual" segundo o Blender).
- Comportamento do 3DxService no Windows com WebHID; se o Chrome mostra o SpaceMouse como gamepad em cada SO.
- Report `0x16` (função dupla das teclas 1–4 do Pro) é ignorado.

## Fontes

- spacenavd `src/dev.c` (tabela USB, `bnhack_smpro`): https://github.com/FreeSpacenav/spacenavd
- openantz wiki "3D Mouse" (formato dos reports e tamanhos): https://github.com/openantz/antz/wiki/3D-Mouse
- Blender `intern/ghost/intern/GHOST_NDOFManager.cc` (PIDs, máscara 0x07C0F137, ±350): https://github.com/blender/blender
- Especificação WebHID (WICG `index.bs`): https://github.com/WICG/webhid
- MDN browser-compat-data `api/HID.json`: https://github.com/mdn/browser-compat-data
- Chromium `device/gamepad/raw_input_data_fetcher_win.cc`: https://github.com/chromium/chromium
- Fórum 3Dconnexion (driver bloqueia HID no Mac): https://forum.3dconnexion.com/viewtopic.php?p=119190

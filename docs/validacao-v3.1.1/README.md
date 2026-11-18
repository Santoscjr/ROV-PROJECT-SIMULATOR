# Validação visual v3.1.1

Capturas geradas por `scripts/visual.mjs` (Chromium headless com renderização por software, qualidade *média*, 1280×720). O ROV está a cerca de 118 m, a 4 m do ponto IP-01, com o Top-Hat a 90 m e o tether pago.

- `agua-clara.jpg`: câmera principal, auxiliar, tether, TMS, externa e layout de 4 telas.
- `agua-turva-quad-monitor.jpg`: principal, tether, externa e TMS em água turva; monitor secundário com 2 painéis (externa + TMS); layout de 4 telas.
- `quad-900px.jpg`: barra de instrumentos em 4 telas numa janela de 900 px (quebra em linhas, sem sobreposição).

Nas capturas em 4 telas, os painéis 2–4 aparecem com resolução reduzida. Isso é a degradação automática agindo, porque a renderização por software fica muito abaixo de 25 fps. Numa GPU real eles renderizam na resolução da qualidade escolhida.

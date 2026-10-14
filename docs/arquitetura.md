# Arquitetura

## Princípios

1. **Evidência antes de opinião.** Nada entra no genoma sem uma observação, e nenhuma observação existe sem pelo menos uma evidência (seletor e viewport, região de imagem, quadro, trecho de vídeo, página com citação, nó do Figma ou regra de CSS).
2. **Precisão explícita.** `exact` (o motor que renderiza mediu), `declared` (a marca afirmou), `estimated` (pixels), `inferred` (julgamento de um modelo, sempre citando a imagem).
3. **Desconhecido não é ausência.** Cada extração declara as facetas que examinou (`coverage`). Uma faceta que nenhuma fonte examinou vai para `unknowns`, e o brief diz para o agente não inventar.
4. **Cada fonte vota uma vez.** A confiança de um fato é `1 − Π(1 − peso_da_precisão × confiança × volume)`, com uma parcela por fonte. Volume satura em 5 leituras.
5. **Conflito é informação.** O sistema registra discordâncias com as evidências dos dois lados e espera uma decisão humana.
6. **O mesmo instrumento mede a referência e o resultado.** O `verify` usa os extratores que construíram o genoma.

## Fluxo de dados

```
Source ──extractor──▶ Extraction { observations[], coverage[], limitations[] }
                                  │
                       ReconcileContext (todas as extrações)
                                  │
   palette · typography · spacing · radius · shadow · motion · breakpoints · layout · imagery · voice
                                  │
                 deriveRules · collectStatedRules · detectConflicts · evaluateCheck
                                  │
                              Genome (genome.json)
                                  │
           query (MCP/CLI) · export (brief, tokens, css, tailwind, image-direction) · verify
```

## Modelo

- `Source`: tipo, URI, cópia local com SHA-256, `depicts` (o que um print mostra), opções (viewports, modo escuro, limiar de corte de cena, JSON do Figma).
- `Observation`: valor tipado por espécie (`color`, `typography`, `font-face`, `spacing`, `radius`, `shadow`, `motion`, `breakpoint`, `layout`, `imagery`, `rule`, `voice`), contexto, precisão, confiança, contagem e evidências.
- `Support`: status, confiança, fontes com precisão e contagem, ids das observações e evidências representativas.
- `Genome`: tokens por faceta, regras, conflitos, desconhecidos, cobertura e calibrações.

## Extratores

| Extrator | Implementação |
|---|---|
| `web` | Playwright/Chromium em cada viewport; rolagem para carregar conteúdo tardio; `getComputedStyle` em até 5.000 elementos visíveis; folhas de estilo para variáveis em `:root`, `@font-face` e `@media`; `document.getAnimations()`; `CSS.getPlatformFontsForNode` via CDP para saber que fonte foi realmente pintada; print da página e recortes dos estilos de texto. Papéis tipográficos vêm do tamanho relativo ao corpo do texto. |
| `figma` | API REST `/v1/files/:key` ou JSON exportado; percorre nós visíveis. |
| `document` | pdf.js para texto por página, `pdftoppm` para miniaturas; expressões para hex/RGB/Pantone/CMYK, famílias conhecidas, tamanhos em px/pt, polaridade (EN/PT) e tópicos; frases verificáveis viram `check` (família, paleta, máximo de cores, sem caixa alta, tamanho mínimo, unidade de grid). |
| `image` | k-means++ determinístico em OKLab, fusão de clusters próximos, região dominante por cluster; gradiente de luminosidade para espaço negativo, detalhe, foco, colunas e margens. |
| `video` | `ffprobe`, detecção de cena do ffmpeg, um quadro por plano (até 48), análise de imagem por quadro ponderada pela duração do plano, diferença entre quadros para intensidade. |
| `vision` | Envia até 8 evidências a um modelo multimodal e pede regras de direção de arte em JSON, cada uma citando as imagens. Só roda com `ANTHROPIC_API_KEY`. |

## Reconciliação

- **Paleta:** leituras exatas ancoram grupos; declaradas e estimadas entram por tolerância (ΔE 1,2 / 2,5 / 6). A participação de cada cor é normalizada por fonte e dividida pelo número de fontes que examinaram cor. Nomes semânticos (`canvas`, `text-primary`, `text-secondary`, `accent`) saem do uso; o resto ganha nome perceptual (`blue-55`).
- **Tipografia:** famílias com variantes ópticas unificadas e status de licença; estilos por papel e viewport; escala modular testada só com razões ≥ 1,12 (razões menores explicam qualquer coisa) e marcada como não modular quando o erro passa de 0,12 passo; tabela de tracking por tamanho e regressão em `ln(tamanho)`.
- **Métricas:** agrupamento 1-D para espaçamento, raios, durações e breakpoints; grid escolhido como a maior unidade com aderência ≥ 85%; curvas de easing normalizadas (`ease` → `cubic-bezier(0.25, 0.1, 0.25, 1)`); estatísticas de montagem.
- **Calibração:** densidade de pixels do print por viewport (1, 1,5, 2, 3) com erro ≤ 5% e desvio de cor em relação ao CSS.
- **Regras declaradas:** `evaluateCheck` testa cada regra verificável; aprovada, ela recebe as observações que a confirmam; reprovada, `detectConflicts` gera o conflito com `ruleObservationId`.

## Verificação

Cada faceta acumula verificações com peso `log2(1 + contagem)` e penalidades por severidade (alta 1, média 0,6, baixa 0,25). A nota geral é a média ponderada das facetas presentes (cor e tipografia pesam mais). Cada desvio traz o valor encontrado, o esperado e onde está.

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
                                  │                                  anatomy (peças medidas + leituras + conceito)
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
| `web` | Playwright/Chromium em cada viewport; recusa páginas de verificação anti-robô e respostas HTTP ≥ 400; fecha camadas de consentimento; uma passada lenta de rolagem para disparar conteúdo tardio; depois fotografa **tela por tela** (espera as animações assentarem em cada parada), costura as telas e, em cada parada, registra que elementos estão realmente pintados (opacidade efetiva por todos os ancestrais, recorte por `overflow`, texto transparente, cobertura testada com `elementFromPoint`) e onde; camadas fixas e cabeçalhos grudados na borda só aparecem na primeira tela; quando a página não rola nativamente, uma renderização alta com aviso; `getComputedStyle` em até 5.000 elementos visíveis; folhas de estilo para variáveis em `:root`, `@font-face` e `@media`; `document.getAnimations()`; `CSS.getPlatformFontsForNode` via CDP para saber que fonte foi realmente pintada; print da página e recortes dos estilos de texto. Papéis tipográficos vêm do tamanho relativo ao corpo do texto. |
| `figma` | API REST `/v1/files/:key` ou JSON exportado; percorre nós visíveis. |
| `document` | pdf.js para texto por página, `pdftoppm` para miniaturas; expressões para hex/RGB/Pantone/CMYK, famílias conhecidas, tamanhos em px/pt, polaridade (EN/PT) e tópicos; frases verificáveis viram `check` (família, paleta, máximo de cores, sem caixa alta, tamanho mínimo, unidade de grid). |
| `image` | k-means++ determinístico em OKLab, fusão de clusters próximos, região dominante por cluster; gradiente de luminosidade para espaço negativo, detalhe, foco, colunas e margens. |
| `video` | `ffprobe`, detecção de cena do ffmpeg, um quadro por plano (até 48), análise de imagem por quadro ponderada pela duração do plano, diferença entre quadros para intensidade. |
| `vision` | Envia até 8 evidências a um modelo multimodal e pede regras de direção de arte em JSON, cada uma citando as imagens. Só roda com `ANTHROPIC_API_KEY`. |

## Anatomia

Cada fonte de imagem, vídeo ou site vira **peças** (`anatomy/<fonte>.json`): a imagem inteira, até 6 planos do filme, as seções da página no maior e no menor viewport (cortadas onde há um vão vertical no conteúdo).

- **Blocos.** Em sites, as caixas que o navegador renderizou (`layout-<viewport>.json`, gravado pelo extrator web), com a extensão do próprio texto (Range) e não do bloco que o contém: exatas. Em pixels: cor de fundo pela borda; máscara do que difere do fundo (cor ou borda), fechamento morfológico mais largo na horizontal para juntar letras em palavras e linhas, componentes conexos, e classificação por cobertura, uniformidade do anel interno, faixas de linhas e transições por linha. Painéis e botões são revisitados por dentro, com a cor deles como fundo e o lado de fora (cantos arredondados) excluído por preenchimento a partir da borda. Fundo de foto ou textura vira uma imagem sangrada, e o que está sobre ela é achado por contraste local em duas passadas (a segunda contra a média do fundo sem a figura, para não criar halo), mais áreas chapadas, nítidas e quase retangulares (selos, botões, faixas). Palavras de uma linha e linhas de um parágrafo são unidas.
- **Triagem** (`triage.ts`): antes da leitura, cada peça recebe status `ok`, `doubtful` ou `skip` e uma descrição do que ela é. Checagens: em branco (desvio padrão), cópia de outra peça (dHash), texto medido sem tinta na foto (pixels distantes do fundo dentro da caixa — independente da cor declarada, que opacidade e mistura alteram), composição (menos de dois blocos), captura antiga, fundo dominante. Texto sem tinta sai da medida. Peças `skip` e as descartadas pelo leitor (`genome_dissect_skip`) não entram na fila, nas invariantes, na folha de contato nem nas plantas. Recapturar um site descarta as leituras e regras da captura antiga.
- **Medidas** (`analyzeLayout`, iguais para DOM e pixels): margens e área útil sem os elementos sangrados; eixos de alinhamento por agrupamento 1-D das bordas; vão até o vizinho de baixo e ao lado; ritmo (valores distintos e se são múltiplos de uma unidade); grid (`grid.ts`): colunas de 1 a 12 contando o início de todos os blocos e o fim só dos blocos rígidos (imagem, painel, botão; texto termina onde as palavras acabam), aceito só quando explica ≥ 70% das bordas, supera o acaso em 40 pontos e a uma coluna em 15, com ≥ 60% dos blocos assentados; colunas que cada bloco ocupa (ou "centralizado", ou fora do grid); linhas (grid modular) só em telas lidas de uma vez; linha de base pela unidade comum aos topos dos textos, com correção pelo acaso; terços ou áurea quando as bordas se juntam nessas linhas três vezes mais que o acaso; container centralizado; peso = área × contraste (texto pesa mais, painel menos); centro de peso, quadrantes, simetria; foco contra terços, áurea e centro óptico; respiro em grade 48×48 com o maior retângulo vazio; caminho de leitura.
- **Imagem anotada** (`evidence/<fonte>/anatomy-<n>.jpg`): blocos numerados por cor de tipo, área útil e margens, bordas compartilhadas, vãos em px, terços.
- **Imagem do grid** (`evidence/<fonte>/grid-<n>.jpg`): faixas de coluna (gutters livres), faixas de linha, linha de base, linhas de terços/áurea e cada bloco com as colunas que ocupa.
- **Leitura** (inferida): o modelo da conversa recebe a peça, a anotação, o grid, a triagem e as medidas; primeiro identifica a peça e confere a foto contra os blocos (ou a descarta), depois devolve o que ela é, o grid em que foi montada, papel e porquê de cada bloco (números de bloco inexistentes são recusados), composição, princípios, intenção, fragilidades, correções e regras. As regras viram a extração `dissect` da fonte e se cruzam com as demais.
- **Invariantes:** por grupo (imagens e planos; seções de site), a mediana e o desvio absoluto mediano de margens, tamanho do título relativo à tela, contraste tipográfico, respiro, área de imagem, posição do foco, unidade de ritmo; e a categoria dominante de proporção, simetria, leitura, grid e fundo. Constante quando o desvio é pequeno (≤ 2 pontos percentuais, ou ≤ 20% do valor) ou a categoria cobre ≥ 70% das peças.
- **Conceito** (`concept.json`): leitura do projeto inteiro sobre a folha de contato, as leituras e as invariantes.
- **Planta** (`blueprints/`): ranqueia as peças por proporção, grupo, tipo e palavras do pedido; adapta a melhor ao novo formato (margens e tipo pelo lado menor; linhas acima da imagem principal empilhadas a partir da margem de cima, as de baixo a partir da margem de baixo, com os vãos escalados; a imagem principal absorve a diferença; filhos acompanham o pai; área segura do story) e junta conceito, constantes, porquês, regras e wireframe.

## Reconciliação

- **Paleta:** leituras exatas ancoram grupos; declaradas e estimadas entram por tolerância (ΔE 1,2 / 2,5 / 6). A participação de cada cor é normalizada por fonte e dividida pelo número de fontes que examinaram cor. Nomes semânticos (`canvas`, `text-primary`, `text-secondary`, `accent`) saem do uso; o resto ganha nome perceptual (`blue-55`).
- **Tipografia:** famílias com variantes ópticas unificadas e status de licença; estilos por papel e viewport; escala modular testada só com razões ≥ 1,12 (razões menores explicam qualquer coisa) e marcada como não modular quando o erro passa de 0,12 passo; tabela de tracking por tamanho e regressão em `ln(tamanho)`.
- **Métricas:** agrupamento 1-D para espaçamento, raios, durações e breakpoints; grid escolhido como a maior unidade com aderência ≥ 85%; curvas de easing normalizadas (`ease` → `cubic-bezier(0.25, 0.1, 0.25, 1)`); estatísticas de montagem.
- **Calibração:** densidade de pixels do print por viewport (1, 1,5, 2, 3) com erro ≤ 5% e desvio de cor em relação ao CSS.
- **Regras declaradas:** `evaluateCheck` testa cada regra verificável; aprovada, ela recebe as observações que a confirmam; reprovada, `detectConflicts` gera o conflito com `ruleObservationId`.

## Verificação

Cada faceta acumula verificações com peso `log2(1 + contagem)` e penalidades por severidade (alta 1, média 0,6, baixa 0,25). A nota geral é a média ponderada das facetas presentes (cor e tipografia pesam mais). Cada desvio traz o valor encontrado, o esperado e onde está.

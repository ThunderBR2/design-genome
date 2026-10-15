# Começando: das referências à marca no Figma

Este guia leva você do zero até o Claude construindo uma marca no Figma, guiado por um genoma extraído das suas referências.

O fluxo usa dois conectores ao mesmo tempo, na mesma conversa do **app Claude para desktop**:

- **Design Genome** (local, roda no seu computador): mede as referências e guarda o genoma.
- **Figma** (conector oficial): onde o Claude constrói a marca.

O Design Genome é um servidor local porque abre o Chromium, usa o ffmpeg e lê arquivos do seu disco. Servidores locais funcionam no Claude Desktop e no Claude Code, não na versão web nem no celular.

## 1. Instalar (uma vez)

Você precisa de Node.js 22 ou mais novo e do Git.

```bash
git clone https://github.com/ThunderBR2/design-genome
cd design-genome
npm install
npx playwright install chromium
npm run build
npm link
```

Para vídeos, instale também o ffmpeg:

| Sistema | Comando |
|---|---|
| Windows | `winget install Gyan.FFmpeg` (depois feche e abra o terminal) |
| macOS | `brew install ffmpeg` |

Confira se está tudo certo:

```bash
genome doctor
```

Os itens com ✓ estão prontos. Os com ○ são opcionais.

## 2. Criar o projeto da marca

Escolha uma pasta para o projeto. Ela guarda as fontes, as evidências e o genoma.

```bash
genome -p ~/marcas/minha-marca init "Minha Marca"
```

No Windows, use um caminho como `C:\marcas\minha-marca`.

## 3. Conectar ao Claude Desktop

```bash
genome -p ~/marcas/minha-marca mcp-config --install
```

O comando adiciona o Design Genome à configuração do Claude Desktop, mantém o que já existe lá e faz backup do arquivo. Feche o Claude Desktop por completo e abra de novo.

Se você também quiser que o Claude **verifique** o que construiu no Figma, gere um token pessoal no Figma (Settings → Security → Personal access tokens) e rode:

```bash
genome -p ~/marcas/minha-marca mcp-config --install --figma-token SEU_TOKEN
```

Confirme que o conector do **Figma** também está ligado no Claude.

## 4. Subir as referências

Há dois jeitos. Use o que for mais confortável.

**Pelo Studio** (arrastar e soltar):

```bash
genome -p ~/marcas/minha-marca studio
```

Abra http://127.0.0.1:4848, cole links, arraste imagens, vídeos e PDFs e clique em "Extract and cross-check".

**Pelo Claude**, na conversa:

> Adicione ao design genome: https://www.apple.com/iphone/, https://www.apple.com/macbook-air/ e os arquivos da pasta C:\referencias\apple (imagens, o vídeo e o PDF).

O Claude não consegue pegar imagens anexadas na conversa e entregar ao servidor local. Por isso, para arquivos, coloque-os numa pasta e passe o caminho.

Dicas para um genoma mais preciso:

- Comece por uma fonte exata (o site ou um arquivo do Figma). Ela ancora as medições das imagens.
- Se uma imagem for um print de uma página que você adicionou, diga isso ("este print é da página do iPhone"). O Claude passa `depicts` e o print é calibrado.
- Várias fontes da mesma marca se confirmam entre si. Fontes de marcas diferentes criam um genoma híbrido.

## 5. Dissecar as peças e ler o projeto

> Disseque todas as peças e depois leia o conceito do projeto.

Cada imagem, plano de vídeo e seção de site já chega medida: elementos numerados, margens, distâncias, alinhamentos, grid, ritmo, hierarquia, equilíbrio e respiro. O Claude recebe cada peça com essa anatomia desenhada por cima e explica o que é cada elemento e por que ele está ali, por que a peça funciona e o que a quebraria. No fim, olha todas as peças juntas e escreve o conceito: a ideia, por que o projeto é assim, o que nunca muda, o que varia e como adaptar. Isso usa o seu plano, sem chave de API.

Para uma leitura mais rápida, sem dissecar peça por peça, ainda existe a passada de visão: "rode a passada de visão em todas as fontes".

Para criar uma peça nova a partir disso:

> Faça a planta de um story de lançamento do menu de outono e depois produza.

A planta traz as referências escolhidas, o layout redesenhado no formato pedido, em px, o porquê de cada elemento e um wireframe.

## 6. Revisar o que foi aprendido

> Mostre o brief do genoma e os conflitos abertos.

Decida cada conflito ("siga o site", "siga o brand book"). As decisões ficam gravadas e entram em tudo o que for gerado depois. O Studio mostra as mesmas coisas, com a evidência de cada fato.

## 7. Construir a marca no Figma

No Claude Desktop, use o prompt pronto do Design Genome (**Criar marca no Figma a partir do genoma**, no menu de prompts do conector) ou escreva:

> Crie a marca "Minha Marca" no Figma usando o design genome como base: uma marca de luminárias premium para casa. Proponha a identidade antes de construir. Depois crie variáveis, estilos de texto, componentes e uma página de exemplo, e verifique com o genome_verify.

O que o Claude faz:

1. Lê o brief e as regras confirmadas.
2. Propõe a identidade: paleta própria (respeitando a proporção de neutros e acentos do genoma), tipografia aberta (as substitutas indicadas), rampa de tamanhos, tracking, grid, raios e movimento.
3. Constrói no Figma: variáveis, estilos de texto, componentes e uma página de exemplo.
4. Verifica o frame com `genome_verify` e corrige os desvios.

## 8. Verificar depois

```bash
genome -p ~/marcas/minha-marca verify "https://www.figma.com/design/ARQUIVO/Nome?node-id=1-2"
genome -p ~/marcas/minha-marca verify ./landing.html
genome -p ~/marcas/minha-marca verify ./imagem-gerada.png
```

## Sobre usar a Apple como referência

O genoma aprende o sistema: proporções, escalas, ritmo, relações de cor, regras de composição. A marca que sai dele é sua. Logos, ícones, fotos, textos e a fonte SF Pro da Apple ficam como referência e não entram no que o Claude constrói; as exportações já trocam fontes restritas por substitutas abertas.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| O Claude não vê as ferramentas do Design Genome | Feche o Claude Desktop por completo e abra de novo. Rode `genome mcp-config` para conferir o caminho do arquivo de configuração. |
| "Chromium not installed" | `npx playwright install chromium` |
| Vídeo falha | Rode `genome doctor`; o ffmpeg precisa estar no PATH |
| Verificação do Figma pede token | Rode `mcp-config --install --figma-token ...` e reabra o Claude |
| Site bloqueia ou carrega pela metade | Alguns sites limitam acesso automatizado. Salve a página completa (Ctrl+S, "Página da web, completa") e adicione o arquivo como site: `genome add pagina.html --kind web` |

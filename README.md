# Cruzadas de História — versão mobile

Esta versão foi refeita para funcionar como uma cruzadinha clássica em celular.

## Estrutura

```text
/
├── index.html
├── palavras.json        ← mantenha o seu arquivo existente aqui
├── css/
│   └── style.css
└── js/
    ├── app.js
    ├── data.js
    ├── validator.js
    ├── generator.js
    └── crossword-worker.js
```

## O que mudou

- A grade ocupa toda a largura disponível no celular.
- A altura pode ser maior que a largura, mas o gerador prioriza no máximo quatro linhas extras.
- O alvo é de até 16 palavras.
- As casas são botões, não campos de texto; portanto o teclado do sistema não precisa abrir.
- Há teclado virtual dentro da página.
- A palavra ativa fica azul.
- A casa ativa fica amarela.
- A dica atual aparece logo abaixo da cruzadinha.
- As setas laterais percorrem as dicas.
- Tocar em qualquer casa mostra a dica daquela palavra.
- Tocar novamente numa casa de cruzamento alterna entre horizontal e vertical.
- Os números ficam dentro da própria grade.
- Há botões para verificar, revelar uma letra e apagar a palavra ativa.
- O progresso é salvo no navegador.

## palavras.json

Use exatamente o seu `palavras.json` atual.

O formato aceito continua sendo:

```json
{
  "perguntas": [
    {
      "id": 1,
      "resposta": "PALEOLITICO",
      "exibicao": "Paleolítico",
      "dica": "Período da pedra lascada.",
      "tema": "Pré-História",
      "subtema": "Paleolítico",
      "dificuldade": 1,
      "ativo": true
    }
  ]
}
```

`resposta` deve conter somente `A-Z`, sem espaços, acentos ou hífens.

## GitHub Pages

No repositório, mantenha `palavras.json` na raiz, ao lado de `index.html`.

Substitua os arquivos antigos pelos arquivos desta versão e preserve o seu banco real.

O projeto deve ser aberto por servidor HTTP/HTTPS; no GitHub Pages isso já acontece automaticamente.

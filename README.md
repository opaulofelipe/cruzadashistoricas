# Cruzadas de História — versão modular

Projeto em HTML, CSS e JavaScript puro. Não usa framework, backend ou banco de dados.

## Estrutura

```text
/
├── index.html
├── palavras.json             ← coloque aqui o seu banco
├── css/
│   └── style.css
└── js/
    ├── app.js                ← coordena a aplicação
    ├── data.js               ← carrega o JSON e organiza temas
    ├── validator.js          ← valida o banco
    ├── generator.js          ← algoritmo de geração
    ├── game.js               ← estado e regras da partida
    ├── renderer.js           ← DOM, grade e pistas
    └── crossword-worker.js   ← geração em thread separada
```

## Formato do palavras.json

Pode ser um array ou um objeto com `perguntas`:

```json
{
  "perguntas": [
    {
      "id": 1,
      "resposta": "PALEOLITICO",
      "exibicao": "Paleolítico",
      "dica": "...",
      "tema": "Pré-História",
      "subtema": "Paleolítico",
      "dificuldade": 1,
      "ativo": true
    }
  ]
}
```

### Regra obrigatória para resposta

`resposta` precisa obedecer a:

```js
/^[A-Z]+$/
```

Ou seja: somente letras maiúsculas A-Z. Sem números, espaços, acentos, hífens ou pontuação.

Registros inválidos, IDs duplicados e respostas duplicadas são ignorados e informados no console.

## Temas mostrados

- Todos os temas
- Pré-História
- História Antiga
- História Medieval
- História Moderna
- História Contemporânea
- História do Brasil

Os valores continuam sendo lidos dos temas já existentes no JSON. A interface apenas usa rótulos mais amigáveis.

## Dificuldade

- Fácil: prioriza nível 1
- Médio: prioriza nível 2
- Difícil: prioriza nível 3

A escolha é uma preferência ponderada, não um filtro rígido. Isso permite preservar uma grade boa quando um tema possui poucos termos de uma dificuldade específica.

## Qualidade do gerador

O gerador:

- só aceita uma grade conectada;
- exige cruzamento para toda palavra após a primeira;
- impede conflitos de letras;
- impede palavras encostadas de forma acidental;
- impede extensão acidental no início/fim das palavras;
- escolhe candidatos pela compatibilidade de letras;
- usa backtracking;
- testa múltiplas posições;
- permite pular candidatos problemáticos;
- gera múltiplas soluções dentro de um orçamento de tempo;
- prioriza quantidade de palavras, cruzamentos, densidade e formato compacto;
- penaliza grades muito largas/altas;
- roda em Web Worker para não travar a interface.

## UX da partida

- clique/toque em uma casa seleciona a palavra;
- toque/clique novamente em um cruzamento alterna horizontal/vertical;
- digitação avança automaticamente;
- Backspace apaga e volta;
- setas navegam pela palavra na direção correspondente;
- Enter/Espaço alternam a direção em cruzamentos;
- colar texto preenche a palavra ativa;
- entrada do jogador aceita acentos e converte para A-Z;
- pistas podem ser clicadas;
- verificar só marca erros quando solicitado;
- é possível revelar uma letra;
- a partida é salva no `localStorage`;
- a mesma grade funciona em desktop e celular com rolagem quando necessário.

## Como testar localmente

Não abra o HTML diretamente por `file://`, porque `fetch()` e Web Worker podem ser bloqueados.

Na pasta do projeto:

```bash
python3 -m http.server 8000
```

Depois abra:

```text
http://localhost:8000
```

No GitHub Pages não é preciso alterar os caminhos.

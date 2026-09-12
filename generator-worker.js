"use strict";

self.onmessage = event => {
  const data = event.data || {};
  if (data.type !== "generate") return;

  try {
    const puzzle = generatePackedCrossword(data.words || [], data.options || {});

    if (!puzzle) {
      self.postMessage({
        type: "error",
        message:
          "Não consegui montar 30 respostas conectadas nesta tentativa. Clique em tentar novamente."
      });
      return;
    }

    self.postMessage({ type: "result", puzzle });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || String(error)
    });
  }
};

function generatePackedCrossword(rawWords, options) {
  const minWords = Math.max(30, Number(options.minWords) || 30);
  const targetWords = minWords;
  const budgetMs = Math.max(3500, Number(options.timeBudgetMs) || 14000);
  const seed = Number(options.seed) || Date.now();
  const deadline = performance.now() + budgetMs;
  const allWords = normalizeWords(rawWords).filter(word => word.resposta.length <= 13);

  if (allWords.length < minWords) {
    throw new Error(`O banco possui apenas ${allWords.length} respostas utilizáveis de até 13 letras.`);
  }

  const byLetter = buildWordLetterStats(allWords);
  const sizes = [13, 12, 11];
  let best = null;
  let attempt = 0;

  for (const size of sizes) {
    const attemptsForSize = size === 13 ? 10 : size === 12 ? 7 : 6;

    for (let local = 0; local < attemptsForSize; local++) {
      if (performance.now() >= deadline) break;

      attempt++;
      const rng = mulberry32(seed + attempt * 104729 + size * 8191);
      const candidate = buildAttempt(allWords, byLetter, size, targetWords, rng, deadline);

      if (!best || compareCandidate(candidate, best) > 0) {
        best = candidate;
      }

      postProgress(
        `Tentativa ${attempt}: ${candidate.placements.length} palavras em ${size}×${size}, ` +
        `${Math.round((1 - candidate.occupied / (size * size)) * 100)}% de blocos pretos.`
      );

    }

    // A referência visual tem aproximadamente 10–15% de casas pretas.
    // Se já encontramos 30 palavras nessa faixa, usamos esse resultado.
    if (
      best?.placements.length >= minWords &&
      best.blackRatio >= 0.07 &&
      best.blackRatio <= 0.20
    ) {
      return buildPuzzle(best);
    }
  }

  if (best?.placements.length >= minWords) {
    return buildPuzzle(best);
  }

  return null;
}

function normalizeWords(rawWords) {
  const result = [];
  const seen = new Set();

  for (const raw of rawWords) {
    if (raw?.ativo === false) continue;

    const resposta = normalizeAnswer(raw?.resposta || raw?.exibicao || "");
    const dica = String(raw?.dica || "").trim();
    const exibicao = String(raw?.exibicao || resposta).trim();

    if (resposta.length < 2 || !dica || seen.has(resposta)) continue;

    seen.add(resposta);
    result.push({
      id: raw?.id ?? result.length + 1,
      resposta,
      exibicao,
      dica
    });
  }

  return result;
}

function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function buildWordLetterStats(words) {
  const frequency = new Map();

  for (const word of words) {
    const unique = new Set(word.resposta);
    for (const letter of unique) {
      frequency.set(letter, (frequency.get(letter) || 0) + 1);
    }
  }

  return frequency;
}

function buildAttempt(words, letterFrequency, size, targetWords, rng, deadline) {
  const grid = Array.from({ length: size }, () => Array(size).fill(null));
  const dirs = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => new Set())
  );
  const memberships = Array.from({ length: size * size }, () => []);
  const letterCells = new Map();
  const placements = [];
  const used = new Set();

  const eligibleSeeds = words
    .filter(word => word.resposta.length >= 6 && word.resposta.length <= Math.min(11, size))
    .map(word => ({
      word,
      score: seedScore(word, letterFrequency) + rng() * 4
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(80, words.length));

  const seedChoice = eligibleSeeds[Math.floor(rng() * Math.min(12, eligibleSeeds.length))]?.word;
  const seedWord = seedChoice || words.find(word => word.resposta.length <= size);

  if (!seedWord) {
    return finalizeCandidate(size, grid, dirs, memberships, placements);
  }

  const seedDir = rng() < 0.5 ? "across" : "down";
  const center = Math.floor(size / 2);
  const seedStart = centeredStart(seedWord.resposta.length, size, seedDir, center);
  placeWord(seedWord, seedStart.row, seedStart.col, seedDir);

  while (placements.length < targetWords && performance.now() < deadline) {
    const remaining = [];

    for (const word of words) {
      if (used.has(word.resposta) || word.resposta.length > size) continue;
      remaining.push(word);
    }

    shuffleInPlace(remaining, rng);

    const top = [];
    const scanLimit = Math.min(remaining.length, 420);

    for (let wi = 0; wi < scanLimit; wi++) {
      const word = remaining[wi];
      const answer = word.resposta;

      for (let pos = 0; pos < answer.length; pos++) {
        const anchors = letterCells.get(answer[pos]);
        if (!anchors?.length) continue;

        for (const cellIndex of anchors) {
          const ar = Math.floor(cellIndex / size);
          const ac = cellIndex % size;

          for (const direction of ["across", "down"]) {
            const dr = direction === "down" ? 1 : 0;
            const dc = direction === "across" ? 1 : 0;
            const row = ar - dr * pos;
            const col = ac - dc * pos;
            const evaluated = evaluatePlacement(word, row, col, direction);

            if (!evaluated) continue;

            insertTop(top, {
              ...evaluated,
              word,
              row,
              col,
              direction
            }, 18);
          }
        }
      }
    }

    if (!top.length) break;

    // Evita cair sempre no mesmo ótimo local: escolhe entre os melhores.
    const selectionPool = top.slice(0, Math.min(7, top.length));
    const choiceIndex = weightedTopIndex(selectionPool.length, rng);
    const chosen = selectionPool[choiceIndex];

    placeWord(chosen.word, chosen.row, chosen.col, chosen.direction);
  }

  return finalizeCandidate(size, grid, dirs, memberships, placements);

  function evaluatePlacement(word, row, col, direction) {
    const answer = word.resposta;
    const dr = direction === "down" ? 1 : 0;
    const dc = direction === "across" ? 1 : 0;

    const endRow = row + dr * (answer.length - 1);
    const endCol = col + dc * (answer.length - 1);

    if (
      row < 0 || col < 0 ||
      endRow < 0 || endCol < 0 ||
      row >= size || col >= size ||
      endRow >= size || endCol >= size
    ) {
      return null;
    }

    let crossings = 0;
    let newCells = 0;
    let adjacent = 0;
    let edgeTouches = 0;

    for (let i = 0; i < answer.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      const current = grid[r][c];

      if (current && current !== answer[i]) return null;
      if (dirs[r][c].has(direction)) return null;

      if (current === answer[i]) {
        crossings++;
      } else {
        newCells++;
      }

      if (r === 0 || r === size - 1 || c === 0 || c === size - 1) {
        edgeTouches++;
      }

      // Recompensa preencher "buracos" entre casas já usadas.
      for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        if (grid[nr][nc]) adjacent++;
      }
    }

    if (crossings < 1) return null;

    // Evita uma palavra ser praticamente toda sobreposta.
    if (newCells < Math.max(1, Math.floor(answer.length * 0.22))) return null;

    // Favorece múltiplos cruzamentos, compacidade e o preenchimento visual da grade.
    let score =
      crossings * 34 +
      adjacent * 1.4 +
      answer.length * 1.3 +
      newCells * 0.45 -
      edgeTouches * 0.15 +
      rng() * 3;

    if (crossings >= 2) score += 18;
    if (crossings >= 3) score += 22;

    // Depois de 20 palavras, passa a privilegiar ainda mais os múltiplos cruzamentos.
    if (placements.length >= 20) {
      score += crossings * 7;
      score -= newCells * 0.18;
    }

    return { score, crossings, newCells };
  }

  function placeWord(word, row, col, direction) {
    const answer = word.resposta;
    const dr = direction === "down" ? 1 : 0;
    const dc = direction === "across" ? 1 : 0;
    const slotId = `S${placements.length}`;
    const cells = [];

    for (let i = 0; i < answer.length; i++) {
      const r = row + dr * i;
      const c = col + dc * i;
      const index = r * size + c;

      if (!grid[r][c]) {
        grid[r][c] = answer[i];
        if (!letterCells.has(answer[i])) letterCells.set(answer[i], []);
        letterCells.get(answer[i]).push(index);
      }

      dirs[r][c].add(direction);
      memberships[index].push(slotId);
      cells.push(index);
    }

    placements.push({
      id: slotId,
      row,
      col,
      direction,
      cells,
      word
    });

    used.add(answer);
  }
}

function seedScore(word, frequency) {
  let score = 0;
  const unique = new Set(word.resposta);

  for (const letter of unique) {
    score += Math.log1p(frequency.get(letter) || 0);
  }

  return score + word.resposta.length * 0.25;
}

function centeredStart(length, size, direction, center) {
  if (direction === "across") {
    return {
      row: center,
      col: Math.max(0, Math.floor((size - length) / 2))
    };
  }

  return {
    row: Math.max(0, Math.floor((size - length) / 2)),
    col: center
  };
}

function insertTop(list, candidate, limit) {
  let index = 0;
  while (index < list.length && list[index].score >= candidate.score) index++;
  list.splice(index, 0, candidate);
  if (list.length > limit) list.length = limit;
}

function weightedTopIndex(length, rng) {
  if (length <= 1) return 0;
  const weights = Array.from({ length }, (_, i) => length - i);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;

  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }

  return 0;
}

function finalizeCandidate(size, grid, dirs, memberships, placements) {
  let occupied = 0;
  let crossings = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) occupied++;
      if (dirs[r][c].size >= 2) crossings++;
    }
  }

  return {
    size,
    grid,
    dirs,
    memberships,
    placements,
    occupied,
    crossings,
    blackRatio: 1 - occupied / (size * size)
  };
}

function compareCandidate(a, b) {
  if (!b) return 1;

  if (a.placements.length !== b.placements.length) {
    return a.placements.length - b.placements.length;
  }

  const targetBlack = 0.12;
  const aDistance = Math.abs(a.blackRatio - targetBlack);
  const bDistance = Math.abs(b.blackRatio - targetBlack);

  // Prioriza a aparência semelhante à referência; depois, mais cruzamentos reais.
  if (Math.abs(aDistance - bDistance) > 0.015) {
    return bDistance - aDistance;
  }

  return a.crossings - b.crossings;
}

function buildPuzzle(candidate) {
  const { size, grid, memberships, placements } = candidate;
  const cells = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const index = r * size + c;
      const solution = grid[r][c] || "";

      cells.push({
        row: r,
        col: c,
        block: !solution,
        solution,
        slotIds: solution ? [...memberships[index]] : []
      });
    }
  }

  const startMap = new Map();
  for (const placement of placements) {
    const start = placement.cells[0];
    if (!startMap.has(start)) startMap.set(start, null);
  }

  [...startMap.keys()]
    .sort((a, b) => a - b)
    .forEach((cellIndex, i) => startMap.set(cellIndex, i + 1));

  const slots = placements.map(placement => ({
    id: placement.id,
    number: startMap.get(placement.cells[0]),
    direction: placement.direction,
    length: placement.word.resposta.length,
    cells: [...placement.cells],
    word: {
      id: placement.word.id,
      resposta: placement.word.resposta,
      exibicao: placement.word.exibicao,
      dica: placement.word.dica
    }
  }));

  slots.sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    return a.direction === "across" ? -1 : 1;
  });

  return {
    rows: size,
    cols: size,
    cells,
    slots,
    blackRatio: candidate.blackRatio
  };
}

function postProgress(message) {
  self.postMessage({ type: "progress", message });
}

function shuffleInPlace(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function mulberry32(seed) {
  let a = seed >>> 0;

  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

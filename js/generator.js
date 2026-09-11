/**
 * Gerador de cruzadinhas sem dependência de DOM.
 * Pode ser executado em Web Worker ou testado diretamente.
 *
 * Objetivos de qualidade, em ordem aproximada:
 * 1. colocar o maior número possível de palavras;
 * 2. aumentar a quantidade de cruzamentos reais;
 * 3. favorecer palavras com dois ou mais cruzamentos;
 * 4. manter a grade conectada, compacta e equilibrada;
 * 5. evitar palavras apenas encostadas ou extensões acidentais.
 */
export function generateCrossword(allWords, options = {}, onProgress = () => {}) {
  const {
    theme = "__ALL__",
    allThemesValue = "__ALL__",
    difficulty = 2,
    seed = Date.now(),
    targetWords = 22,
    maxCandidates = 96,
    timeBudgetMs = 5600,
    perAttemptMs = 800,
    maxCols = 13,
    maxRows = 17,
    maxFinalWords = 26
  } = options;

  const rng = makeRng(seed >>> 0);
  const filtered = allWords.filter((word) =>
    (theme === allThemesValue || word.tema === theme || word.tema === "Coringa") &&
    word.resposta.length <= Math.max(maxCols, maxRows)
  );
  if (filtered.length < 6) throw new Error("Poucas palavras disponíveis para esse tema.");

  // Para uma grade mais densa, o núcleo prioriza respostas de até 10 letras.
  // Palavras muito longas consomem várias casas sem criar cruzamentos suficientes.
  // Se um tema tiver poucas respostas curtas, ampliamos automaticamente até 13.
  const compactWords = filtered.filter((word) => word.resposta.length <= 10);
  const mediumWords = filtered.filter((word) => word.resposta.length <= 13);
  const searchWords = compactWords.length >= Math.max(48, targetWords * 2)
    ? compactWords
    : mediumWords.length >= Math.max(36, targetWords + 10)
      ? mediumWords
      : filtered;

  // A geração ocorre em duas etapas. Primeiro montamos um núcleo bem conectado.
  // Depois congelamos a moldura encontrada e fazemos uma segunda busca apenas para
  // preencher os espaços internos. Essa fase funciona como um template dinâmico:
  // a grade vem antes das últimas palavras, reduzindo grandes áreas pretas.
  const startedAt = now();
  const totalBudget = Math.max(1800, timeBudgetMs);
  const coreDeadline = startedAt + totalBudget * 0.86;
  const globalDeadline = startedAt + totalBudget;
  let best = null;
  let attempt = 0;
  let lastProgress = 0;

  while (now() < coreDeadline) {
    attempt += 1;

    const candidates = buildCandidatePool(searchWords, difficulty, maxCandidates, rng);
    if (candidates.length < 6) break;

    const compatibility = compatibilityScores(candidates);
    const seedWord = chooseSeedWord(
      candidates.filter((word) => word.answer.length <= maxCols),
      compatibility,
      rng,
      attempt
    );

    if (!seedWord) continue;

    const grid = new Map();
    const placed = [];
    placeWord(grid, placed, seedWord, 0, 0, "across");

    const remaining = candidates.filter((word) => word.id !== seedWord.id);
    const remainingGlobalMs = Math.max(0, coreDeadline - now());
    const attemptDeadline = Math.min(
      coreDeadline,
      now() + Math.min(perAttemptMs, Math.max(120, remainingGlobalMs))
    );

    const holder = {
      best: snapshotState(grid, placed),
      nodes: 0,
      target: Math.min(targetWords, candidates.length),
      deadline: attemptDeadline,
      maxNodes: 14000,
      maxCols,
      maxRows
    };

    search(grid, placed, remaining, holder, rng, 5);

    const candidate = finalizeSnapshot(holder.best, seed, difficulty);
    if (!best || comparePuzzles(candidate, best) > 0) best = candidate;

    if (now() - lastProgress > 220) {
      onProgress({
        wordsPlaced: best?.words.length || 1,
        intersections: best?.stats.intersections || 0,
        attempt
      });
      lastProgress = now();
    }

    // Só encerra cedo quando a meta de quantidade E de entrelaçamento já está boa.
    if (meetsQualityTarget(best, targetWords)) break;
  }

  if (!best) throw new Error("Não foi possível criar uma grade conectada.");

  // Segunda etapa: trata o retângulo obtido como um template e tenta preenchê-lo
  // com palavras adicionais, favorecendo encaixes que não aumentem a moldura.
  // É aqui que os coringas curtos passam a ser especialmente úteis.
  if (now() < globalDeadline && best.words.length < maxFinalWords) {
    const densePool = buildDensePool(filtered, difficulty);
    best = densifyPuzzle(best, densePool, {
      maxWords: Math.max(targetWords, maxFinalWords),
      maxCols,
      maxRows,
      deadline: globalDeadline,
      rng
    });
  }

  return best;
}

function meetsQualityTarget(puzzle, targetWords) {
  if (!puzzle) return false;
  const target = Math.min(targetWords, puzzle.words.length);
  return (
    puzzle.words.length >= targetWords &&
    puzzle.stats.intersections >= Math.max(11, Math.floor(target * 0.72)) &&
    puzzle.stats.multiCrossWords >= Math.max(3, Math.floor(target * 0.18)) &&
    puzzle.stats.density >= 0.29 &&
    puzzle.stats.aspect <= 2.45
  );
}

function buildCandidatePool(words, difficulty, limit, rng) {
  const weighted = words.map((word) => {
    const diffWeight = difficultyWeight(word.dificuldade, difficulty);
    const length = word.resposta.length;
    const lengthWeight = wordLengthWeight(length);
    const wildcardWeight = word.tema === "Coringa" ? 1.08 : 1;
    const randomKey = -Math.log(Math.max(1e-9, rng())) /
      Math.max(0.02, diffWeight * lengthWeight * wildcardWeight);

    return {
      id: word.id,
      answer: word.resposta,
      display: word.exibicao,
      clue: word.dica,
      theme: word.tema,
      subtheme: word.subtema,
      difficulty: word.dificuldade,
      key: randomKey
    };
  });

  const themed = weighted.filter((word) => word.theme !== "Coringa").sort((a, b) => a.key - b.key);
  const fillers = weighted.filter((word) => word.theme === "Coringa").sort((a, b) => a.key - b.key);

  // O banco coringa é grande de propósito, mas não pode dominar o conteúdo.
  // Aproximadamente 1/3 do conjunto de busca fica reservado aos conectores.
  const fillerTarget = Math.min(fillers.length, Math.max(14, Math.floor(limit * 0.34)));
  const themedTarget = Math.min(themed.length, Math.max(0, limit - fillerTarget));
  const selected = [
    ...themed.slice(0, themedTarget),
    ...fillers.slice(0, fillerTarget)
  ];

  if (selected.length < limit) {
    const used = new Set(selected.map((word) => word.id));
    const rest = weighted
      .filter((word) => !used.has(word.id))
      .sort((a, b) => a.key - b.key);
    selected.push(...rest.slice(0, limit - selected.length));
  }

  return selected;
}

function buildDensePool(words, difficulty) {
  return words
    .filter((word) => word.resposta.length >= 3 && word.resposta.length <= 17)
    .map((word) => ({
      id: word.id,
      answer: word.resposta,
      display: word.exibicao,
      clue: word.dica,
      theme: word.tema,
      subtheme: word.subtema,
      difficulty: word.dificuldade,
      denseWeight:
        difficultyWeight(word.dificuldade, difficulty) *
        (word.tema === "Coringa" ? 1.30 : 1) *
        (word.resposta.length <= 7 ? 1.18 : 1)
    }))
    .sort((a, b) => b.denseWeight - a.denseWeight || a.answer.length - b.answer.length);
}

function difficultyWeight(wordDifficulty, selectedDifficulty) {
  const matrix = {
    1: { 1: 1.0, 2: 0.68, 3: 0.36 },
    2: { 1: 0.82, 2: 1.0, 3: 0.72 },
    3: { 1: 0.48, 2: 0.78, 3: 1.0 }
  };
  return matrix[selectedDifficulty]?.[wordDifficulty] ?? 0.5;
}

function wordLengthWeight(length) {
  // Para uma cruzadinha densa, respostas curtas e médias são muito mais úteis.
  // As longas continuam possíveis, mas deixam de dominar o conjunto candidato.
  if (length <= 3) return 1.55;
  if (length <= 5) return 1.72;
  if (length <= 8) return 1.38;
  if (length <= 10) return 1.18;
  if (length <= 12) return 0.92;
  if (length <= 14) return 0.70;
  if (length <= 17) return 0.52;
  if (length <= 21) return 0.30;
  return 0.14;
}

function compatibilityScores(words) {
  const letterCounts = new Map(words.map((word) => [word.id, letterHistogram(word.answer)]));
  const scores = new Map();

  for (const word of words) {
    let score = 0;
    const own = letterCounts.get(word.id);

    for (const other of words) {
      if (other.id === word.id) continue;
      const shared = sharedLetterPotential(own, letterCounts.get(other.id));
      if (shared > 0) score += 1 + Math.min(5, shared) * 0.5;
    }

    score -= Math.max(0, word.answer.length - 18) * 0.20;
    scores.set(word.id, score);
  }

  return scores;
}

function chooseSeedWord(words, compatibility, rng, attempt) {
  if (!words.length) return null;
  const ranked = words.slice().sort((a, b) => {
    const scoreDiff = (compatibility.get(b.id) || 0) - (compatibility.get(a.id) || 0);
    if (scoreDiff) return scoreDiff;
    return a.answer.length - b.answer.length;
  });

  // Varia o início entre várias palavras muito compatíveis para que os reinícios
  // explorem topologias realmente diferentes.
  const windowSize = Math.min(ranked.length, 7 + (attempt % 7));
  return ranked[Math.floor(rng() * windowSize)];
}

function search(grid, placed, remaining, holder, rng, skipsLeft) {
  holder.nodes += 1;
  if (isBetterState(grid, placed, holder.best)) holder.best = snapshotState(grid, placed);

  if (
    placed.length >= holder.target ||
    now() >= holder.deadline ||
    holder.nodes >= holder.maxNodes ||
    remaining.length === 0
  ) return;

  const gridLetters = new Set([...grid.values()].map((cell) => cell.letter));
  const likely = remaining
    .map((word) => ({ word, overlapPotential: countSharedLetters(word.answer, gridLetters) }))
    .filter((item) => item.overlapPotential > 0)
    .sort((a, b) => {
      if (b.overlapPotential !== a.overlapPotential) return b.overlapPotential - a.overlapPotential;
      return a.word.answer.length - b.word.answer.length;
    })
    .slice(0, 40);

  if (!likely.length) return;

  const infos = [];
  for (const item of likely) {
    if (now() >= holder.deadline) return;
    const placements = findPlacements(grid, item.word, holder.maxCols, holder.maxRows);
    if (!placements.length) continue;

    let maxIntersections = 0;
    let bestPlacementScore = -Infinity;
    for (const placement of placements) {
      maxIntersections = Math.max(maxIntersections, placement.intersections);
      bestPlacementScore = Math.max(bestPlacementScore, placement.score);
    }

    infos.push({
      ...item,
      placements,
      maxIntersections,
      bestPlacementScore
    });
  }

  if (!infos.length) return;

  // Em vez de escolher apenas UMA próxima palavra, exploramos algumas das melhores.
  // Isso corrige o principal gargalo da versão anterior e aumenta muito a chance de
  // chegar a 15–18 palavras sem transformar a grade em uma simples "árvore".
  infos.sort((a, b) => candidateChoiceScore(b) - candidateChoiceScore(a));

  const wordChoiceLimit = Math.min(4, infos.length);

  for (let wordIndex = 0; wordIndex < wordChoiceLimit; wordIndex += 1) {
    if (now() >= holder.deadline || holder.nodes >= holder.maxNodes) return;

    // Pequena variação entre opções próximas, útil entre tentativas.
    const pickIndex = wordIndex === 0
      ? 0
      : Math.min(infos.length - 1, wordIndex + (rng() < 0.22 ? 1 : 0));
    const chosen = infos[pickIndex];

    chosen.placements.sort((a, b) => {
      // Prioridade explícita para posições com dois ou mais cruzamentos.
      const ai = a.intersections >= 2 ? 95 : 0;
      const bi = b.intersections >= 2 ? 95 : 0;
      return (b.score + bi + rng() * 5) - (a.score + ai + rng() * 5);
    });

    const placementLimit = Math.min(12, chosen.placements.length);
    const rest = remaining.filter((word) => word.id !== chosen.word.id);

    for (let i = 0; i < placementLimit; i += 1) {
      if (now() >= holder.deadline || holder.nodes >= holder.maxNodes) return;

      const placement = chosen.placements[i];
      const changes = placeWord(grid, placed, chosen.word, placement.row, placement.col, placement.direction);
      search(grid, placed, rest, holder, rng, skipsLeft);
      undoPlacement(grid, placed, changes);
    }
  }

  // Ainda permite ignorar uma palavra ruim para que uma região promissora da busca
  // não morra apenas porque os candidatos mais óbvios ficaram sem espaço.
  if (skipsLeft > 0 && now() < holder.deadline) {
    const skipped = infos[0]?.word;
    if (skipped) {
      const rest = remaining.filter((word) => word.id !== skipped.id);
      search(grid, placed, rest, holder, rng, skipsLeft - 1);
    }
  }
}

function candidateChoiceScore(info) {
  const constrainedBonus = 28 / Math.max(1, Math.sqrt(info.placements.length));
  const multiCrossBonus = info.maxIntersections >= 2 ? 150 + info.maxIntersections * 55 : 0;
  const lengthPenalty = Math.max(0, info.word.answer.length - 18) * 2.5;

  return (
    info.overlapPotential * 18 +
    info.maxIntersections * 110 +
    multiCrossBonus +
    constrainedBonus +
    Math.min(180, info.bestPlacementScore * 0.18) -
    lengthPenalty
  );
}

function findPlacements(grid, word, maxCols, maxRows) {
  const placements = [];
  const seen = new Set();
  const bounds = getBounds(grid);

  for (const cell of grid.values()) {
    for (let index = 0; index < word.answer.length; index += 1) {
      if (word.answer[index] !== cell.letter) continue;

      const possibilities = [
        { direction: "across", row: cell.row, col: cell.col - index },
        { direction: "down", row: cell.row - index, col: cell.col }
      ];

      for (const candidate of possibilities) {
        const signature = `${candidate.direction}:${candidate.row}:${candidate.col}`;
        if (seen.has(signature)) continue;
        seen.add(signature);

        const valid = validatePlacement(
          grid,
          word,
          candidate.row,
          candidate.col,
          candidate.direction,
          true,
          maxCols,
          maxRows
        );
        if (!valid.ok) continue;

        placements.push({
          ...candidate,
          intersections: valid.intersections,
          score: scorePlacement(
            bounds,
            word,
            candidate.row,
            candidate.col,
            candidate.direction,
            valid.intersections
          )
        });
      }
    }
  }

  return placements;
}

function validatePlacement(grid, word, row, col, direction, requireCross, maxCols = Infinity, maxRows = Infinity) {
  const dr = direction === "down" ? 1 : 0;
  const dc = direction === "across" ? 1 : 0;
  const currentBounds = getBounds(grid);
  const endRow = row + dr * (word.answer.length - 1);
  const endCol = col + dc * (word.answer.length - 1);
  const proposedWidth = Math.max(currentBounds.maxCol, col, endCol) - Math.min(currentBounds.minCol, col, endCol) + 1;
  const proposedHeight = Math.max(currentBounds.maxRow, row, endRow) - Math.min(currentBounds.minRow, row, endRow) + 1;

  if (proposedWidth > maxCols || proposedHeight > maxRows) {
    return { ok: false, intersections: 0 };
  }

  const beforeKey = keyOf(row - dr, col - dc);
  const afterKey = keyOf(row + dr * word.answer.length, col + dc * word.answer.length);

  // Impede que uma palavra seja extensão acidental de outra.
  if (grid.has(beforeKey) || grid.has(afterKey)) return { ok: false, intersections: 0 };

  let intersections = 0;

  for (let i = 0; i < word.answer.length; i += 1) {
    const r = row + dr * i;
    const c = col + dc * i;
    const key = keyOf(r, c);
    const existing = grid.get(key);
    const letter = word.answer[i];

    if (existing) {
      if (existing.letter !== letter) return { ok: false, intersections: 0 };
      if (direction === "across" && existing.acrossId != null) return { ok: false, intersections: 0 };
      if (direction === "down" && existing.downId != null) return { ok: false, intersections: 0 };
      intersections += 1;
      continue;
    }

    // Letras novas não podem encostar perpendicularmente em outras letras.
    if (direction === "across") {
      if (grid.has(keyOf(r - 1, c)) || grid.has(keyOf(r + 1, c))) {
        return { ok: false, intersections: 0 };
      }
    } else if (grid.has(keyOf(r, c - 1)) || grid.has(keyOf(r, c + 1))) {
      return { ok: false, intersections: 0 };
    }
  }

  if (requireCross && intersections === 0) return { ok: false, intersections: 0 };
  return { ok: true, intersections };
}

function scorePlacement(bounds, word, row, col, direction, intersections) {
  const endRow = row + (direction === "down" ? word.answer.length - 1 : 0);
  const endCol = col + (direction === "across" ? word.answer.length - 1 : 0);
  const minRow = Math.min(bounds.minRow, row, endRow);
  const maxRow = Math.max(bounds.maxRow, row, endRow);
  const minCol = Math.min(bounds.minCol, col, endCol);
  const maxCol = Math.max(bounds.maxCol, col, endCol);
  const height = maxRow - minRow + 1;
  const width = maxCol - minCol + 1;
  const area = width * height;
  const growth = Math.max(0, area - bounds.width * bounds.height);
  const aspect = Math.max(width / height, height / width);
  const centerDistance = Math.abs((row + endRow) / 2) + Math.abs((col + endCol) / 2);
  const multiCrossBonus = intersections >= 2 ? 150 + intersections * 45 : 0;

  return (
    intersections * 260 +
    multiCrossBonus -
    growth * 1.65 -
    Math.max(0, aspect - 1.7) * 24 -
    centerDistance * 0.32
  );
}

function placeWord(grid, placed, word, row, col, direction) {
  const dr = direction === "down" ? 1 : 0;
  const dc = direction === "across" ? 1 : 0;
  const changes = [];

  for (let i = 0; i < word.answer.length; i += 1) {
    const r = row + dr * i;
    const c = col + dc * i;
    const key = keyOf(r, c);
    const previous = grid.get(key);
    changes.push({ key, previous: previous ? { ...previous } : null });

    const next = previous
      ? { ...previous }
      : { row: r, col: c, letter: word.answer[i], acrossId: null, downId: null };

    if (direction === "across") next.acrossId = word.id;
    else next.downId = word.id;
    grid.set(key, next);
  }

  placed.push({
    id: word.id,
    answer: word.answer,
    display: word.display,
    clue: word.clue,
    theme: word.theme,
    subtheme: word.subtheme,
    difficulty: word.difficulty,
    row,
    col,
    direction
  });

  return changes;
}

function undoPlacement(grid, placed, changes) {
  placed.pop();
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i];
    if (change.previous) grid.set(change.key, change.previous);
    else grid.delete(change.key);
  }
}

function snapshotState(grid, placed) {
  const cells = [...grid.values()].map((cell) => ({ ...cell }));
  const placedCopy = placed.map((word) => ({ ...word }));
  return { cells, placed: placedCopy, stats: stateStats(cells, placedCopy) };
}

function isBetterState(grid, placed, previousBest) {
  if (!previousBest) return true;
  if (placed.length !== previousBest.placed.length) return placed.length > previousBest.placed.length;
  const stats = stateStats([...grid.values()], placed);
  return stats.score > previousBest.stats.score;
}

function stateStats(cells, placed) {
  const bounds = getBoundsFromCells(cells);
  const intersections = cells.filter((cell) => cell.acrossId != null && cell.downId != null).length;
  const area = bounds.width * bounds.height;
  const density = area ? cells.length / area : 0;
  const aspect = Math.max(bounds.width / bounds.height, bounds.height / bounds.width);
  const multiCrossWords = countWordsWithMultipleCrosses(cells, placed);

  const score =
    placed.length * 100000 +
    intersections * 900 +
    multiCrossWords * 420 +
    density * 2300 -
    area * 2.35 -
    Math.max(0, aspect - 1.55) * 420;

  return {
    intersections,
    density,
    area,
    width: bounds.width,
    height: bounds.height,
    aspect,
    multiCrossWords,
    score
  };
}

function countWordsWithMultipleCrosses(cells, placed) {
  const counts = new Map(placed.map((word) => [word.id, 0]));
  for (const cell of cells) {
    if (cell.acrossId != null && cell.downId != null) {
      counts.set(cell.acrossId, (counts.get(cell.acrossId) || 0) + 1);
      counts.set(cell.downId, (counts.get(cell.downId) || 0) + 1);
    }
  }
  return [...counts.values()].filter((count) => count >= 2).length;
}

function densifyPuzzle(puzzle, pool, options) {
  const grid = new Map();
  for (const cell of puzzle.cells) {
    grid.set(keyOf(cell.row, cell.col), {
      row: cell.row,
      col: cell.col,
      letter: cell.letter,
      acrossId: cell.acrossId ?? null,
      downId: cell.downId ?? null
    });
  }

  const placed = puzzle.words.map((word) => ({
    id: word.id,
    answer: word.answer,
    display: word.display,
    clue: word.clue,
    theme: word.theme,
    subtheme: word.subtheme,
    difficulty: word.difficulty,
    row: word.row,
    col: word.col,
    direction: word.direction
  }));

  const used = new Set(placed.map((word) => word.id));
  const remaining = pool.filter((word) => !used.has(word.id));

  const holder = {
    best: snapshotState(grid, placed),
    nodes: 0,
    maxNodes: 9000,
    deadline: options.deadline,
    maxWords: options.maxWords,
    maxCols: options.maxCols,
    maxRows: options.maxRows
  };

  denseFillSearch(grid, placed, remaining, holder, options.rng, 0);
  return finalizeSnapshot(holder.best, puzzle.seed, puzzle.selectedDifficulty);
}

function denseFillSearch(grid, placed, remaining, holder, rng, depth) {
  holder.nodes += 1;

  const current = snapshotState(grid, placed);
  if (isBetterDenseState(current, holder.best)) holder.best = current;

  if (
    placed.length >= holder.maxWords ||
    remaining.length === 0 ||
    holder.nodes >= holder.maxNodes ||
    now() >= holder.deadline
  ) return;

  const bounds = getBounds(grid);
  const currentArea = bounds.width * bounds.height;
  const currentDensity = grid.size / Math.max(1, currentArea);
  const gridLetters = new Set([...grid.values()].map((cell) => cell.letter));

  const likely = remaining
    .map((word) => ({
      word,
      overlapPotential: countSharedLetters(word.answer, gridLetters)
    }))
    .filter((item) => item.overlapPotential > 0 && item.word.answer.length <= 13)
    .sort((a, b) => {
      const aShort = a.word.answer.length <= 7 ? 1 : 0;
      const bShort = b.word.answer.length <= 7 ? 1 : 0;
      return (
        bShort - aShort ||
        b.overlapPotential - a.overlapPotential ||
        b.word.denseWeight - a.word.denseWeight ||
        a.word.answer.length - b.word.answer.length
      );
    })
    .slice(0, 42);

  const choices = [];

  for (const item of likely) {
    if (now() >= holder.deadline) return;

    const placements = findPlacements(
      grid,
      item.word,
      holder.maxCols,
      holder.maxRows
    );

    const scored = [];
    for (const placement of placements) {
      const quality = densePlacementQuality(
        grid,
        bounds,
        currentDensity,
        item.word,
        placement
      );

      // Na fase de densificação, crescimento grande quase nunca compensa.
      const growthLimit = placed.length < holder.maxWords - 2 ? 8 : 3;
      if (quality.growth > growthLimit) continue;

      // Depois de algumas inserções exigimos encaixes mais fortes: isso evita
      // criar novos "braços" só para aumentar artificialmente a contagem.
      if (depth >= 2 && placement.intersections < 2 && quality.growth > 0) continue;

      scored.push({ ...placement, denseScore: quality.score });
    }

    if (!scored.length) continue;
    scored.sort((a, b) => b.denseScore - a.denseScore);

    choices.push({
      word: item.word,
      placements: scored.slice(0, 6),
      score: scored[0].denseScore + item.overlapPotential * 45
    });
  }

  if (!choices.length) return;
  choices.sort((a, b) => b.score - a.score);

  const wordLimit = Math.min(5, choices.length);
  for (let wi = 0; wi < wordLimit; wi += 1) {
    if (now() >= holder.deadline || holder.nodes >= holder.maxNodes) return;

    const choice = choices[wi];
    const rest = remaining.filter((word) => word.id !== choice.word.id);
    const placementLimit = Math.min(5, choice.placements.length);

    for (let pi = 0; pi < placementLimit; pi += 1) {
      const placement = choice.placements[pi];
      const changes = placeWord(
        grid,
        placed,
        choice.word,
        placement.row,
        placement.col,
        placement.direction
      );

      denseFillSearch(grid, placed, rest, holder, rng, depth + 1);
      undoPlacement(grid, placed, changes);

      if (holder.best.placed.length >= holder.maxWords) return;
    }
  }
}

function densePlacementQuality(grid, bounds, currentDensity, word, placement) {
  const dr = placement.direction === "down" ? 1 : 0;
  const dc = placement.direction === "across" ? 1 : 0;
  const endRow = placement.row + dr * (word.answer.length - 1);
  const endCol = placement.col + dc * (word.answer.length - 1);

  const minRow = Math.min(bounds.minRow, placement.row, endRow);
  const maxRow = Math.max(bounds.maxRow, placement.row, endRow);
  const minCol = Math.min(bounds.minCol, placement.col, endCol);
  const maxCol = Math.max(bounds.maxCol, placement.col, endCol);
  const newArea = (maxRow - minRow + 1) * (maxCol - minCol + 1);
  const currentArea = bounds.width * bounds.height;
  const growth = Math.max(0, newArea - currentArea);
  const newCells = word.answer.length - placement.intersections;
  const nextDensity = (grid.size + newCells) / Math.max(1, newArea);
  const densityGain = nextDensity - currentDensity;

  const score =
    placement.intersections * 620 +
    (placement.intersections >= 2 ? 520 + placement.intersections * 120 : 0) +
    densityGain * 12000 +
    (growth === 0 ? 520 : 0) +
    (word.theme === "Coringa" ? 70 : 0) +
    (word.answer.length <= 7 ? 90 : 0) -
    growth * 135;

  return { score, growth, nextDensity };
}

function isBetterDenseState(candidate, previous) {
  if (!previous) return true;

  if (candidate.placed.length !== previous.placed.length) {
    return candidate.placed.length > previous.placed.length;
  }

  if (candidate.stats.density !== previous.stats.density) {
    return candidate.stats.density > previous.stats.density;
  }

  if (candidate.stats.intersections !== previous.stats.intersections) {
    return candidate.stats.intersections > previous.stats.intersections;
  }

  return candidate.stats.multiCrossWords > previous.stats.multiCrossWords;
}

function finalizeSnapshot(snapshot, seed, selectedDifficulty) {
  const bounds = getBoundsFromCells(snapshot.cells);
  const rowShift = -bounds.minRow;
  const colShift = -bounds.minCol;

  const words = snapshot.placed.map((word) => ({
    ...word,
    row: word.row + rowShift,
    col: word.col + colShift
  }));

  const cells = snapshot.cells.map((cell) => ({
    ...cell,
    row: cell.row + rowShift,
    col: cell.col + colShift
  }));

  assignNumbers(words, cells);
  words.sort((a, b) => a.number - b.number || a.direction.localeCompare(b.direction));
  cells.sort((a, b) => a.row - b.row || a.col - b.col);

  return {
    seed,
    selectedDifficulty,
    rows: bounds.height,
    cols: bounds.width,
    cells,
    words,
    stats: {
      intersections: snapshot.stats.intersections,
      density: Number(snapshot.stats.density.toFixed(3)),
      area: snapshot.stats.area,
      width: snapshot.stats.width,
      height: snapshot.stats.height,
      aspect: Number(snapshot.stats.aspect.toFixed(3)),
      multiCrossWords: snapshot.stats.multiCrossWords,
      score: Math.round(snapshot.stats.score)
    }
  };
}

function assignNumbers(words, cells) {
  const starts = new Map();
  for (const word of words) {
    const key = keyOf(word.row, word.col);
    if (!starts.has(key)) starts.set(key, []);
    starts.get(key).push(word);
  }

  const ordered = [...starts.entries()]
    .map(([key, startingWords]) => {
      const [row, col] = key.split(",").map(Number);
      return { key, row, col, startingWords };
    })
    .sort((a, b) => a.row - b.row || a.col - b.col);

  const numberByKey = new Map();
  ordered.forEach((item, index) => {
    const number = index + 1;
    numberByKey.set(item.key, number);
    item.startingWords.forEach((word) => { word.number = number; });
  });

  for (const cell of cells) cell.number = numberByKey.get(keyOf(cell.row, cell.col)) || null;
}

function comparePuzzles(a, b) {
  if (a.words.length !== b.words.length) return a.words.length - b.words.length;
  if (a.stats.intersections !== b.stats.intersections) {
    return a.stats.intersections - b.stats.intersections;
  }
  if (a.stats.multiCrossWords !== b.stats.multiCrossWords) {
    return a.stats.multiCrossWords - b.stats.multiCrossWords;
  }
  return a.stats.score - b.stats.score;
}

function countSharedLetters(answer, letterSet) {
  let count = 0;
  const seen = new Set();
  for (const letter of answer) {
    if (!seen.has(letter) && letterSet.has(letter)) {
      seen.add(letter);
      count += 1;
    }
  }
  return count;
}

function letterHistogram(answer) {
  const map = new Map();
  for (const letter of answer) map.set(letter, (map.get(letter) || 0) + 1);
  return map;
}

function sharedLetterPotential(a, b) {
  let shared = 0;
  for (const [letter, count] of a) {
    if (b.has(letter)) shared += Math.min(count, b.get(letter));
  }
  return shared;
}

function getBounds(grid) {
  return getBoundsFromCells([...grid.values()]);
}

function getBoundsFromCells(cells) {
  if (!cells.length) {
    return { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0, width: 1, height: 1 };
  }

  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;

  for (const cell of cells) {
    minRow = Math.min(minRow, cell.row);
    maxRow = Math.max(maxRow, cell.row);
    minCol = Math.min(minCol, cell.col);
    maxCol = Math.max(maxCol, cell.col);
  }

  return {
    minRow,
    maxRow,
    minCol,
    maxCol,
    width: maxCol - minCol + 1,
    height: maxRow - minRow + 1
  };
}

function keyOf(row, col) {
  return `${row},${col}`;
}

function makeRng(seed) {
  let state = seed || 0x9e3779b9;
  return function random() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

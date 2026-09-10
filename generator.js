/**
 * Gerador de cruzadinhas sem dependência de DOM.
 * Pode ser executado em Web Worker ou testado diretamente.
 */
export function generateCrossword(allWords, options = {}, onProgress = () => {}) {
  const {
    theme = "__ALL__",
    allThemesValue = "__ALL__",
    difficulty = 2,
    seed = Date.now(),
    targetWords = 14,
    maxCandidates = 52,
    timeBudgetMs = 1700
  } = options;

  const rng = makeRng(seed >>> 0);
  const filtered = allWords.filter((word) => theme === allThemesValue || word.tema === theme);
  if (filtered.length < 6) throw new Error("Poucas palavras disponíveis para esse tema.");

  const deadline = now() + Math.max(450, timeBudgetMs);
  let best = null;
  let attempt = 0;
  let lastProgress = 0;

  while (now() < deadline) {
    attempt += 1;

    const candidates = buildCandidatePool(filtered, difficulty, maxCandidates, rng);
    if (candidates.length < 6) break;

    const compatibility = compatibilityScores(candidates);
    const seedWord = chooseSeedWord(candidates, compatibility, rng, attempt);

    const grid = new Map();
    const placed = [];
    placeWord(grid, placed, seedWord, 0, 0, "across");

    const remaining = candidates.filter((word) => word.id !== seedWord.id);
    const holder = {
      best: snapshotState(grid, placed),
      nodes: 0,
      target: Math.min(targetWords, candidates.length),
      deadline,
      maxNodes: 3000 + Math.min(2000, attempt * 140)
    };

    search(grid, placed, remaining, holder, rng, 6);

    const candidate = finalizeSnapshot(holder.best, seed, difficulty);
    if (!best || comparePuzzles(candidate, best) > 0) best = candidate;

    if (meetsQualityTarget(best, targetWords)) break;

    if (now() - lastProgress > 250) {
      onProgress({
        wordsPlaced: best?.words.length || 1,
        intersections: best?.stats.intersections || 0,
        attempt
      });
      lastProgress = now();
    }
  }

  if (!best) throw new Error("Não foi possível criar uma grade conectada.");
  return best;
}

function meetsQualityTarget(puzzle, targetWords) {
  if (!puzzle) return false;
  return (
    puzzle.words.length >= targetWords &&
    puzzle.stats.intersections >= Math.max(6, Math.floor(targetWords * 0.5)) &&
    puzzle.stats.density >= 0.36 &&
    puzzle.stats.aspect <= 2.35
  );
}

function buildCandidatePool(words, difficulty, limit, rng) {
  const weighted = words.map((word) => {
    const diffWeight = difficultyWeight(word.dificuldade, difficulty);
    const length = word.resposta.length;
    const lengthWeight = wordLengthWeight(length);
    const randomKey = -Math.log(Math.max(1e-9, rng())) / Math.max(0.02, diffWeight * lengthWeight);

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

  weighted.sort((a, b) => a.key - b.key);
  return weighted.slice(0, Math.min(limit, weighted.length));
}

function difficultyWeight(wordDifficulty, selectedDifficulty) {
  const matrix = {
    1: { 1: 1.0, 2: 0.30, 3: 0.07 },
    2: { 1: 0.42, 2: 1.0, 3: 0.38 },
    3: { 1: 0.12, 2: 0.48, 3: 1.0 }
  };
  return matrix[selectedDifficulty]?.[wordDifficulty] ?? 0.5;
}

function wordLengthWeight(length) {
  if (length <= 3) return 0.45;
  if (length >= 30) return 0.16;
  if (length >= 25) return 0.28;
  if (length >= 20) return 0.52;
  if (length >= 16) return 0.78;
  return 1;
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
      if (shared > 0) score += 1 + Math.min(4, shared) * 0.4;
    }

    score -= Math.max(0, word.answer.length - 20) * 0.18;
    scores.set(word.id, score);
  }

  return scores;
}

function chooseSeedWord(words, compatibility, rng, attempt) {
  const ranked = words.slice().sort((a, b) => {
    const scoreDiff = (compatibility.get(b.id) || 0) - (compatibility.get(a.id) || 0);
    if (scoreDiff) return scoreDiff;
    return a.answer.length - b.answer.length;
  });

  const windowSize = Math.min(ranked.length, 6 + (attempt % 6));
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
    .slice(0, 18);

  if (!likely.length) return;

  const infos = [];
  for (const item of likely) {
    if (now() >= holder.deadline) return;
    const placements = findPlacements(grid, item.word);
    if (placements.length) infos.push({ ...item, placements });
  }
  if (!infos.length) return;

  // "Most constrained first": menos posições possíveis, ponderando potencial de cruzamento.
  infos.sort((a, b) => {
    const ac = a.placements.length - a.overlapPotential * 0.4;
    const bc = b.placements.length - b.overlapPotential * 0.4;
    return ac - bc;
  });

  const choiceWindow = Math.min(3, infos.length);
  const chosen = infos[Math.floor(rng() * choiceWindow)];
  chosen.placements.sort((a, b) => (b.score + rng() * 7) - (a.score + rng() * 7));

  const placementLimit = Math.min(12, chosen.placements.length);
  const rest = remaining.filter((word) => word.id !== chosen.word.id);

  for (let i = 0; i < placementLimit; i += 1) {
    if (now() >= holder.deadline || holder.nodes >= holder.maxNodes) return;

    const placement = chosen.placements[i];
    const changes = placeWord(grid, placed, chosen.word, placement.row, placement.col, placement.direction);
    search(grid, placed, rest, holder, rng, skipsLeft);
    undoPlacement(grid, placed, changes);

    if (holder.best.placed.length >= holder.target) return;
  }

  // Permite pular uma palavra problemática sem abandonar a tentativa inteira.
  if (skipsLeft > 0 && now() < holder.deadline) {
    search(grid, placed, rest, holder, rng, skipsLeft - 1);
  }
}

function findPlacements(grid, word) {
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

        const valid = validatePlacement(grid, word, candidate.row, candidate.col, candidate.direction, true);
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

function validatePlacement(grid, word, row, col, direction, requireCross) {
  const dr = direction === "down" ? 1 : 0;
  const dc = direction === "across" ? 1 : 0;
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

  return (
    intersections * 150 -
    growth * 2.0 -
    Math.max(0, aspect - 1.65) * 28 -
    centerDistance * 0.45
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
    intersections * 520 +
    multiCrossWords * 160 +
    density * 2800 -
    area * 3.2 -
    Math.max(0, aspect - 1.5) * 550;

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

"use strict";

self.onmessage = event => {
  const data = event.data || {};
  if (data.type !== "generate") return;

  try {
    const puzzle = generateDenseCrossword(data.words || [], data.options || {});

    if (!puzzle) {
      self.postMessage({
        type: "error",
        message:
          "Não encontrei uma grade densa completa dentro do tempo disponível. " +
          "Tente novamente. Se isso ocorrer com frequência, o banco ainda precisa de mais palavras curtas e médias com letras variadas."
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

function generateDenseCrossword(rawWords, options) {
  const minWords = Math.max(30, Number(options.minWords) || 30);
  const preferredWords = Math.max(minWords, Number(options.preferredWords) || 44);
  const maxBlackRatio = Math.min(0.30, Math.max(0.12, Number(options.maxBlackRatio) || 0.26));
  const totalBudget = Math.max(5000, Number(options.timeBudgetMs) || 14000);
  const rng = mulberry32(Number(options.seed) || Date.now());
  const start = performance.now();
  const deadline = start + totalBudget;

  const words = normalizeWords(rawWords);
  const pools = buildPools(words);
  const maxLength = Math.max(...pools.keys());

  if (words.length < minWords) {
    throw new Error(`O banco possui apenas ${words.length} respostas válidas; são necessárias pelo menos ${minWords}.`);
  }

  postProgress(`Banco carregado: ${words.length} respostas únicas. Preparando templates…`);

  const phases = [
    { sizes: [15], minBlack: 0.14, maxBlack: Math.min(0.20, maxBlackRatio), targetWords: preferredWords + 8 },
    { sizes: [15, 13], minBlack: 0.18, maxBlack: Math.min(0.23, maxBlackRatio), targetWords: preferredWords },
    { sizes: [13, 15], minBlack: 0.21, maxBlack: maxBlackRatio, targetWords: Math.max(minWords + 4, preferredWords - 6) }
  ];

  let templateAttempt = 0;
  let bestStructural = null;

  for (const phase of phases) {
    if (performance.now() >= deadline) break;

    for (const size of phase.sizes) {
      if (performance.now() >= deadline) break;
      if (size > maxLength && !hasEnoughShortWords(pools, size)) continue;

      const candidates = [];
      const generationCount = 34;

      for (let i = 0; i < generationCount; i++) {
        if (performance.now() >= deadline) break;

        const targetBlack = randomBetween(rng, phase.minBlack, phase.maxBlack);
        const pattern = createPattern(size, targetBlack, rng);
        if (!pattern) continue;

        const analysis = analyzePattern(pattern);
        if (!analysis.connected || analysis.singleRuns > 0) continue;
        if (analysis.blackRatio > maxBlackRatio) continue;
        if (analysis.slots.length < minWords) continue;
        if (analysis.slots.length > 72) continue;
        if (!inventoryCanSupport(analysis.slots, pools)) continue;

        const structuralScore = scorePattern(
          analysis,
          phase.targetWords,
          pools,
          maxBlackRatio
        );

        candidates.push({ pattern, analysis, structuralScore });

        if (!bestStructural || structuralScore > bestStructural.structuralScore) {
          bestStructural = { pattern, analysis, structuralScore };
        }
      }

      candidates.sort((a, b) => b.structuralScore - a.structuralScore);

      const toTry = candidates.slice(0, 7);

      for (const candidate of toTry) {
        if (performance.now() >= deadline) break;

        templateAttempt++;
        const elapsed = Math.round(performance.now() - start);

        postProgress(
          `Tentativa ${templateAttempt}: ${candidate.analysis.slots.length} palavras, ` +
          `${Math.round(candidate.analysis.blackRatio * 100)}% pretos · ${elapsed} ms`
        );

        const remaining = deadline - performance.now();
        const solveBudget = Math.max(650, Math.min(2600, remaining * 0.45));
        const solution = solvePattern(
          candidate.pattern,
          candidate.analysis,
          pools,
          performance.now() + solveBudget,
          rng
        );

        if (solution) {
          postProgress(
            `Grade encontrada: ${solution.slots.length} palavras e ` +
            `${Math.round(solution.blackRatio * 100)}% de casas pretas.`
          );
          return solution;
        }
      }
    }
  }

  // Último recurso: usa alguns dos melhores templates estruturais com mais tempo.
  if (bestStructural && performance.now() < deadline) {
    postProgress("Última tentativa: aprofundando a busca no melhor template encontrado…");

    const solution = solvePattern(
      bestStructural.pattern,
      bestStructural.analysis,
      pools,
      deadline,
      rng
    );

    if (solution) return solution;
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

    if (resposta.length < 2 || !dica) continue;
    if (seen.has(resposta)) continue;

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

function buildPools(words) {
  const pools = new Map();

  for (const word of words) {
    const len = word.resposta.length;
    if (!pools.has(len)) pools.set(len, []);
    pools.get(len).push(word);
  }

  return pools;
}

function hasEnoughShortWords(pools, size) {
  let count = 0;
  for (let len = 2; len <= Math.min(size, 10); len++) {
    count += pools.get(len)?.length || 0;
  }
  return count >= 120;
}

/* =========================================================
   TEMPLATE DENSO
========================================================= */

function createPattern(size, targetBlackRatio, rng) {
  const grid = Array.from({ length: size }, () => Array(size).fill(false));
  const targetBlocks = Math.round(size * size * targetBlackRatio);
  const maxBlocks = Math.round(size * size * Math.min(0.30, targetBlackRatio + 0.06));
  const shapes = [
    [[0, 0]],
    [[0, 0], [0, 1]],
    [[0, 0], [1, 0]],
    [[0, 0], [0, 1], [1, 0], [1, 1]],
    [[0, 0], [0, 1], [0, 2]],
    [[0, 0], [1, 0], [2, 0]]
  ];

  let guard = 0;

  while (countBlocks(grid) < targetBlocks && guard < 250) {
    guard++;

    const shape = shapes[Math.floor(rng() * shapes.length)];
    const maxDr = Math.max(...shape.map(([dr]) => dr));
    const maxDc = Math.max(...shape.map(([, dc]) => dc));
    const r = Math.floor(rng() * Math.max(1, size - maxDr));
    const c = Math.floor(rng() * Math.max(1, size - maxDc));

    const cells = [];
    for (const [dr, dc] of shape) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= size || cc >= size) continue;
      cells.push([rr, cc]);
      cells.push([size - 1 - rr, size - 1 - cc]);
    }

    const unique = uniqueCells(cells);
    const newlyAdded = unique.filter(([rr, cc]) => !grid[rr][cc]);

    for (const [rr, cc] of newlyAdded) grid[rr][cc] = true;

    if (countBlocks(grid) > maxBlocks || !hasReasonableOpenArea(grid)) {
      for (const [rr, cc] of newlyAdded) grid[rr][cc] = false;
    }
  }

  if (!repairSingleRuns(grid, maxBlocks)) return null;
  if (!isWhiteConnected(grid)) return null;

  const blackRatio = countBlocks(grid) / (size * size);
  if (blackRatio > 0.30) return null;

  return grid.map(row => row.map(block => (block ? "#" : ".")).join(""));
}

function uniqueCells(cells) {
  const map = new Map();
  for (const [r, c] of cells) map.set(`${r},${c}`, [r, c]);
  return [...map.values()];
}

function countBlocks(grid) {
  let count = 0;
  for (const row of grid) {
    for (const block of row) if (block) count++;
  }
  return count;
}

function hasReasonableOpenArea(grid) {
  const size = grid.length;
  for (let r = 0; r < size; r++) {
    let open = 0;
    for (let c = 0; c < size; c++) if (!grid[r][c]) open++;
    if (open < Math.ceil(size * 0.45)) return false;
  }

  for (let c = 0; c < size; c++) {
    let open = 0;
    for (let r = 0; r < size; r++) if (!grid[r][c]) open++;
    if (open < Math.ceil(size * 0.45)) return false;
  }

  return true;
}

function repairSingleRuns(grid, maxBlocks) {
  const size = grid.length;

  for (let pass = 0; pass < 18; pass++) {
    const singles = findSingleRunCells(grid);
    if (!singles.length) return true;

    for (const [r, c] of singles) {
      grid[r][c] = true;
      grid[size - 1 - r][size - 1 - c] = true;
    }

    if (countBlocks(grid) > maxBlocks) return false;
  }

  return findSingleRunCells(grid).length === 0;
}

function findSingleRunCells(grid) {
  const size = grid.length;
  const singles = new Map();

  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (grid[r][c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < size && !grid[r][c]) c++;
      if (c - start === 1) singles.set(`${r},${start}`, [r, start]);
    }
  }

  for (let c = 0; c < size; c++) {
    let r = 0;
    while (r < size) {
      if (grid[r][c]) {
        r++;
        continue;
      }
      const start = r;
      while (r < size && !grid[r][c]) r++;
      if (r - start === 1) singles.set(`${start},${c}`, [start, c]);
    }
  }

  return [...singles.values()];
}

function isWhiteConnected(grid) {
  const size = grid.length;
  let start = null;
  let total = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!grid[r][c]) {
        total++;
        if (!start) start = [r, c];
      }
    }
  }

  if (!start) return false;

  const queue = [start];
  const seen = new Set([`${start[0]},${start[1]}`]);

  for (let head = 0; head < queue.length; head++) {
    const [r, c] = queue[head];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size || grid[nr][nc]) continue;
      const key = `${nr},${nc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nr, nc]);
    }
  }

  return seen.size === total;
}

function analyzePattern(pattern) {
  const rows = pattern.length;
  const cols = pattern[0].length;
  const slots = [];
  let singleRuns = 0;
  let black = 0;

  for (const row of pattern) {
    for (const ch of row) if (ch === "#") black++;
  }

  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (pattern[r][c] === "#") {
        c++;
        continue;
      }
      const start = c;
      while (c < cols && pattern[r][c] !== "#") c++;
      const len = c - start;
      if (len === 1) singleRuns++;
      if (len >= 2) {
        slots.push({
          id: `A${slots.length}`,
          direction: "across",
          length: len,
          cells: Array.from({ length: len }, (_, i) => r * cols + start + i)
        });
      }
    }
  }

  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      if (pattern[r][c] === "#") {
        r++;
        continue;
      }
      const start = r;
      while (r < rows && pattern[r][c] !== "#") r++;
      const len = r - start;
      if (len === 1) singleRuns++;
      if (len >= 2) {
        slots.push({
          id: `D${slots.length}`,
          direction: "down",
          length: len,
          cells: Array.from({ length: len }, (_, i) => (start + i) * cols + c)
        });
      }
    }
  }

  return {
    rows,
    cols,
    slots,
    singleRuns,
    connected: patternIsConnected(pattern),
    blackRatio: black / (rows * cols)
  };
}

function patternIsConnected(pattern) {
  const grid = pattern.map(row => [...row].map(ch => ch === "#"));
  return isWhiteConnected(grid);
}

function inventoryCanSupport(slots, pools) {
  const needed = new Map();

  for (const slot of slots) {
    needed.set(slot.length, (needed.get(slot.length) || 0) + 1);
  }

  for (const [len, count] of needed) {
    const available = pools.get(len)?.length || 0;
    if (available < count) return false;
  }

  return true;
}

function scorePattern(analysis, targetWords, pools, maxBlackRatio) {
  const slots = analysis.slots;
  let score = 1000;

  score -= Math.abs(slots.length - targetWords) * 4.5;
  score -= analysis.blackRatio * 430;

  if (analysis.blackRatio <= Math.min(0.20, maxBlackRatio)) score += 55;

  const lengths = slots.map(slot => slot.length);
  const shortMedium = lengths.filter(len => len >= 3 && len <= 8).length;
  const twos = lengths.filter(len => len === 2).length;
  const long = lengths.filter(len => len >= 11).length;

  score += shortMedium * 2.2;
  score -= Math.max(0, twos - Math.ceil(slots.length * 0.22)) * 3;
  score -= Math.max(0, long - Math.ceil(slots.length * 0.20)) * 2;

  for (const len of new Set(lengths)) {
    const need = lengths.filter(x => x === len).length;
    const available = pools.get(len)?.length || 0;
    const cushion = available - need;
    score += Math.min(12, cushion) * 0.22;
  }

  return score;
}

/* =========================================================
   SOLVER CSP / BACKTRACKING
========================================================= */

function solvePattern(pattern, analysis, pools, deadline, rng) {
  const rows = analysis.rows;
  const cols = analysis.cols;
  const slots = analysis.slots.map((slot, index) => ({
    ...slot,
    index,
    assigned: null,
    neighbors: new Set(),
    crossingPositions: []
  }));

  const cellSlots = Array.from({ length: rows * cols }, () => []);

  for (const slot of slots) {
    slot.cells.forEach((cellIndex, pos) => {
      cellSlots[cellIndex].push({ slotIndex: slot.index, pos });
    });
  }

  for (const entries of cellSlots) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        slots[a.slotIndex].neighbors.add(b.slotIndex);
        slots[b.slotIndex].neighbors.add(a.slotIndex);
        slots[a.slotIndex].crossingPositions.push({
          ownPos: a.pos,
          otherSlot: b.slotIndex,
          otherPos: b.pos
        });
        slots[b.slotIndex].crossingPositions.push({
          ownPos: b.pos,
          otherSlot: a.slotIndex,
          otherPos: a.pos
        });
      }
    }
  }

  const letters = Array(rows * cols).fill("");
  const useCount = Array(rows * cols).fill(0);
  const used = new Set();
  const cache = new Map();
  const frequencies = buildPositionFrequencies(pools);
  let nodes = 0;
  let timedOut = false;

  function recurse(remaining) {
    nodes++;
    if ((nodes & 255) === 0 && performance.now() >= deadline) {
      timedOut = true;
      return false;
    }

    if (remaining === 0) return true;

    let chosen = null;
    let chosenCandidates = null;
    let bestCount = Infinity;
    let bestDegree = -1;

    for (const slot of slots) {
      if (slot.assigned) continue;

      const candidates = compatibleCandidates(slot);
      const count = candidates.length;

      if (count === 0) return false;

      let degree = 0;
      for (const n of slot.neighbors) if (!slots[n].assigned) degree++;

      if (
        count < bestCount ||
        (count === bestCount && degree > bestDegree) ||
        (count === bestCount && degree === bestDegree && chosen && slot.length > chosen.length)
      ) {
        chosen = slot;
        chosenCandidates = candidates;
        bestCount = count;
        bestDegree = degree;
      }

      if (bestCount === 1 && bestDegree >= 2) break;
    }

    if (!chosen) return false;

    const ordered = orderCandidates(chosen, chosenCandidates, slots, frequencies, rng);
    const candidateLimit = Math.min(ordered.length, bestCount > 140 ? 110 : ordered.length);

    for (let i = 0; i < candidateLimit; i++) {
      if (performance.now() >= deadline) {
        timedOut = true;
        return false;
      }

      const word = ordered[i];
      assign(chosen, word);

      let viable = true;
      for (const neighborIndex of chosen.neighbors) {
        const neighbor = slots[neighborIndex];
        if (neighbor.assigned) continue;
        if (compatibleCandidates(neighbor, 1).length === 0) {
          viable = false;
          break;
        }
      }

      if (viable && recurse(remaining - 1)) return true;

      unassign(chosen, word);
      if (timedOut) return false;
    }

    return false;
  }

  function compatibleCandidates(slot, limit = Infinity) {
    const patternKey = slot.cells.map(index => letters[index] || ".").join("");
    const cacheKey = `${slot.length}|${patternKey}`;
    let base = cache.get(cacheKey);

    if (!base) {
      const pool = pools.get(slot.length) || [];
      base = pool.filter(word => {
        const answer = word.resposta;
        for (let i = 0; i < patternKey.length; i++) {
          const needed = patternKey[i];
          if (needed !== "." && answer[i] !== needed) return false;
        }
        return true;
      });
      cache.set(cacheKey, base);
    }

    const result = [];
    for (const word of base) {
      if (used.has(word.resposta)) continue;
      result.push(word);
      if (result.length >= limit) break;
    }

    return result;
  }

  function assign(slot, word) {
    slot.assigned = word;
    used.add(word.resposta);

    slot.cells.forEach((index, pos) => {
      if (!letters[index]) letters[index] = word.resposta[pos];
      useCount[index]++;
    });
  }

  function unassign(slot, word) {
    slot.assigned = null;
    used.delete(word.resposta);

    slot.cells.forEach(index => {
      useCount[index]--;
      if (useCount[index] === 0) letters[index] = "";
    });
  }

  const ok = recurse(slots.length);
  if (!ok) return null;

  return buildPuzzle(pattern, slots, letters, cellSlots);
}

function buildPositionFrequencies(pools) {
  const result = new Map();

  for (const [len, words] of pools) {
    const positions = Array.from({ length: len }, () => new Map());

    for (const word of words) {
      for (let i = 0; i < len; i++) {
        const letter = word.resposta[i];
        positions[i].set(letter, (positions[i].get(letter) || 0) + 1);
      }
    }

    result.set(len, positions);
  }

  return result;
}

function orderCandidates(slot, candidates, slots, frequencies, rng) {
  const freq = frequencies.get(slot.length);

  return candidates
    .map(word => {
      let score = rng() * 0.7;

      for (const crossing of slot.crossingPositions) {
        if (slots[crossing.otherSlot].assigned) continue;
        const letter = word.resposta[crossing.ownPos];
        const other = slots[crossing.otherSlot];
        const otherFreq = frequencies.get(other.length)?.[crossing.otherPos];
        const value = otherFreq?.get(letter) || 0;
        score += Math.log1p(value) * 1.4;
      }

      if (freq) {
        for (let i = 0; i < word.resposta.length; i++) {
          score += Math.log1p(freq[i].get(word.resposta[i]) || 0) * 0.025;
        }
      }

      return { word, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(item => item.word);
}

/* =========================================================
   RESULTADO
========================================================= */

function buildPuzzle(pattern, slots, letters, cellSlots) {
  const rows = pattern.length;
  const cols = pattern[0].length;
  const cells = [];
  let black = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c;
      const block = pattern[r][c] === "#";
      if (block) black++;

      cells.push({
        row: r,
        col: c,
        block,
        solution: block ? "" : letters[index],
        slotIds: block ? [] : cellSlots[index].map(entry => slots[entry.slotIndex].id)
      });
    }
  }

  // Numeração padrão: a mesma casa recebe um único número mesmo se iniciar H e V.
  const startMap = new Map();
  for (const slot of slots) {
    const start = slot.cells[0];
    if (!startMap.has(start)) startMap.set(start, null);
  }

  const orderedStarts = [...startMap.keys()].sort((a, b) => a - b);
  orderedStarts.forEach((cellIndex, i) => startMap.set(cellIndex, i + 1));

  const finalSlots = slots.map(slot => ({
    id: slot.id,
    number: startMap.get(slot.cells[0]),
    direction: slot.direction,
    length: slot.length,
    cells: [...slot.cells],
    word: {
      id: slot.assigned.id,
      resposta: slot.assigned.resposta,
      exibicao: slot.assigned.exibicao,
      dica: slot.assigned.dica
    }
  }));

  finalSlots.sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    return a.direction === "across" ? -1 : 1;
  });

  return {
    rows,
    cols,
    cells,
    slots: finalSlots,
    blackRatio: black / (rows * cols)
  };
}

/* =========================================================
   UTILIDADES
========================================================= */

function postProgress(message) {
  self.postMessage({ type: "progress", message });
}

function randomBetween(rng, min, max) {
  if (max <= min) return min;
  return min + rng() * (max - min);
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

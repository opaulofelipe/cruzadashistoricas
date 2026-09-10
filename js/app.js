import {
  ALL_THEMES,
  DIFFICULTY_LABELS,
  filterByTheme,
  getAvailableThemes,
  loadWordBank,
  themeLabel
} from "./data.js";

const STORAGE_KEY = "historia-crossword-mobile-v3";
const TARGET_WORDS = 16;

const els = {
  setupView: document.querySelector("#setup-view"),
  gameView: document.querySelector("#game-view"),
  setupForm: document.querySelector("#setup-form"),
  dataStatus: document.querySelector("#data-status"),
  themeSelect: document.querySelector("#theme-select"),
  generateButton: document.querySelector("#generate-button"),
  resumeButton: document.querySelector("#resume-button"),
  headerNewButton: document.querySelector("#header-new-button"),

  gameKicker: document.querySelector("#game-kicker"),
  progressText: document.querySelector("#progress-text"),
  grid: document.querySelector("#crossword-grid"),
  clueLabel: document.querySelector("#clue-label"),
  clueText: document.querySelector("#clue-text"),
  prevClue: document.querySelector("#prev-clue"),
  nextClue: document.querySelector("#next-clue"),
  checkButton: document.querySelector("#check-button"),
  revealButton: document.querySelector("#reveal-button"),
  clearWordButton: document.querySelector("#clear-word-button"),
  gameStatus: document.querySelector("#game-status"),

  dialog: document.querySelector("#complete-dialog"),
  completeText: document.querySelector("#complete-text"),
  closeDialogButton: document.querySelector("#close-dialog-button"),
  dialogNewButton: document.querySelector("#dialog-new-button")
};

let bank = [];
let worker = null;

let puzzle = null;
let cellsByKey = new Map();
let wordsById = new Map();
let wordKeysById = new Map();
let cellButtons = new Map();

let entries = {};
let revealed = new Set();
let incorrect = new Set();
let activeWordId = null;
let activeCellKey = null;
let completionShown = false;

init();

async function init() {
  wireEvents();

  try {
    const result = await loadWordBank("./palavras.json");
    bank = result.words;

    if (bank.length < 10) {
      throw new Error("O banco possui poucas palavras válidas.");
    }

    populateThemes();
    els.setupForm.hidden = false;
    updateResumeButton();

    const warning = result.warnings.length
      ? ` ${result.warnings.length} registro(s) foram ignorados.`
      : "";

    setDataStatus(`${bank.length} palavras válidas carregadas.${warning}`, result.warnings.length ? "warning" : "success");

    if (result.warnings.length) {
      console.groupCollapsed(`[palavras.json] ${result.warnings.length} aviso(s)`);
      result.warnings.forEach((item) => console.warn(item));
      console.groupEnd();
    }
  } catch (error) {
    console.error(error);
    setDataStatus(
      "Não foi possível carregar palavras.json. Confirme se ele está na mesma pasta de index.html e publique pelo GitHub Pages.",
      "error"
    );
  }
}

function wireEvents() {
  els.setupForm.addEventListener("submit", generateFromForm);
  els.resumeButton.addEventListener("click", restoreGame);
  els.headerNewButton.addEventListener("click", showSetup);

  els.prevClue.addEventListener("click", () => moveClue(-1));
  els.nextClue.addEventListener("click", () => moveClue(1));

  els.checkButton.addEventListener("click", checkPuzzle);
  els.revealButton.addEventListener("click", revealLetter);
  els.clearWordButton.addEventListener("click", clearActiveWord);

  document.querySelectorAll("[data-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.key;
      if (key === "BACKSPACE") backspace();
      else enterLetter(key);
    });
  });

  globalThis.addEventListener("keydown", handleHardwareKeyboard);
  globalThis.addEventListener("pagehide", saveGame);

  els.closeDialogButton.addEventListener("click", () => els.dialog.close());
  els.dialogNewButton.addEventListener("click", () => {
    els.dialog.close();
    showSetup();
  });
}

function populateThemes() {
  els.themeSelect.replaceChildren();

  const all = document.createElement("option");
  all.value = ALL_THEMES;
  all.textContent = "Todos os temas";
  els.themeSelect.append(all);

  for (const theme of getAvailableThemes(bank)) {
    const option = document.createElement("option");
    option.value = theme;
    option.textContent = themeLabel(theme);
    els.themeSelect.append(option);
  }
}

function generateFromForm(event) {
  event.preventDefault();

  const formData = new FormData(els.setupForm);
  const theme = formData.get("theme") || ALL_THEMES;
  const difficulty = Number(formData.get("difficulty")) || 2;
  const filtered = filterByTheme(bank, theme);

  if (filtered.length < 8) {
    setDataStatus("Esse tema ainda não possui palavras suficientes para uma boa cruzadinha.", "error");
    return;
  }

  startGeneration(filtered, {
    theme,
    themeLabel: theme === ALL_THEMES ? "Todos os temas" : themeLabel(theme),
    difficulty
  });
}

function startGeneration(words, meta) {
  stopWorker();

  els.generateButton.disabled = true;
  els.generateButton.textContent = "Gerando…";
  setDataStatus("Montando uma grade compacta…", "warning");

  worker = new Worker(new URL("./crossword-worker.js", import.meta.url), { type: "module" });

  worker.addEventListener("message", (event) => {
    const message = event.data;

    if (message?.type === "progress") {
      const count = message.wordsPlaced || 0;
      setDataStatus(`Montando… ${count} palavra(s) encaixadas até agora.`, "warning");
      return;
    }

    if (message?.type === "error") {
      finishGeneration();
      setDataStatus(message.message || "Não foi possível gerar a cruzadinha.", "error");
      return;
    }

    if (message?.type === "result") {
      finishGeneration();

      puzzle = message.puzzle;
      puzzle.meta = {
        ...meta,
        difficultyLabel: DIFFICULTY_LABELS[meta.difficulty] || "Médio"
      };

      beginPuzzle();
      saveGame();
    }
  });

  worker.addEventListener("error", (error) => {
    console.error(error);
    finishGeneration();
    setDataStatus("O gerador encontrou um erro inesperado.", "error");
  });

  worker.postMessage({
    type: "generate",
    words,
    options: {
      targetWords: TARGET_WORDS,
      difficulty: meta.difficulty,
      seed: secureSeed(),
      timeBudgetMs: 2400
    }
  });
}

function finishGeneration() {
  stopWorker();
  els.generateButton.disabled = false;
  els.generateButton.textContent = "Gerar cruzadinha";
}

function stopWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function beginPuzzle(saved = null) {
  rebuildIndexes();

  entries = saved?.entries || {};
  revealed = new Set(saved?.revealed || []);
  incorrect = new Set();
  completionShown = false;

  const firstWord = puzzle.words.slice().sort(sortWords)[0];
  activeWordId = saved?.activeWordId && wordsById.has(saved.activeWordId)
    ? saved.activeWordId
    : firstWord?.id ?? null;

  const firstKey = activeWordId != null ? wordKeysById.get(activeWordId)?.[0] : null;
  activeCellKey = saved?.activeCellKey && cellsByKey.has(saved.activeCellKey)
    ? saved.activeCellKey
    : firstKey ?? null;

  renderGrid();
  renderState();
  showGame();
}

function rebuildIndexes() {
  cellsByKey = new Map();
  wordsById = new Map();
  wordKeysById = new Map();

  for (const cell of puzzle.cells) {
    cellsByKey.set(keyOf(cell.row, cell.col), cell);
  }

  for (const word of puzzle.words) {
    wordsById.set(word.id, word);

    const dr = word.direction === "down" ? 1 : 0;
    const dc = word.direction === "across" ? 1 : 0;
    const keys = [];

    for (let i = 0; i < word.answer.length; i += 1) {
      keys.push(keyOf(word.row + dr * i, word.col + dc * i));
    }

    wordKeysById.set(word.id, keys);
  }
}

function renderGrid() {
  cellButtons = new Map();
  els.grid.replaceChildren();
  els.grid.style.setProperty("--cols", puzzle.cols);

  for (let row = 0; row < puzzle.rows; row += 1) {
    for (let col = 0; col < puzzle.cols; col += 1) {
      const key = keyOf(row, col);
      const cell = cellsByKey.get(key);

      if (!cell) {
        const block = document.createElement("div");
        block.className = "block-cell";
        block.setAttribute("aria-hidden", "true");
        els.grid.append(block);
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "grid-cell";
      button.dataset.key = key;
      button.setAttribute("role", "gridcell");

      if (cell.number) {
        const number = document.createElement("span");
        number.className = "cell-number";
        number.textContent = cell.number;
        button.append(number);
      }

      const letter = document.createElement("span");
      letter.className = "cell-letter";
      button.append(letter);

      button.addEventListener("click", () => selectCell(key));

      els.grid.append(button);
      cellButtons.set(key, button);
    }
  }
}

function renderState() {
  if (!puzzle) return;

  const activeWord = wordsById.get(activeWordId);
  const activeKeys = new Set(activeWord ? wordKeysById.get(activeWord.id) : []);
  const solvedWords = new Set(
    puzzle.words.filter((word) => wordIsSolved(word.id)).map((word) => word.id)
  );

  for (const [key, button] of cellButtons) {
    const cell = cellsByKey.get(key);
    const letterEl = button.querySelector(".cell-letter");
    letterEl.textContent = entries[key] || "";

    button.classList.toggle("active-word", activeKeys.has(key));
    button.classList.toggle("active-cell", key === activeCellKey);
    button.classList.toggle("incorrect", incorrect.has(key));

    const memberships = [cell.acrossId, cell.downId].filter((id) => id != null);
    button.classList.toggle(
      "correct-word",
      memberships.length > 0 && memberships.every((id) => solvedWords.has(id))
    );

    button.setAttribute("aria-label", accessibleCellLabel(cell, key));
    button.setAttribute("aria-pressed", key === activeCellKey ? "true" : "false");
  }

  if (activeWord) {
    els.clueLabel.textContent = `${activeWord.direction === "across" ? "H" : "V"}${activeWord.number}`;
    els.clueText.textContent = activeWord.clue;
  } else {
    els.clueLabel.textContent = "";
    els.clueText.textContent = "Selecione uma palavra.";
  }

  const solved = puzzle.words.filter((word) => wordIsSolved(word.id)).length;
  els.progressText.textContent = `${solved}/${puzzle.words.length}`;

  const meta = puzzle.meta || {};
  els.gameKicker.textContent =
    `${meta.themeLabel || "História"} · ${meta.difficultyLabel || "Médio"} · ${puzzle.cols}×${puzzle.rows}`;

  saveGame();

  if (solved === puzzle.words.length && !completionShown) {
    completionShown = true;
    setGameStatus("Cruzadinha concluída.", "success");
    els.completeText.textContent =
      `${puzzle.words.length} palavras concluídas${revealed.size ? `, com ${revealed.size} letra(s) revelada(s).` : "."}`;
    if (typeof els.dialog.showModal === "function" && !els.dialog.open) {
      els.dialog.showModal();
    }
  }
}

function selectCell(key) {
  const cell = cellsByKey.get(key);
  if (!cell) return;

  const candidates = [cell.acrossId, cell.downId].filter((id) => id != null);

  if (key === activeCellKey && candidates.length === 2 && candidates.includes(activeWordId)) {
    activeWordId = candidates.find((id) => id !== activeWordId);
  } else if (candidates.includes(activeWordId)) {
    // Mantém a direção atual quando a casa pertence à palavra ativa.
  } else {
    const currentDirection = wordsById.get(activeWordId)?.direction;
    const sameDirection = candidates.find((id) => wordsById.get(id)?.direction === currentDirection);
    activeWordId = sameDirection ?? candidates[0] ?? null;
  }

  activeCellKey = key;
  incorrect.delete(key);
  renderState();
}

function moveClue(delta) {
  if (!puzzle?.words?.length) return;

  const ordered = puzzle.words.slice().sort(sortWords);
  let index = ordered.findIndex((word) => word.id === activeWordId);
  if (index < 0) index = 0;

  index = (index + delta + ordered.length) % ordered.length;
  activeWordId = ordered[index].id;
  activeCellKey = wordKeysById.get(activeWordId)?.[0] || activeCellKey;
  renderState();
  cellButtons.get(activeCellKey)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function enterLetter(raw) {
  if (!puzzle || !activeWordId || !activeCellKey) return;

  const letter = String(raw || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 1);
  if (!letter) return;

  entries[activeCellKey] = letter;
  incorrect.delete(activeCellKey);

  const keys = wordKeysById.get(activeWordId) || [];
  const index = keys.indexOf(activeCellKey);

  if (index >= 0 && index < keys.length - 1) {
    activeCellKey = keys[index + 1];
  }

  renderState();
}

function backspace() {
  if (!puzzle || !activeWordId || !activeCellKey) return;

  const keys = wordKeysById.get(activeWordId) || [];
  let index = keys.indexOf(activeCellKey);

  if (entries[activeCellKey]) {
    delete entries[activeCellKey];
    incorrect.delete(activeCellKey);
  } else if (index > 0) {
    activeCellKey = keys[index - 1];
    delete entries[activeCellKey];
    incorrect.delete(activeCellKey);
  }

  renderState();
}

function clearActiveWord() {
  if (!activeWordId) return;

  for (const key of wordKeysById.get(activeWordId) || []) {
    if (!revealed.has(key)) delete entries[key];
    incorrect.delete(key);
  }

  setGameStatus("Palavra apagada.", "neutral");
  renderState();
}

function revealLetter() {
  if (!activeCellKey) return;

  const cell = cellsByKey.get(activeCellKey);
  if (!cell) return;

  entries[activeCellKey] = cell.letter;
  revealed.add(activeCellKey);
  incorrect.delete(activeCellKey);

  const keys = wordKeysById.get(activeWordId) || [];
  const index = keys.indexOf(activeCellKey);
  if (index >= 0 && index < keys.length - 1) activeCellKey = keys[index + 1];

  setGameStatus("Uma letra foi revelada.", "neutral");
  renderState();
}

function checkPuzzle() {
  if (!puzzle) return;

  incorrect.clear();
  let filled = 0;

  for (const [key, cell] of cellsByKey) {
    if (!entries[key]) continue;
    filled += 1;
    if (entries[key] !== cell.letter) incorrect.add(key);
  }

  if (filled === 0) {
    setGameStatus("Preencha algumas casas antes de verificar.", "neutral");
  } else if (incorrect.size) {
    setGameStatus(`${incorrect.size} letra(s) preenchida(s) ainda estão incorretas.`, "error");
  } else if (puzzle.words.every((word) => wordIsSolved(word.id))) {
    setGameStatus("Tudo correto.", "success");
  } else {
    setGameStatus("Tudo o que foi preenchido até agora está correto.", "success");
  }

  renderState();
}

function wordIsSolved(wordId) {
  const word = wordsById.get(wordId);
  const keys = wordKeysById.get(wordId);
  if (!word || !keys) return false;

  for (let i = 0; i < keys.length; i += 1) {
    if (entries[keys[i]] !== word.answer[i]) return false;
  }
  return true;
}

function accessibleCellLabel(cell, key) {
  const parts = [`Linha ${cell.row + 1}, coluna ${cell.col + 1}`];

  if (cell.number) parts.push(`número ${cell.number}`);
  if (cell.acrossId) parts.push(`horizontal ${wordsById.get(cell.acrossId)?.number ?? ""}`);
  if (cell.downId) parts.push(`vertical ${wordsById.get(cell.downId)?.number ?? ""}`);
  if (entries[key]) parts.push(`letra ${entries[key]}`);

  return parts.join(", ");
}

function handleHardwareKeyboard(event) {
  if (els.gameView.hidden || event.ctrlKey || event.metaKey || event.altKey) return;

  if (/^[a-zA-Z]$/.test(event.key)) {
    event.preventDefault();
    enterLetter(event.key);
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    backspace();
    return;
  }

  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    moveWithinWord(1);
    return;
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    moveWithinWord(-1);
  }
}

function moveWithinWord(delta) {
  const keys = wordKeysById.get(activeWordId) || [];
  let index = keys.indexOf(activeCellKey);
  if (index < 0) index = 0;
  index = Math.max(0, Math.min(keys.length - 1, index + delta));
  activeCellKey = keys[index];
  renderState();
}

function showGame() {
  els.setupView.hidden = true;
  els.gameView.hidden = false;
  els.headerNewButton.hidden = false;
  globalThis.scrollTo({ top: 0, behavior: "auto" });
}

function showSetup() {
  stopWorker();
  els.gameView.hidden = true;
  els.setupView.hidden = false;
  els.headerNewButton.hidden = true;
  updateResumeButton();
  globalThis.scrollTo({ top: 0, behavior: "auto" });
}

function setDataStatus(text, state = "neutral") {
  els.dataStatus.textContent = text;
  els.dataStatus.dataset.state = state;
}

function setGameStatus(text, state = "neutral") {
  els.gameStatus.textContent = text;
  els.gameStatus.dataset.state = state;
}

function saveGame() {
  if (!puzzle) return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 3,
      puzzle,
      entries,
      revealed: [...revealed],
      activeWordId,
      activeCellKey
    }));
  } catch (error) {
    console.warn("Não foi possível salvar a partida.", error);
  }
}

function updateResumeButton() {
  els.resumeButton.hidden = !loadSaved();
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 3 || !parsed?.puzzle?.words?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function restoreGame() {
  const saved = loadSaved();
  if (!saved) {
    updateResumeButton();
    return;
  }

  puzzle = saved.puzzle;
  beginPuzzle(saved);
}

function sortWords(a, b) {
  return a.number - b.number ||
    (a.direction === "across" ? -1 : 1);
}

function keyOf(row, col) {
  return `${row},${col}`;
}

function secureSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const array = new Uint32Array(1);
    globalThis.crypto.getRandomValues(array);
    return array[0];
  }
  return Math.floor(Math.random() * 0xffffffff);
}

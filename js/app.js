import {
  ALL_THEMES,
  DIFFICULTY_LABELS,
  filterByTheme,
  getAvailableThemes,
  loadWordBank,
  themeLabel
} from "./data.js";
import { CrosswordGame } from "./game.js";
import { CrosswordRenderer } from "./renderer.js";

const STORAGE_KEY = "historia-crossword-state-v2";
const STATE_VERSION = 2;
const TARGET_WORDS = 18;

const els = {
  setupView: document.querySelector("#setup-view"),
  gameView: document.querySelector("#game-view"),
  setupForm: document.querySelector("#setup-form"),
  dataStatus: document.querySelector("#data-status"),
  themeOptions: document.querySelector("#theme-options"),
  generateButton: document.querySelector("#generate-button"),
  resumeButton: document.querySelector("#resume-button"),
  gameKicker: document.querySelector("#game-kicker"),
  gameTitle: document.querySelector("#game-title"),
  gameSummary: document.querySelector("#game-summary"),
  gameStatus: document.querySelector("#game-status"),
  newButton: document.querySelector("#new-button"),
  checkButton: document.querySelector("#check-button"),
  revealButton: document.querySelector("#reveal-button"),
  clearButton: document.querySelector("#clear-button"),
  grid: document.querySelector("#crossword-grid"),
  boardScroll: document.querySelector("#board-scroll"),
  acrossClues: document.querySelector("#across-clues"),
  downClues: document.querySelector("#down-clues"),
  dialog: document.querySelector("#complete-dialog"),
  completeText: document.querySelector("#complete-text"),
  closeDialogButton: document.querySelector("#close-dialog-button"),
  dialogNewButton: document.querySelector("#dialog-new-button")
};

let bank = [];
let worker = null;
let game = null;
let saveTimer = null;
let lastPointerCellKey = null;
let completionAnnounced = false;

const renderer = new CrosswordRenderer(els, {
  onCellFocus: (key) => {
    if (!game) return;
    game.activateCell(key);
    renderer.sync(game);
    scheduleSave();
  },
  onCellPointer: (key) => {
    if (!game) return;
    const cell = game.getCell(key);
    if (lastPointerCellKey === key && cell?.acrossId && cell?.downId) game.toggleDirection();
    lastPointerCellKey = key;
    game.activateCell(key);
    renderer.sync(game);
    scheduleSave();
  },
  onCellInput: (key, value) => {
    if (!game) return;
    const focusKey = game.enterLetter(key, value);
    renderer.sync(game);
    if (focusKey && focusKey !== key) renderer.focusCell(focusKey);
    afterPlayerChange();
  },
  onCellKeydown: handleCellKeydown,
  onCellPaste: (key, event) => {
    if (!game) return;
    event.preventDefault();
    const focusKey = game.paste(key, event.clipboardData?.getData("text") || "");
    renderer.sync(game);
    if (focusKey) renderer.focusCell(focusKey);
    afterPlayerChange();
  },
  onClueClick: (wordId) => {
    if (!game) return;
    const key = game.selectWord(wordId);
    renderer.sync(game);
    if (key) renderer.focusCell(key);
    scheduleSave();
  }
});

init();

async function init() {
  wireStaticEvents();

  try {
    const validated = await loadWordBank("./palavras.json");
    bank = validated.words;

    if (bank.length < 8) {
      throw new Error("O banco não possui palavras válidas suficientes para gerar uma cruzadinha.");
    }

    populateThemes();
    els.setupForm.hidden = false;
    updateResumeButton();

    const warningText = validated.warnings.length
      ? ` ${validated.warnings.length} registro(s) inválido(s) ou duplicado(s) foram ignorados; veja o console.`
      : "";

    setNotice(
      els.dataStatus,
      `${bank.length} palavras válidas carregadas.${warningText}`,
      validated.warnings.length ? "warning" : "success"
    );

    if (validated.warnings.length) {
      console.groupCollapsed(`[palavras.json] ${validated.warnings.length} aviso(s)`);
      validated.warnings.forEach((warning) => console.warn(warning));
      console.groupEnd();
    }
  } catch (error) {
    console.error(error);
    setNotice(
      els.dataStatus,
      "Não foi possível carregar palavras.json. Confirme o arquivo e abra o projeto por um servidor local ou pelo GitHub Pages.",
      "error"
    );
  }
}

function wireStaticEvents() {
  els.setupForm.addEventListener("submit", handleGenerate);
  els.resumeButton.addEventListener("click", restoreSavedGame);
  els.newButton.addEventListener("click", showSetup);
  els.dialogNewButton.addEventListener("click", () => {
    els.dialog.close();
    showSetup();
  });
  els.closeDialogButton.addEventListener("click", () => els.dialog.close());
  els.checkButton.addEventListener("click", checkPuzzle);
  els.revealButton.addEventListener("click", revealActiveCell);
  els.clearButton.addEventListener("click", clearEntries);
  globalThis.addEventListener("pagehide", saveGame);
}

function populateThemes() {
  const themes = getAvailableThemes(bank);
  const options = [
    { value: ALL_THEMES, label: "Todos os temas", description: `${bank.length} termos disponíveis.` },
    ...themes.map((theme) => ({
      value: theme,
      label: themeLabel(theme),
      description: `${filterByTheme(bank, theme).length} termos disponíveis.`
    }))
  ];

  els.themeOptions.replaceChildren();
  options.forEach((option, index) => {
    const label = document.createElement("label");
    label.className = "choice-card";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "theme";
    input.value = option.value;
    input.checked = index === 0;

    const title = document.createElement("span");
    title.className = "choice-title";
    title.textContent = option.label;

    const description = document.createElement("span");
    description.className = "choice-description";
    description.textContent = option.description;

    label.append(input, title, description);
    els.themeOptions.append(label);
  });
}

function handleGenerate(event) {
  event.preventDefault();
  const formData = new FormData(els.setupForm);
  const theme = formData.get("theme") || ALL_THEMES;
  const difficulty = Number(formData.get("difficulty")) || 2;
  const available = filterByTheme(bank, theme).length;

  if (available < 8) {
    setNotice(els.dataStatus, "Esse tema ainda não possui palavras suficientes para uma boa cruzadinha.", "error");
    return;
  }

  generatePuzzle(theme, difficulty);
}

function generatePuzzle(theme, difficulty) {
  stopWorker();
  setGenerating(true);
  setNotice(els.dataStatus, "Analisando cruzamentos e procurando uma grade compacta…", "warning");

  const seed = secureSeed();
  worker = new Worker(new URL("./crossword-worker.js", import.meta.url), { type: "module" });

  worker.addEventListener("message", (event) => {
    const message = event.data;

    if (message?.type === "progress") {
      setNotice(
        els.dataStatus,
        `Gerando… melhor resultado: ${message.wordsPlaced} palavras e ${message.intersections ?? 0} cruzamentos.`,
        "warning"
      );
      return;
    }

    if (message?.type === "result") {
      setGenerating(false);
      stopWorker();

      if (!message.puzzle || message.puzzle.words.length < 6) {
        setNotice(els.dataStatus, "Não encontrei uma grade boa com essa combinação. Tente gerar novamente.", "error");
        return;
      }

      message.puzzle.meta = {
        theme,
        difficulty,
        themeLabel: theme === ALL_THEMES ? "Todos os temas" : themeLabel(theme),
        difficultyLabel: DIFFICULTY_LABELS[difficulty]
      };

      game = new CrosswordGame(message.puzzle);
      completionAnnounced = false;
      renderer.render(game);
      updateGameHeader();
      showGame();
      saveGame();
      return;
    }

    if (message?.type === "error") {
      setGenerating(false);
      stopWorker();
      setNotice(els.dataStatus, message.message || "Não foi possível gerar a cruzadinha.", "error");
    }
  });

  worker.addEventListener("error", (error) => {
    console.error(error);
    setGenerating(false);
    stopWorker();
    setNotice(els.dataStatus, "O gerador encontrou um erro inesperado. Veja o console do navegador.", "error");
  });

  worker.postMessage({
    type: "generate",
    words: bank,
    options: {
      theme,
      allThemesValue: ALL_THEMES,
      difficulty,
      seed,
      targetWords: TARGET_WORDS,
      maxCandidates: 72,
      timeBudgetMs: 3400
    }
  });
}

function handleCellKeydown(key, event) {
  if (!game) return;

  if (event.key === "Backspace") {
    event.preventDefault();
    const focusKey = game.backspace(key);
    renderer.sync(game);
    if (focusKey) renderer.focusCell(focusKey);
    afterPlayerChange();
    return;
  }

  if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
    const cell = game.getCell(key);
    if (cell?.acrossId && cell?.downId) {
      event.preventDefault();
      game.toggleDirection();
      renderer.sync(game);
      scheduleSave();
    }
    return;
  }

  const moves = {
    ArrowLeft: ["across", -1],
    ArrowRight: ["across", 1],
    ArrowUp: ["down", -1],
    ArrowDown: ["down", 1]
  };

  const move = moves[event.key];
  if (move) {
    event.preventDefault();
    const focusKey = game.moveByDirection(move[0], move[1]);
    renderer.sync(game);
    if (focusKey) renderer.focusCell(focusKey);
    scheduleSave();
  }
}

function checkPuzzle() {
  if (!game) return;
  const result = game.check();
  renderer.sync(game);

  if (result.complete) {
    completePuzzle();
  } else if (result.wrong > 0) {
    setNotice(els.gameStatus, `${result.wrong} letra(s) preenchida(s) ainda estão incorretas.`, "error");
  } else if (result.filled === 0) {
    setNotice(els.gameStatus, "Preencha algumas casas antes de verificar.", "warning");
  } else {
    setNotice(els.gameStatus, "Tudo o que está preenchido até agora está correto.", "success");
  }
  scheduleSave();
}

function revealActiveCell() {
  if (!game?.activeCellKey) {
    setNotice(els.gameStatus, "Selecione uma casa antes de revelar uma letra.", "warning");
    return;
  }

  game.revealActiveCell();
  renderer.sync(game);
  setNotice(els.gameStatus, "Uma letra foi revelada.", "warning");
  afterPlayerChange();
}

function clearEntries() {
  if (!game) return;
  game.clear();
  completionAnnounced = false;
  renderer.sync(game);
  setNotice(els.gameStatus, "Respostas apagadas.", "warning");
  scheduleSave();
}

function afterPlayerChange() {
  if (!game) return;
  renderer.sync(game);
  updateProgressNotice();
  if (game.isSolved()) completePuzzle();
  scheduleSave();
}

function updateProgressNotice() {
  if (!game || game.isSolved()) return;
  const solved = game.solvedWordCount();
  setNotice(els.gameStatus, `${solved} de ${game.puzzle.words.length} palavras concluídas.`, "neutral");
}

function completePuzzle() {
  if (!game || completionAnnounced) return;
  completionAnnounced = true;
  game.incorrect.clear();
  renderer.sync(game);
  setNotice(els.gameStatus, "Cruzadinha concluída.", "success");
  els.completeText.textContent = `${game.puzzle.words.length} palavras concluídas. ${game.revealed.size ? `${game.revealed.size} letra(s) foram reveladas.` : "Nenhuma letra foi revelada."}`;
  saveGame();
  if (typeof els.dialog.showModal === "function" && !els.dialog.open) els.dialog.showModal();
}

function updateGameHeader() {
  if (!game) return;
  const meta = game.puzzle.meta || {};
  els.gameKicker.textContent = `${meta.themeLabel || "História"} · ${meta.difficultyLabel || "Médio"}`;
  els.gameSummary.textContent = `${game.puzzle.words.length} palavras · ${game.puzzle.stats.intersections} cruzamentos · densidade ${Math.round(game.puzzle.stats.density * 100)}%`;
  updateProgressNotice();
}

function showGame() {
  els.setupView.hidden = true;
  els.gameView.hidden = false;
  globalThis.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  const key = game?.activeCellKey;
  if (key) requestAnimationFrame(() => renderer.focusCell(key));
}

function showSetup() {
  stopWorker();
  setGenerating(false);
  els.gameView.hidden = true;
  els.setupView.hidden = false;
  updateResumeButton();
  globalThis.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function setGenerating(isGenerating) {
  els.generateButton.disabled = isGenerating;
  els.generateButton.textContent = isGenerating ? "Gerando…" : "Gerar cruzadinha";
}

function stopWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

function saveGame() {
  if (!game) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: STATE_VERSION,
      puzzle: game.puzzle,
      state: game.serialize()
    }));
  } catch (error) {
    console.warn("Não foi possível salvar a partida no localStorage.", error);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveGame, 120);
}

function loadSavedGame() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.version !== STATE_VERSION || !saved?.puzzle?.words?.length) return null;
    return saved;
  } catch {
    return null;
  }
}

function updateResumeButton() {
  els.resumeButton.hidden = !loadSavedGame();
}

function restoreSavedGame() {
  const saved = loadSavedGame();
  if (!saved) {
    updateResumeButton();
    return;
  }

  try {
    game = new CrosswordGame(saved.puzzle, saved.state);
    completionAnnounced = game.isSolved();
    renderer.render(game);
    updateGameHeader();
    showGame();
  } catch (error) {
    console.error(error);
    localStorage.removeItem(STORAGE_KEY);
    updateResumeButton();
    setNotice(els.dataStatus, "A partida salva estava corrompida e foi descartada.", "error");
  }
}

function setNotice(element, text, state = "neutral") {
  element.textContent = text;
  element.dataset.state = state;
}

function secureSeed() {
  if (globalThis.crypto?.getRandomValues) {
    const array = new Uint32Array(1);
    globalThis.crypto.getRandomValues(array);
    return array[0];
  }
  return Math.floor(Math.random() * 0xffffffff);
}

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

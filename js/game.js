export class CrosswordGame {
  constructor(puzzle, savedState = null) {
    if (!puzzle?.cells?.length || !puzzle?.words?.length) {
      throw new Error("Puzzle inválido.");
    }

    this.puzzle = puzzle;
    this.cellsByKey = new Map(puzzle.cells.map((cell) => [keyOf(cell.row, cell.col), cell]));
    this.wordsById = new Map(puzzle.words.map((word) => [word.id, word]));

    this.entries = { ...(savedState?.entries || {}) };
    this.revealed = new Set(savedState?.revealed || []);
    this.incorrect = new Set();
    this.activeWordId = savedState?.activeWordId ?? null;
    this.activeDirection = savedState?.activeDirection === "down" ? "down" : "across";
    this.activeCellKey = savedState?.activeCellKey ?? null;

    this.sanitizeState();
    if (!this.activeWordId) this.selectInitialWord();
  }

  sanitizeState() {
    for (const key of Object.keys(this.entries)) {
      if (!this.cellsByKey.has(key)) delete this.entries[key];
      else this.entries[key] = normalizePlayerInput(this.entries[key]).slice(0, 1);
    }
    this.revealed = new Set([...this.revealed].filter((key) => this.cellsByKey.has(key)));
    if (this.activeCellKey && !this.cellsByKey.has(this.activeCellKey)) this.activeCellKey = null;
    if (this.activeWordId && !this.wordsById.has(this.activeWordId)) this.activeWordId = null;
  }

  selectInitialWord() {
    const first = this.puzzle.words.slice().sort((a, b) => a.number - b.number)[0];
    if (first) this.selectWord(first.id);
  }

  getCell(key) {
    return this.cellsByKey.get(key) || null;
  }

  getWord(id) {
    return this.wordsById.get(id) || null;
  }

  getActiveWord() {
    return this.getWord(this.activeWordId);
  }

  wordCellKeys(wordOrId) {
    const word = typeof wordOrId === "object" ? wordOrId : this.getWord(wordOrId);
    if (!word) return [];
    const dr = word.direction === "down" ? 1 : 0;
    const dc = word.direction === "across" ? 1 : 0;
    return Array.from({ length: word.answer.length }, (_, i) => keyOf(word.row + dr * i, word.col + dc * i));
  }

  activateCell(key, { fromKeyboard = false } = {}) {
    const cell = this.getCell(key);
    if (!cell) return;
    this.activeCellKey = key;

    if (cell.acrossId && cell.downId) {
      const current = this.getActiveWord();
      const currentFits = current && (
        (this.activeDirection === "across" && current.id === cell.acrossId) ||
        (this.activeDirection === "down" && current.id === cell.downId)
      );
      if (!currentFits && !fromKeyboard) this.activeDirection = "across";
    } else if (cell.acrossId) {
      this.activeDirection = "across";
    } else if (cell.downId) {
      this.activeDirection = "down";
    }

    this.activeWordId = this.activeDirection === "across"
      ? (cell.acrossId || cell.downId)
      : (cell.downId || cell.acrossId);

    if (this.activeWordId === cell.acrossId) this.activeDirection = "across";
    if (this.activeWordId === cell.downId) this.activeDirection = "down";
  }

  toggleDirection() {
    const cell = this.getCell(this.activeCellKey);
    if (!cell?.acrossId || !cell?.downId) return false;

    if (this.activeDirection === "across") {
      this.activeDirection = "down";
      this.activeWordId = cell.downId;
    } else {
      this.activeDirection = "across";
      this.activeWordId = cell.acrossId;
    }
    return true;
  }

  selectWord(wordId) {
    const word = this.getWord(wordId);
    if (!word) return null;

    this.activeWordId = word.id;
    this.activeDirection = word.direction;
    const keys = this.wordCellKeys(word);
    this.activeCellKey = keys.find((key) => !this.entries[key]) || keys[0] || null;
    return this.activeCellKey;
  }

  enterLetter(key, rawValue) {
    const letter = normalizePlayerInput(rawValue).slice(-1);
    if (!this.getCell(key)) return null;
    this.entries[key] = letter;
    this.incorrect.delete(key);
    this.activeCellKey = key;
    return letter ? this.moveInActiveWord(1) : key;
  }

  paste(key, rawText) {
    const letters = normalizePlayerInput(rawText);
    const word = this.getActiveWord();
    if (!word || !letters) return key;

    const keys = this.wordCellKeys(word);
    const start = Math.max(0, keys.indexOf(key));
    let used = 0;

    for (let i = start; i < keys.length && used < letters.length; i += 1) {
      const cellKey = keys[i];
      this.entries[cellKey] = letters[used++];
      this.incorrect.delete(cellKey);
    }

    this.activeCellKey = keys[Math.min(keys.length - 1, start + used)] || key;
    return this.activeCellKey;
  }

  backspace(key) {
    if (!this.getCell(key)) return null;
    this.activeCellKey = key;

    if (this.entries[key]) {
      this.entries[key] = "";
      this.incorrect.delete(key);
      return key;
    }

    const previous = this.moveInActiveWord(-1);
    if (previous) {
      this.entries[previous] = "";
      this.incorrect.delete(previous);
    }
    return previous || key;
  }

  moveInActiveWord(delta) {
    const word = this.getActiveWord();
    if (!word) return null;
    const keys = this.wordCellKeys(word);
    const currentIndex = Math.max(0, keys.indexOf(this.activeCellKey));
    const nextIndex = Math.max(0, Math.min(keys.length - 1, currentIndex + delta));
    this.activeCellKey = keys[nextIndex];
    return this.activeCellKey;
  }

  moveByDirection(direction, delta) {
    const cell = this.getCell(this.activeCellKey);
    if (!cell) return null;
    const wordId = direction === "across" ? cell.acrossId : cell.downId;
    if (!wordId) return null;

    this.activeDirection = direction;
    this.activeWordId = wordId;
    return this.moveInActiveWord(delta);
  }

  revealActiveCell() {
    const cell = this.getCell(this.activeCellKey);
    if (!cell) return null;
    this.entries[this.activeCellKey] = cell.letter;
    this.revealed.add(this.activeCellKey);
    this.incorrect.delete(this.activeCellKey);
    return this.activeCellKey;
  }

  clear() {
    this.entries = {};
    this.incorrect.clear();
    this.revealed.clear();
  }

  check() {
    this.incorrect.clear();
    let filled = 0;
    let wrong = 0;

    for (const [key, cell] of this.cellsByKey) {
      const answer = this.entries[key] || "";
      if (!answer) continue;
      filled += 1;
      if (answer !== cell.letter) {
        wrong += 1;
        this.incorrect.add(key);
      }
    }

    return {
      filled,
      wrong,
      total: this.cellsByKey.size,
      complete: this.isSolved()
    };
  }

  wordIsSolved(wordOrId) {
    const word = typeof wordOrId === "object" ? wordOrId : this.getWord(wordOrId);
    if (!word) return false;
    return this.wordCellKeys(word).every((key, index) => (this.entries[key] || "") === word.answer[index]);
  }

  solvedWordCount() {
    return this.puzzle.words.reduce((count, word) => count + (this.wordIsSolved(word) ? 1 : 0), 0);
  }

  isSolved() {
    return [...this.cellsByKey].every(([key, cell]) => (this.entries[key] || "") === cell.letter);
  }

  serialize() {
    return {
      entries: { ...this.entries },
      revealed: [...this.revealed],
      activeWordId: this.activeWordId,
      activeDirection: this.activeDirection,
      activeCellKey: this.activeCellKey
    };
  }
}

export function normalizePlayerInput(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Ç/gi, "C")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

export function keyOf(row, col) {
  return `${row},${col}`;
}

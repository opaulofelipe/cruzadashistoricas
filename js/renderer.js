export class CrosswordRenderer {
  constructor(elements, handlers = {}) {
    this.els = elements;
    this.handlers = handlers;
    this.cellInputs = new Map();
    this.cellWrappers = new Map();
    this.clueButtons = new Map();
  }

  render(game) {
    this.game = game;
    this.cellInputs.clear();
    this.cellWrappers.clear();
    this.clueButtons.clear();
    this.els.grid.replaceChildren();
    this.els.acrossClues.replaceChildren();
    this.els.downClues.replaceChildren();

    const puzzle = game.puzzle;
    this.els.grid.style.setProperty("--cols", puzzle.cols);
    this.els.grid.style.setProperty("--rows", puzzle.rows);

    for (let row = 0; row < puzzle.rows; row += 1) {
      for (let col = 0; col < puzzle.cols; col += 1) {
        const key = `${row},${col}`;
        const cell = game.getCell(key);

        if (!cell) {
          const block = document.createElement("div");
          block.className = "block-cell";
          block.setAttribute("aria-hidden", "true");
          this.els.grid.append(block);
          continue;
        }

        const wrapper = document.createElement("div");
        wrapper.className = "cell-wrap";
        wrapper.dataset.key = key;

        if (cell.number) {
          const number = document.createElement("span");
          number.className = "cell-number";
          number.textContent = cell.number;
          wrapper.append(number);
        }

        const input = document.createElement("input");
        input.className = "cell-input";
        input.type = "text";
        input.inputMode = "text";
        input.autocomplete = "off";
        input.autocapitalize = "characters";
        input.spellcheck = false;
        input.maxLength = 1;
        input.dataset.key = key;
        input.setAttribute("role", "gridcell");
        input.setAttribute("aria-label", this.accessibleCellLabel(cell, game));

        input.addEventListener("focus", () => this.handlers.onCellFocus?.(key));
        input.addEventListener("pointerdown", () => this.handlers.onCellPointer?.(key));
        input.addEventListener("input", (event) => this.handlers.onCellInput?.(key, event.currentTarget.value));
        input.addEventListener("keydown", (event) => this.handlers.onCellKeydown?.(key, event));
        input.addEventListener("paste", (event) => this.handlers.onCellPaste?.(key, event));

        wrapper.append(input);
        this.els.grid.append(wrapper);
        this.cellInputs.set(key, input);
        this.cellWrappers.set(key, wrapper);
      }
    }

    this.renderClues("across", this.els.acrossClues, game);
    this.renderClues("down", this.els.downClues, game);
    this.sync(game);
  }

  renderClues(direction, container, game) {
    game.puzzle.words
      .filter((word) => word.direction === direction)
      .sort((a, b) => a.number - b.number)
      .forEach((word) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "clue-button";
        button.dataset.wordId = word.id;
        button.setAttribute("aria-label", `${word.number}. ${word.clue}`);

        const number = document.createElement("span");
        number.className = "clue-number";
        number.textContent = word.number;

        const text = document.createElement("span");
        text.className = "clue-text";
        text.textContent = word.clue;

        button.append(number, text);
        button.addEventListener("click", () => this.handlers.onClueClick?.(word.id));
        li.append(button);
        container.append(li);
        this.clueButtons.set(String(word.id), button);
      });
  }

  sync(game) {
    const activeWord = game.getActiveWord();
    const activeKeys = new Set(activeWord ? game.wordCellKeys(activeWord) : []);
    const puzzleComplete = game.isSolved();

    for (const [key, input] of this.cellInputs) {
      const value = game.entries[key] || "";
      if (input.value !== value) input.value = value;
      input.tabIndex = key === game.activeCellKey ? 0 : -1;

      const wrapper = this.cellWrappers.get(key);
      wrapper.classList.toggle("in-word", activeKeys.has(key));
      wrapper.classList.toggle("active", key === game.activeCellKey);
      wrapper.classList.toggle("incorrect", game.incorrect.has(key));
      wrapper.classList.toggle("revealed", game.revealed.has(key));
      wrapper.classList.toggle("complete", puzzleComplete);
    }

    for (const [id, button] of this.clueButtons) {
      const wordId = Number(id);
      button.classList.toggle("active", wordId === game.activeWordId);
      button.classList.toggle("solved", game.wordIsSolved(wordId));
      button.setAttribute("aria-current", wordId === game.activeWordId ? "true" : "false");
    }
  }

  focusCell(key, { preventScroll = true } = {}) {
    const input = this.cellInputs.get(key);
    if (!input) return;
    input.focus({ preventScroll });
    this.ensureCellVisible(key);
  }

  ensureCellVisible(key) {
    const wrapper = this.cellWrappers.get(key);
    wrapper?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth"
    });
  }

  accessibleCellLabel(cell, game) {
    const parts = [`Linha ${cell.row + 1}, coluna ${cell.col + 1}`];
    if (cell.acrossId) parts.push(`horizontal ${game.getWord(cell.acrossId)?.number ?? ""}`);
    if (cell.downId) parts.push(`vertical ${game.getWord(cell.downId)?.number ?? ""}`);
    return parts.join(", ");
  }
}

function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

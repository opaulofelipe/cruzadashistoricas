/**
 * Gerador compacto de palavras cruzadas.
 *
 * Objetivos principais:
 *
 * - tentar alcançar 16 palavras;
 * - produzir uma grade conectada;
 * - privilegiar muitos cruzamentos;
 * - favorecer respostas curtas que funcionam como
 *   palavras de ligação;
 * - manter a grade compacta;
 * - permitir formato retangular;
 * - evitar altura excessiva;
 * - reduzir grandes regiões pretas.
 */

export function generateCrossword(
  allWords,
  options = {},
  onProgress = () => {}
) {
  const {
    targetWords = 16,
    difficulty = 2,
    seed = Date.now(),
    timeBudgetMs = 1800
  } = options;

  const rng = makeRng(seed >>> 0);

  const deadline =
    now() + Math.max(900, timeBudgetMs);

  /*
   * A grade não precisa ser quadrada.
   *
   * O algoritmo testa vários limites.
   * A altura pode superar a largura em cerca
   * de quatro linhas.
   */
  const configs = [
    {
      cols: 10,
      rows: 14
    },
    {
      cols: 11,
      rows: 15
    },
    {
      cols: 12,
      rows: 16
    },
    {
      cols: 13,
      rows: 17
    }
  ];

  let best = null;
  let attempt = 0;
  let lastProgress = 0;

  while (now() < deadline) {
    const config =
      configs[attempt % configs.length];

    const candidates = buildPool(
      allWords,
      difficulty,
      config,
      rng,
      72
    );

    if (candidates.length >= 8) {
      const result = runAttempt(
        candidates,
        config,
        targetWords,
        rng,
        deadline
      );

      if (result) {
        const puzzle = finalize(
          result,
          seed,
          difficulty
        );

        if (
          !best ||
          comparePuzzles(puzzle, best) > 0
        ) {
          best = puzzle;
        }

        if (
          isExcellent(
            best,
            targetWords
          )
        ) {
          break;
        }
      }
    }

    attempt += 1;

    if (
      now() - lastProgress > 220
    ) {
      onProgress({
        wordsPlaced:
          best?.words.length || 0,

        intersections:
          best?.stats.intersections || 0,

        cols:
          best?.cols || config.cols,

        rows:
          best?.rows || config.rows
      });

      lastProgress = now();
    }
  }

  if (
    !best ||
    best.words.length < 8
  ) {
    throw new Error(
      "Não foi possível montar uma grade compacta com este conjunto de palavras."
    );
  }

  return best;
}


/* =========================================================
   SELEÇÃO DAS PALAVRAS
   ========================================================= */

function buildPool(
  words,
  selectedDifficulty,
  config,
  rng,
  limit
) {
  const maxLen = config.rows;

  const pool = words
    .filter(
      (word) =>
        word.resposta.length >= 3 &&
        word.resposta.length <= maxLen
    )

    .map((word) => {
      const length =
        word.resposta.length;

      const canAcross =
        length <= config.cols;

      const canDown =
        length <= config.rows;

      if (
        !canAcross &&
        !canDown
      ) {
        return null;
      }

      const diffWeight =
        difficultyWeight(
          word.dificuldade,
          selectedDifficulty
        );

      /*
       * IMPORTANTE:
       *
       * Palavras pequenas são extremamente úteis
       * para ligar regiões diferentes da grade.
       *
       * Antes, palavras com até quatro letras
       * recebiam peso 0.72.
       *
       * Agora respostas de 3 a 5 letras recebem
       * peso 1.55.
       */
      const lengthWeight =
        length <= 5
          ? 1.55
          : length <= 9
            ? 1.18
            : length <= 12
              ? 1.0
              : 0.72;

      const key =
        -Math.log(
          Math.max(
            1e-9,
            rng()
          )
        ) /
        Math.max(
          0.01,
          diffWeight *
          lengthWeight
        );

      return {
        id:
          word.id,

        answer:
          word.resposta,

        display:
          word.exibicao,

        clue:
          word.dica,

        theme:
          word.tema,

        subtheme:
          word.subtema,

        difficulty:
          word.dificuldade,

        key
      };
    })

    .filter(Boolean);

  pool.sort(
    (a, b) =>
      a.key - b.key
  );

  return pool.slice(
    0,
    Math.min(
      limit,
      pool.length
    )
  );
}


function difficultyWeight(
  wordDifficulty,
  selectedDifficulty
) {
  const matrix = {
    1: {
      1: 1.0,
      2: 0.38,
      3: 0.10
    },

    2: {
      1: 0.52,
      2: 1.0,
      3: 0.46
    },

    3: {
      1: 0.18,
      2: 0.56,
      3: 1.0
    }
  };

  return (
    matrix[selectedDifficulty]?.[
      wordDifficulty
    ] ?? 0.5
  );
}


/* =========================================================
   UMA TENTATIVA DE CONSTRUÇÃO
   ========================================================= */

function runAttempt(
  candidates,
  config,
  targetWords,
  rng,
  deadline
) {
  if (
    now() >= deadline
  ) {
    return null;
  }

  const compatibility =
    compatibilityScores(
      candidates
    );

  /*
   * A primeira palavra é preferencialmente
   * uma palavra com boa capacidade de cruzamento.
   */
  const seedCandidates =
    candidates
      .filter(
        (word) =>
          word.answer.length <=
          config.cols
      )

      .sort((a, b) => {
        const score =
          (
            compatibility.get(
              b.id
            ) || 0
          ) -
          (
            compatibility.get(
              a.id
            ) || 0
          );

        return (
          score ||
          b.answer.length -
          a.answer.length
        );
      })

      .slice(0, 12);

  if (
    !seedCandidates.length
  ) {
    return null;
  }

  const seedWord =
    seedCandidates[
      Math.floor(
        rng() *
        seedCandidates.length
      )
    ];

  const grid =
    new Map();

  const placed = [];

  /*
   * Primeira palavra aproximadamente
   * no centro da área disponível.
   */
  const row =
    Math.floor(
      config.rows / 2
    );

  const col =
    Math.max(
      0,
      Math.floor(
        (
          config.cols -
          seedWord.answer.length
        ) / 2
      )
    );

  placeWord(
    grid,
    placed,
    seedWord,
    row,
    col,
    "across"
  );

  const remaining =
    candidates.filter(
      (word) =>
        word.id !==
        seedWord.id
    );

  const holder = {
    best:
      snapshot(
        grid,
        placed,
        config
      ),

    target:
      Math.min(
        targetWords,
        candidates.length
      ),

    nodes: 0,

    maxNodes: 6800,

    deadline,

    config
  };

  search(
    grid,
    placed,
    remaining,
    holder,
    rng,
    7
  );

  return holder.best;
}


/* =========================================================
   BACKTRACKING
   ========================================================= */

function search(
  grid,
  placed,
  remaining,
  holder,
  rng,
  skipsLeft
) {
  holder.nodes += 1;

  const state =
    snapshot(
      grid,
      placed,
      holder.config
    );

  if (
    compareStates(
      state,
      holder.best
    ) > 0
  ) {
    holder.best = state;
  }

  if (
    placed.length >=
      holder.target ||
    remaining.length === 0 ||
    holder.nodes >=
      holder.maxNodes ||
    now() >=
      holder.deadline
  ) {
    return;
  }

  /*
   * Letras já presentes na grade.
   */
  const letters =
    new Set(
      [...grid.values()]
        .map(
          (cell) =>
            cell.letter
        )
    );

  /*
   * Prioriza palavras que compartilham
   * mais letras com a grade atual.
   */
  const likely =
    remaining
      .map((word) => ({
        word,

        overlapPotential:
          countSharedLetters(
            word.answer,
            letters
          )
      }))

      .filter(
        (item) =>
          item.overlapPotential > 0
      )

      .sort((a, b) => {
        if (
          b.overlapPotential !==
          a.overlapPotential
        ) {
          return (
            b.overlapPotential -
            a.overlapPotential
          );
        }

        /*
         * Em igualdade de cruzamentos potenciais,
         * palavras menores recebem vantagem.
         */
        return (
          a.word.answer.length -
          b.word.answer.length
        );
      })

      .slice(0, 22);

  if (
    !likely.length
  ) {
    return;
  }

  const infos = [];

  for (
    const item
    of likely
  ) {
    if (
      now() >=
      holder.deadline
    ) {
      return;
    }

    const placements =
      findPlacements(
        grid,
        item.word,
        holder.config
      );

    if (
      placements.length
    ) {
      infos.push({
        ...item,
        placements
      });
    }
  }

  if (
    !infos.length
  ) {
    return;
  }

  /*
   * "Most constrained first".
   *
   * Uma palavra com poucas posições possíveis
   * é tentada primeiro.
   */
  infos.sort(
    (a, b) => {
      const as =
        a.placements.length -
        a.overlapPotential *
        0.55;

      const bs =
        b.placements.length -
        b.overlapPotential *
        0.55;

      return as - bs;
    }
  );

  const wordChoices =
    infos.slice(
      0,
      Math.min(
        2,
        infos.length
      )
    );

  for (
    const info
    of wordChoices
  ) {
    /*
     * As posições que geram mais cruzamentos
     * ficam no início.
     */
    info.placements.sort(
      (a, b) =>
        (
          b.score +
          rng() * 10
        ) -
        (
          a.score +
          rng() * 10
        )
    );

    const nextRemaining =
      remaining.filter(
        (word) =>
          word.id !==
          info.word.id
      );

    const placementLimit =
      Math.min(
        8,
        info.placements.length
      );

    for (
      let i = 0;
      i < placementLimit;
      i += 1
    ) {
      if (
        holder.nodes >=
          holder.maxNodes ||
        now() >=
          holder.deadline
      ) {
        return;
      }

      const p =
        info.placements[i];

      const changes =
        placeWord(
          grid,
          placed,
          info.word,
          p.row,
          p.col,
          p.direction
        );

      search(
        grid,
        placed,
        nextRemaining,
        holder,
        rng,
        skipsLeft
      );

      undoPlacement(
        grid,
        placed,
        changes
      );

      /*
       * Se já encontramos uma grade
       * com todas as palavras desejadas
       * e densidade boa, podemos encerrar
       * esse ramo.
       */
      if (
        holder.best.placed.length >=
          holder.target &&
        holder.best.stats.density >=
          0.50
      ) {
        return;
      }
    }
  }

  /*
   * Permite ignorar ocasionalmente uma palavra
   * difícil de encaixar.
   */
  if (
    skipsLeft > 0 &&
    remaining.length > 1 &&
    now() <
      holder.deadline
  ) {
    const skipTarget =
      infos[0]?.word?.id;

    if (
      skipTarget != null
    ) {
      search(
        grid,
        placed,

        remaining.filter(
          (word) =>
            word.id !==
            skipTarget
        ),

        holder,
        rng,
        skipsLeft - 1
      );
    }
  }
}


/* =========================================================
   ENCONTRAR POSIÇÕES POSSÍVEIS
   ========================================================= */

function findPlacements(
  grid,
  word,
  config
) {
  const placements = [];

  const seen =
    new Set();

  const bounds =
    getBounds(
      [...grid.values()]
    );

  for (
    const cell
    of grid.values()
  ) {
    for (
      let i = 0;
      i <
      word.answer.length;
      i += 1
    ) {
      if (
        word.answer[i] !==
        cell.letter
      ) {
        continue;
      }

      const possibilities = [
        {
          direction:
            "across",

          row:
            cell.row,

          col:
            cell.col - i
        },

        {
          direction:
            "down",

          row:
            cell.row - i,

          col:
            cell.col
        }
      ];

      for (
        const p
        of possibilities
      ) {
        const sig =
          `${p.direction}:${p.row}:${p.col}`;

        if (
          seen.has(sig)
        ) {
          continue;
        }

        seen.add(sig);

        const valid =
          validatePlacement(
            grid,
            word,
            p.row,
            p.col,
            p.direction,
            config
          );

        if (
          !valid.ok
        ) {
          continue;
        }

        placements.push({
          ...p,

          intersections:
            valid.intersections,

          score:
            scorePlacement(
              bounds,
              word,
              p.row,
              p.col,
              p.direction,
              valid.intersections,
              config
            )
        });
      }
    }
  }

  return placements;
}


/* =========================================================
   VALIDAR POSICIONAMENTO
   ========================================================= */

function validatePlacement(
  grid,
  word,
  row,
  col,
  direction,
  config
) {
  const dr =
    direction === "down"
      ? 1
      : 0;

  const dc =
    direction === "across"
      ? 1
      : 0;

  const endRow =
    row +
    dr *
    (
      word.answer.length -
      1
    );

  const endCol =
    col +
    dc *
    (
      word.answer.length -
      1
    );

  /*
   * Não deixa a palavra sair
   * do limite da grade.
   */
  if (
    row < 0 ||
    col < 0 ||
    endRow >=
      config.rows ||
    endCol >=
      config.cols
  ) {
    return {
      ok: false,
      intersections: 0
    };
  }

  const beforeRow =
    row - dr;

  const beforeCol =
    col - dc;

  const afterRow =
    endRow + dr;

  const afterCol =
    endCol + dc;

  /*
   * Impede que uma palavra seja
   * extensão acidental de outra.
   */
  if (
    inside(
      beforeRow,
      beforeCol,
      config
    ) &&
    grid.has(
      keyOf(
        beforeRow,
        beforeCol
      )
    )
  ) {
    return {
      ok: false,
      intersections: 0
    };
  }

  if (
    inside(
      afterRow,
      afterCol,
      config
    ) &&
    grid.has(
      keyOf(
        afterRow,
        afterCol
      )
    )
  ) {
    return {
      ok: false,
      intersections: 0
    };
  }

  let intersections = 0;

  for (
    let i = 0;
    i <
    word.answer.length;
    i += 1
  ) {
    const r =
      row + dr * i;

    const c =
      col + dc * i;

    const key =
      keyOf(r, c);

    const existing =
      grid.get(key);

    /*
     * Casa já ocupada:
     * só pode servir de cruzamento
     * se a letra for igual.
     */
    if (
      existing
    ) {
      if (
        existing.letter !==
        word.answer[i]
      ) {
        return {
          ok: false,
          intersections: 0
        };
      }

      if (
        direction ===
          "across" &&
        existing.acrossId !=
          null
      ) {
        return {
          ok: false,
          intersections: 0
        };
      }

      if (
        direction ===
          "down" &&
        existing.downId !=
          null
      ) {
        return {
          ok: false,
          intersections: 0
        };
      }

      intersections += 1;

      continue;
    }

    /*
     * Casas novas não podem encostar
     * lateralmente em outra palavra,
     * exceto no cruzamento propriamente dito.
     */
    if (
      direction ===
      "across"
    ) {
      if (
        (
          inside(
            r - 1,
            c,
            config
          ) &&
          grid.has(
            keyOf(
              r - 1,
              c
            )
          )
        ) ||
        (
          inside(
            r + 1,
            c,
            config
          ) &&
          grid.has(
            keyOf(
              r + 1,
              c
            )
          )
        )
      ) {
        return {
          ok: false,
          intersections: 0
        };
      }
    } else {
      if (
        (
          inside(
            r,
            c - 1,
            config
          ) &&
          grid.has(
            keyOf(
              r,
              c - 1
            )
          )
        ) ||
        (
          inside(
            r,
            c + 1,
            config
          ) &&
          grid.has(
            keyOf(
              r,
              c + 1
            )
          )
        )
      ) {
        return {
          ok: false,
          intersections: 0
        };
      }
    }
  }

  /*
   * Toda palavra depois da primeira
   * precisa realmente cruzar outra.
   */
  return intersections > 0
    ? {
        ok: true,
        intersections
      }
    : {
        ok: false,
        intersections: 0
      };
}


/* =========================================================
   PONTUAÇÃO DE UMA POSIÇÃO
   ========================================================= */

function scorePlacement(
  bounds,
  word,
  row,
  col,
  direction,
  intersections,
  config
) {
  const endRow =
    row +
    (
      direction === "down"
        ? word.answer.length - 1
        : 0
    );

  const endCol =
    col +
    (
      direction === "across"
        ? word.answer.length - 1
        : 0
    );

  const minRow =
    Math.min(
      bounds.minRow,
      row,
      endRow
    );

  const maxRow =
    Math.max(
      bounds.maxRow,
      row,
      endRow
    );

  const minCol =
    Math.min(
      bounds.minCol,
      col,
      endCol
    );

  const maxCol =
    Math.max(
      bounds.maxCol,
      col,
      endCol
    );

  const width =
    maxCol -
    minCol +
    1;

  const height =
    maxRow -
    minRow +
    1;

  const area =
    width * height;

  const growth =
    Math.max(
      0,
      area -
      bounds.area
    );

  const centerR =
    (
      row +
      endRow
    ) / 2;

  const centerC =
    (
      col +
      endCol
    ) / 2;

  const boardCenterR =
    (
      config.rows -
      1
    ) / 2;

  const boardCenterC =
    (
      config.cols -
      1
    ) / 2;

  const centerDistance =
    Math.abs(
      centerR -
      boardCenterR
    ) +
    Math.abs(
      centerC -
      boardCenterC
    );

  const extraHeight =
    Math.max(
      0,
      height -
      width -
      4
    );

  /*
   * Cruzamentos recebem a maior recompensa.
   *
   * Crescer demais a área é penalizado.
   */
  return (
    intersections *
      180 -

    growth *
      2.8 -

    centerDistance *
      1.2 -

    extraHeight *
      120
  );
}


/* =========================================================
   INSERÇÃO / REMOÇÃO
   ========================================================= */

function placeWord(
  grid,
  placed,
  word,
  row,
  col,
  direction
) {
  const dr =
    direction ===
      "down"
      ? 1
      : 0;

  const dc =
    direction ===
      "across"
      ? 1
      : 0;

  const changes = [];

  for (
    let i = 0;
    i <
    word.answer.length;
    i += 1
  ) {
    const r =
      row +
      dr * i;

    const c =
      col +
      dc * i;

    const key =
      keyOf(r, c);

    const previous =
      grid.get(key);

    changes.push({
      key,

      previous:
        previous
          ? {
              ...previous
            }
          : null
    });

    const next =
      previous
        ? {
            ...previous
          }
        : {
            row: r,
            col: c,

            letter:
              word.answer[i],

            acrossId:
              null,

            downId:
              null
          };

    if (
      direction ===
      "across"
    ) {
      next.acrossId =
        word.id;
    } else {
      next.downId =
        word.id;
    }

    grid.set(
      key,
      next
    );
  }

  placed.push({
    id:
      word.id,

    answer:
      word.answer,

    display:
      word.display,

    clue:
      word.clue,

    theme:
      word.theme,

    subtheme:
      word.subtheme,

    difficulty:
      word.difficulty,

    row,
    col,
    direction
  });

  return changes;
}


function undoPlacement(
  grid,
  placed,
  changes
) {
  placed.pop();

  for (
    let i =
      changes.length - 1;

    i >= 0;

    i -= 1
  ) {
    const change =
      changes[i];

    if (
      change.previous
    ) {
      grid.set(
        change.key,
        change.previous
      );
    } else {
      grid.delete(
        change.key
      );
    }
  }
}


/* =========================================================
   AVALIAR UMA GRADE
   ========================================================= */

function snapshot(
  grid,
  placed,
  config
) {
  const cells =
    [...grid.values()]
      .map(
        (cell) => ({
          ...cell
        })
      );

  const placedCopy =
    placed.map(
      (word) => ({
        ...word
      })
    );

  const stats =
    stateStats(
      cells,
      placedCopy,
      config
    );

  return {
    cells,
    placed:
      placedCopy,
    stats
  };
}


function stateStats(
  cells,
  placed,
  config
) {
  const bounds =
    getBounds(cells);

  const intersections =
    cells.filter(
      (cell) =>
        cell.acrossId !=
          null &&
        cell.downId !=
          null
    ).length;

  const density =
    bounds.area
      ? cells.length /
        bounds.area
      : 0;

  /*
   * Mede a maior região contínua
   * de casas pretas/vazias.
   */
  const largestBlack =
    largestBlackRegion(
      cells,
      bounds
    );

  /*
   * A altura pode superar a largura,
   * mas há penalização depois de
   * quatro linhas extras.
   */
  const extraHeight =
    Math.max(
      0,
      bounds.height -
      bounds.width -
      4
    );

  const tooNarrow =
    Math.max(
      0,
      8 -
      bounds.width
    );

  const aspect =
    bounds.height /
    Math.max(
      1,
      bounds.width
    );

  /*
   * A quantidade de palavras continua
   * tendo peso muito alto.
   *
   * Depois vêm cruzamentos e densidade.
   */
  const score =
    placed.length *
      5200 +

    intersections *
      320 +

    density *
      5200 -

    largestBlack *
      22 -

    extraHeight *
      1900 -

    tooNarrow *
      900 -

    Math.max(
      0,
      aspect -
      1.5
    ) *
      1400 -

    bounds.area *
      1.8;

  return {
    intersections,
    density,
    largestBlack,

    width:
      bounds.width,

    height:
      bounds.height,

    area:
      bounds.area,

    score
  };
}


/* =========================================================
   REGIÕES VAZIAS
   ========================================================= */

function largestBlackRegion(
  cells,
  bounds
) {
  if (
    !cells.length
  ) {
    return 0;
  }

  const occupied =
    new Set(
      cells.map(
        (cell) =>
          keyOf(
            cell.row,
            cell.col
          )
      )
    );

  const visited =
    new Set();

  let largest = 0;

  for (
    let r =
      bounds.minRow;

    r <=
      bounds.maxRow;

    r += 1
  ) {
    for (
      let c =
        bounds.minCol;

      c <=
        bounds.maxCol;

      c += 1
    ) {
      const start =
        keyOf(r, c);

      if (
        occupied.has(start) ||
        visited.has(start)
      ) {
        continue;
      }

      let size = 0;

      const queue = [
        [r, c]
      ];

      visited.add(start);

      for (
        let q = 0;
        q <
        queue.length;
        q += 1
      ) {
        const [
          cr,
          cc
        ] = queue[q];

        size += 1;

        const neighbors = [
          [
            cr - 1,
            cc
          ],

          [
            cr + 1,
            cc
          ],

          [
            cr,
            cc - 1
          ],

          [
            cr,
            cc + 1
          ]
        ];

        for (
          const [
            nr,
            nc
          ]
          of neighbors
        ) {
          if (
            nr <
              bounds.minRow ||
            nr >
              bounds.maxRow ||
            nc <
              bounds.minCol ||
            nc >
              bounds.maxCol
          ) {
            continue;
          }

          const key =
            keyOf(
              nr,
              nc
            );

          if (
            occupied.has(key) ||
            visited.has(key)
          ) {
            continue;
          }

          visited.add(key);

          queue.push(
            [
              nr,
              nc
            ]
          );
        }
      }

      largest =
        Math.max(
          largest,
          size
        );
    }
  }

  return largest;
}


/* =========================================================
   COMPARAÇÃO DAS SOLUÇÕES
   ========================================================= */

function compareStates(
  a,
  b
) {
  if (!b) {
    return 1;
  }

  if (
    a.placed.length !==
    b.placed.length
  ) {
    return (
      a.placed.length -
      b.placed.length
    );
  }

  return (
    a.stats.score -
    b.stats.score
  );
}


function comparePuzzles(
  a,
  b
) {
  const aGoodShape =
    a.rows <=
    a.cols + 4
      ? 1
      : 0;

  const bGoodShape =
    b.rows <=
    b.cols + 4
      ? 1
      : 0;

  /*
   * Quando as duas grades já possuem
   * bastante conteúdo, favorece aquela
   * dentro da proporção desejada.
   */
  if (
    a.words.length >= 14 &&
    b.words.length >= 14 &&
    aGoodShape !==
      bGoodShape
  ) {
    return (
      aGoodShape -
      bGoodShape
    );
  }

  if (
    a.words.length !==
    b.words.length
  ) {
    return (
      a.words.length -
      b.words.length
    );
  }

  return (
    a.stats.score -
    b.stats.score
  );
}


function isExcellent(
  puzzle,
  targetWords
) {
  return (
    puzzle.words.length >=
      targetWords &&

    puzzle.rows <=
      puzzle.cols + 4 &&

    puzzle.stats.density >=
      0.50 &&

    puzzle.stats.intersections >=
      Math.max(
        8,
        Math.floor(
          targetWords *
          0.55
        )
      )
  );
}


/* =========================================================
   FINALIZAÇÃO DA GRADE
   ========================================================= */

function finalize(
  snapshot,
  seed,
  selectedDifficulty
) {
  const bounds =
    getBounds(
      snapshot.cells
    );

  /*
   * Remove linhas e colunas vazias
   * existentes nas bordas.
   */
  const rowShift =
    -bounds.minRow;

  const colShift =
    -bounds.minCol;

  const words =
    snapshot.placed.map(
      (word) => ({
        ...word,

        row:
          word.row +
          rowShift,

        col:
          word.col +
          colShift
      })
    );

  const cells =
    snapshot.cells.map(
      (cell) => ({
        ...cell,

        row:
          cell.row +
          rowShift,

        col:
          cell.col +
          colShift
      })
    );

  assignNumbers(
    words,
    cells
  );

  words.sort(
    (a, b) =>
      a.number -
        b.number ||
      a.direction.localeCompare(
        b.direction
      )
  );

  cells.sort(
    (a, b) =>
      a.row -
        b.row ||
      a.col -
        b.col
  );

  return {
    seed,

    selectedDifficulty,

    rows:
      bounds.height,

    cols:
      bounds.width,

    cells,

    words,

    stats: {
      ...snapshot.stats,

      density:
        Number(
          snapshot.stats
            .density
            .toFixed(3)
        ),

      score:
        Math.round(
          snapshot.stats.score
        )
    }
  };
}


/* =========================================================
   NUMERAÇÃO
   ========================================================= */

function assignNumbers(
  words,
  cells
) {
  const starts =
    new Map();

  for (
    const word
    of words
  ) {
    const key =
      keyOf(
        word.row,
        word.col
      );

    if (
      !starts.has(key)
    ) {
      starts.set(
        key,
        []
      );
    }

    starts
      .get(key)
      .push(word);
  }

  const ordered =
    [...starts.entries()]
      .map(
        (
          [
            key,
            startingWords
          ]
        ) => {
          const [
            row,
            col
          ] =
            key
              .split(",")
              .map(Number);

          return {
            key,
            row,
            col,
            startingWords
          };
        }
      )

      .sort(
        (a, b) =>
          a.row -
            b.row ||
          a.col -
            b.col
      );

  const numberByKey =
    new Map();

  ordered.forEach(
    (
      item,
      index
    ) => {
      const number =
        index + 1;

      numberByKey.set(
        item.key,
        number
      );

      item.startingWords
        .forEach(
          (word) => {
            word.number =
              number;
          }
        );
    }
  );

  for (
    const cell
    of cells
  ) {
    cell.number =
      numberByKey.get(
        keyOf(
          cell.row,
          cell.col
        )
      ) || null;
  }
}


/* =========================================================
   COMPATIBILIDADE ENTRE PALAVRAS
   ========================================================= */

function compatibilityScores(
  words
) {
  const hist =
    new Map(
      words.map(
        (word) => [
          word.id,
          histogram(
            word.answer
          )
        ]
      )
    );

  const scores =
    new Map();

  for (
    const word
    of words
  ) {
    let score = 0;

    const own =
      hist.get(word.id);

    for (
      const other
      of words
    ) {
      if (
        other.id ===
        word.id
      ) {
        continue;
      }

      const shared =
        sharedPotential(
          own,
          hist.get(
            other.id
          )
        );

      if (
        shared > 0
      ) {
        score +=
          1 +
          Math.min(
            5,
            shared
          ) *
          0.42;
      }
    }

    scores.set(
      word.id,
      score
    );
  }

  return scores;
}


function histogram(
  answer
) {
  const map =
    new Map();

  for (
    const letter
    of answer
  ) {
    map.set(
      letter,

      (
        map.get(letter) ||
        0
      ) + 1
    );
  }

  return map;
}


function sharedPotential(
  a,
  b
) {
  let shared = 0;

  for (
    const [
      letter,
      count
    ]
    of a
  ) {
    if (
      b.has(letter)
    ) {
      shared +=
        Math.min(
          count,
          b.get(letter)
        );
    }
  }

  return shared;
}


function countSharedLetters(
  answer,
  set
) {
  let count = 0;

  const seen =
    new Set();

  for (
    const letter
    of answer
  ) {
    if (
      !seen.has(letter) &&
      set.has(letter)
    ) {
      seen.add(letter);

      count += 1;
    }
  }

  return count;
}


/* =========================================================
   LIMITES DA GRADE
   ========================================================= */

function getBounds(
  cells
) {
  if (
    !cells.length
  ) {
    return {
      minRow: 0,
      maxRow: 0,
      minCol: 0,
      maxCol: 0,
      width: 1,
      height: 1,
      area: 1
    };
  }

  let minRow =
    Infinity;

  let maxRow =
    -Infinity;

  let minCol =
    Infinity;

  let maxCol =
    -Infinity;

  for (
    const cell
    of cells
  ) {
    minRow =
      Math.min(
        minRow,
        cell.row
      );

    maxRow =
      Math.max(
        maxRow,
        cell.row
      );

    minCol =
      Math.min(
        minCol,
        cell.col
      );

    maxCol =
      Math.max(
        maxCol,
        cell.col
      );
  }

  const width =
    maxCol -
    minCol +
    1;

  const height =
    maxRow -
    minRow +
    1;

  return {
    minRow,
    maxRow,
    minCol,
    maxCol,
    width,
    height,
    area:
      width *
      height
  };
}


function inside(
  row,
  col,
  config
) {
  return (
    row >= 0 &&
    col >= 0 &&
    row <
      config.rows &&
    col <
      config.cols
  );
}


function keyOf(
  row,
  col
) {
  return `${row},${col}`;
}


/* =========================================================
   NÚMEROS ALEATÓRIOS
   ========================================================= */

function makeRng(
  seed
) {
  let state =
    seed ||
    0x9e3779b9;

  return function random() {
    state ^=
      state << 13;

    state ^=
      state >>> 17;

    state ^=
      state << 5;

    state >>>= 0;

    return (
      state /
      4294967296
    );
  };
}


function now() {
  return (
    globalThis.performance
      ?.now?.() ??
    Date.now()
  );
}
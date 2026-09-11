export const ANSWER_PATTERN = /^[A-Z]+$/;

export function validateBank(raw) {
  const source = Array.isArray(raw) ? raw : raw?.perguntas;
  if (!Array.isArray(source)) {
    throw new Error('palavras.json deve ser um array ou conter a propriedade "perguntas".');
  }

  const warnings = [];
  const words = [];
  const ids = new Set();
  const answers = new Map();

  for (const item of source) {
    const id = item?.id;
    const answer = typeof item?.resposta === "string" ? item.resposta.trim() : "";
    const clue = typeof item?.dica === "string" ? item.dica.trim() : "";
    const theme = typeof item?.tema === "string" ? item.tema.trim() : "";
    const difficulty = Number(item?.dificuldade);
    const prefix = `ID ${id ?? "sem-id"}`;

    if (!Number.isInteger(id)) {
      warnings.push(`${prefix}: id inválido.`);
      continue;
    }
    if (ids.has(id)) {
      warnings.push(`${prefix}: id duplicado.`);
      continue;
    }
    ids.add(id);

    if (!ANSWER_PATTERN.test(answer)) {
      warnings.push(`${prefix}: "resposta" deve conter apenas A-Z (${JSON.stringify(answer)}).`);
      continue;
    }
    if (answer.length < 2) {
      warnings.push(`${prefix}: resposta curta demais.`);
      continue;
    }
    if (!clue) {
      warnings.push(`${prefix}: dica vazia.`);
      continue;
    }
    if (!theme) {
      warnings.push(`${prefix}: tema vazio.`);
      continue;
    }
    if (![1, 2, 3].includes(difficulty)) {
      warnings.push(`${prefix}: dificuldade deve ser 1, 2 ou 3.`);
      continue;
    }
    if (item?.ativo === false) continue;

    if (answers.has(answer)) {
      warnings.push(`${prefix}: resposta duplicada com o ID ${answers.get(answer)} (${answer}).`);
      continue;
    }
    answers.set(answer, id);

    words.push({
      id,
      resposta: answer,
      exibicao: typeof item?.exibicao === "string" && item.exibicao.trim()
        ? item.exibicao.trim()
        : answer,
      dica: clue,
      tema: theme,
      subtema: typeof item?.subtema === "string" ? item.subtema.trim() : "",
      dificuldade: difficulty
    });
  }

  return { words, warnings };
}

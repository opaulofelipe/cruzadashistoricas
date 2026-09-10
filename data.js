import { validateBank } from "./validator.js";

export const ALL_THEMES = "__ALL__";

export const THEME_LABELS = new Map([
  ["Pré-História", "Pré-História"],
  ["Antiguidade", "História Antiga"],
  ["Idade Média", "História Medieval"],
  ["Idade Moderna", "História Moderna"],
  ["Idade Contemporânea", "História Contemporânea"],
  ["História do Brasil", "História do Brasil"]
]);

export const THEME_ORDER = [
  "Pré-História",
  "Antiguidade",
  "Idade Média",
  "Idade Moderna",
  "Idade Contemporânea",
  "História do Brasil"
];

export const DIFFICULTY_LABELS = {
  1: "Fácil",
  2: "Médio",
  3: "Difícil"
};

export async function loadWordBank(url = "./palavras.json") {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Falha ao carregar ${url}: HTTP ${response.status}`);
  const raw = await response.json();
  return validateBank(raw);
}

export function themeLabel(theme) {
  return THEME_LABELS.get(theme) || theme;
}

export function getAvailableThemes(bank) {
  const themes = [...new Set(bank.map((word) => word.tema))];
  return themes.sort((a, b) => {
    const ia = THEME_ORDER.indexOf(a);
    const ib = THEME_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) {
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    }
    return themeLabel(a).localeCompare(themeLabel(b), "pt-BR");
  });
}

export function filterByTheme(bank, theme) {
  return theme === ALL_THEMES ? bank : bank.filter((word) => word.tema === theme);
}

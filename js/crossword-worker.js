import { generateCrossword } from "./generator.js";

self.addEventListener("message", (event) => {
  if (event.data?.type !== "generate") return;

  try {
    const puzzle = generateCrossword(
      event.data.words,
      event.data.options || {},
      (progress) => self.postMessage({ type: "progress", ...progress })
    );

    self.postMessage({ type: "result", puzzle });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Erro desconhecido no gerador."
    });
  }
});

import { generateCrossword } from "./generator.js?v=20260911-dense1";

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type !== "generate") return;

  try {
    const puzzle = generateCrossword(
      message.words,
      message.options,
      (progress) => self.postMessage({ type: "progress", ...progress })
    );

    self.postMessage({ type: "result", puzzle });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Erro ao gerar a cruzadinha."
    });
  }
});

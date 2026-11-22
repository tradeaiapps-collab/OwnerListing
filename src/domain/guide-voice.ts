/** Helpers for talking to the floating guide (Elena) by microphone. Pure, so they can be unit tested. */

/** Joins the pieces the browser's speech recogniser heard into one tidy question, capped at `max` characters. */
export function cleanTranscript(parts: readonly string[], max: number): string {
  const joined = parts.map(p => p.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= max) return joined;
  const cut = joined.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Plain-English reason shown when the microphone stops with an error. */
export function micErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed": return "The microphone is blocked. Allow it in the address bar, or just type your question.";
    case "no-speech": return "I did not hear anything. Tap the microphone and try again.";
    case "audio-capture": return "I cannot find a microphone on this device. You can type instead.";
    case "network": return "Speech recognition needs an internet connection in this browser. You can type instead.";
    default: return "The microphone stopped. Tap it to try again, or type your question.";
  }
}

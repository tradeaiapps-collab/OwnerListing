/**
 * The AI runs on our own servers. Nothing here names an outside company: the engine is whatever model the admin
 * installs (an open-source model on our GPU server). Swapping engines never changes the rules around it.
 */
export interface AiEngineInfo { id: string; kind: "self_hosted" | "rules_only"; version: string }

export interface AiEnginePort {
  info(): AiEngineInfo;
  /** Reads text from a document (PDF or scanned image) using tools on our own server. */
  readDocument(file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<string>;
  /** Looks at a photo and returns plain observations ("kitchen, timber floor"). */
  describePhoto(file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<string[]>;
  /** Writes text from a prompt. Output always passes the guards before anyone sees it. */
  generate(prompt: string): Promise<string>;
}

/** Used until a model is installed: every feature reports it is off, so nothing is invented. */
export const rulesOnlyEngine: AiEnginePort = {
  info: () => ({ id: "none", kind: "rules_only", version: "0" }),
  readDocument: async () => { throw new Error("No AI engine is installed yet."); },
  describePhoto: async () => { throw new Error("No AI engine is installed yet."); },
  generate: async () => { throw new Error("No AI engine is installed yet."); }
};

/** An engine counts as available only if it is self-hosted, so data never leaves our servers. */
export function isEngineUsable(e: AiEnginePort): boolean {
  return e.info().kind === "self_hosted";
}

/** Inbound email helpers for Elena. Pure. */

const AUTOMATED_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce[s]?|notification[s]?|alerts?)\b/i;

/** True for mail from a robot: no-reply style senders, bulk or auto-generated mail. Elena never answers these (it prevents reply loops). */
export function isAutomatedSender(from: string, headers: Record<string, unknown>): boolean {
  if (AUTOMATED_LOCAL.test(from.split("@")[0] ?? "")) return true;
  const get = (k: string) => {
    const hit = Object.entries(headers).find(([name]) => name.toLowerCase() === k);
    return typeof hit?.[1] === "string" ? hit[1].toLowerCase() : "";
  };
  const auto = get("auto-submitted");
  if (auto !== "" && auto !== "no") return true;
  if (["bulk", "junk", "list"].includes(get("precedence"))) return true;
  return get("x-auto-response-suppress") !== "" || get("list-unsubscribe") !== "";
}

/** The new text of a reply: drops quoted lines, "On ... wrote:" tails and signatures, and caps the length. */
export function cleanInboundEmailText(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(on .{5,120} wrote:|-----original message-----|from:\s.+|sent from my )/i.test(line) || /^--\s*$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").trim().slice(0, 1000);
}

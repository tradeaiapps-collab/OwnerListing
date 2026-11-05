import { createHash } from "node:crypto";
import { latin1, pdfText } from "./report-export";
import type { SigningDoc, SigningEvent } from "./signing-service";

/**
 * The signed copy of a completed document, as a PDF: the full text, who signed (name, email, time, address), an excerpt of the audit
 * trail and a seal. Built only from permanent records, so the same document always gives the same file (apart from the print time).
 * The seal is the SHA-256 of the document text hash plus every signature record; anyone can recompute it from the PDF's own fields.
 * Dependency-free (built-in Helvetica; text outside Latin-1 becomes "?").
 */
export interface SignatureRecord { signerId: string; role: string; name: string; email: string; typedName: string; signedAt: string; ip: string }

const EVENT_TEXT: Record<string, string> = {
  created: "Document created", sent: "Sent for signature", viewed: "Opened the document", explained: "Asked for an explanation", signed: "Signed",
  declined: "Declined to sign", completed: "Everyone has signed", cancelled: "Cancelled", owner_viewed: "Owner viewed the document", sign_failed: "Signing attempt refused"
};

export function signatureRecords(doc: SigningDoc, events: readonly SigningEvent[], emails: Readonly<Record<string, string>>): SignatureRecord[] {
  return doc.signers.filter(s => s.status === "signed" && s.signedAt).map(s => ({
    signerId: s.id, role: s.roleLabel, name: s.displayName, email: emails[s.id] ?? "", typedName: s.typedName ?? "", signedAt: s.signedAt!,
    ip: events.find(e => e.eventType === "signed" && e.signerId === s.id)?.ip ?? "not recorded"
  }));
}

/** SHA-256 over the text hash and the signature records, in a fixed field order. */
export function sealOf(doc: Pick<SigningDoc, "id" | "bodySha256">, sigs: readonly SignatureRecord[]): string {
  const canonical = JSON.stringify({ document: doc.id, bodySha256: doc.bodySha256, signatures: sigs.map(s => [s.signerId, s.typedName, s.signedAt, s.ip]) });
  return createHash("sha256").update(canonical).digest("hex");
}

const W = 595, H = 842, M = 50, SIZE = 10, LEAD = 14, CHAR = 0.52;

export function buildSignedPdf(doc: SigningDoc, events: readonly SigningEvent[], emails: Readonly<Record<string, string>>, printedAt: string): Uint8Array {
  const sigs = signatureRecords(doc, events, emails);
  const seal = sealOf(doc, sigs);
  const pages: string[][] = [];
  let ops: string[] = [], y = 0;
  const newPage = () => { ops = []; pages.push(ops); y = H - M; };
  const wrap = (text: string, size: number): string[] => {
    const max = Math.max(10, Math.floor((W - 2 * M) / (size * CHAR)));
    const out: string[] = [];
    for (const para of text.split("\n").map(latin1)) {
      let line = "";
      for (const word of para.split(" ")) {
        let w = word;
        while (w.length > max) { if (line) { out.push(line); line = ""; } out.push(w.slice(0, max)); w = w.slice(max); }
        if (!line) line = w; else if (line.length + 1 + w.length <= max) line += ` ${w}`; else { out.push(line); line = w; }
      }
      out.push(line);
    }
    return out;
  };
  const put = (text: string, size = SIZE, bold = false, gap = 0) => {
    for (const l of wrap(text, size)) {
      if (y < M + LEAD) newPage();
      ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${M} ${y} Td (${pdfText(l)}) Tj ET`);
      y -= size === SIZE ? LEAD : size + 4;
    }
    y -= gap;
  };
  newPage();
  put(doc.title, 16, true, 4);
  put(`Signed copy. Listing: ${doc.listingTitle}`, SIZE, false, 8);
  doc.clauses.forEach((c, i) => { put(`${i + 1}. ${c.heading}`, 11, true); put(c.text, SIZE, false, 6); });

  put("Signatures", 13, true, 2);
  for (const s of sigs) {
    put(`${s.role}: ${s.name}`, SIZE, true);
    put(`Signed as: ${s.typedName}   Email: ${s.email || "not recorded"}\nTime: ${s.signedAt}   Address: ${s.ip}\nConsent: electronic signature`, SIZE, false, 6);
  }
  put("Audit trail (excerpt)", 13, true, 2);
  for (const e of events.filter(x => x.eventType !== "owner_viewed" && x.eventType !== "explained" && x.eventType !== "viewed")) {
    put(`${e.occurredAt}  ${EVENT_TEXT[e.eventType] ?? e.eventType}  (${e.actorName}${e.ip ? `, ${e.ip}` : ""})`);
  }
  y -= 8;
  put("Seal", 13, true, 2);
  put(`Document text SHA-256: ${doc.bodySha256}\nSeal SHA-256: ${seal}\nDocument id: ${doc.id}\nPrinted: ${printedAt}`);
  put("The seal covers the exact text signed and each signature record above. Open the document on the platform to compare these values; any change to the text or a signature gives a different seal.", 8);

  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const body = p.join("\n");
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Array.from(out, c => c.charCodeAt(0) & 255));
}

# Elena document analyst

Elena reads an inspection report, contract, market report or email and returns a summary, key facts, flags, opportunities, next steps and (inspections) an indicative repair cost. Rule based and self-hosted: no external AI account, same text gives the same answer, every flag quotes its source sentence. Wording is a reading aid, not legal or building advice (the disclaimer travels with every result).

## Pieces
- `src/domain/doc-analyst.ts` pure engine: classify, extractive key points, fact extraction, rule tables (contract, inspection, market, email), template summary, `compareAnalyses` (2 to 6 documents), `buildEmailDigest`. Bump `ENGINE_VERSION` when rules change; stored readings are per engine, so old documents are re-read once.
- `src/server/doc-extract.ts` bytes to text. PDF text operators (Flate, size and stream caps), plain text, HTML, `.eml`. Scanned PDFs and images return `needs_ocr`; plug a self-hosted `OcrPort` (for example Tesseract behind an internal service) into `getAnalystDeps` to read them.
- `src/domain/doc-analysis-service.ts` access, caching, rate limit (30 readings per user per hour), audit, owner notice, sharing. Access is exactly the document download rule (`canViewDocument`); anything else answers not_found.
- `db/20261105200000_document_analysis.sql` insert-only `document_analysis` and `document_analysis_share`.

## API (session required, CSRF on writes)
| Route | Purpose |
|---|---|
| `POST /api/documents/{id}/analysis` | read the document (stored reading if unchanged) |
| `GET /api/documents/{id}/analysis` | latest stored reading |
| `POST /api/document-analysis/compare` `{documentIds}` | multi-document comparison |
| `POST /api/document-analysis/digest` `{emails:[text]}` | email digest, nothing stored |
| `POST /api/document-analysis/{id}/share` `{userIds}` | owner notifies people who can already view the document |

## Rules kept
Elena never accepts or decides. Sharing never widens access (recipients must already be able to view the file; `owner_only` files cannot be shared). Document text is data and is never executed or followed. Cost ranges are labelled indicative unless the report states the figure.

## Deploy
Run `npm run migrate`. No new keys or services. Optional later: OCR port, a UI panel on `/listings/{id}/documents`, wording review by counsel for the contract flags.

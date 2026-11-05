# Elena in other languages

Elena detects the language a person writes in, answers in it, translates thread messages and documents, and remembers the choice.
All AI runs on our own server (project rule: no outside AI account). Without a model installed everything below degrades safely.

## Languages (14)
English, Simplified Chinese (Mandarin), Traditional Chinese (Cantonese written form), Arabic, Persian, Vietnamese, Punjabi, Hindi (also typed in Latin letters), Tamil, Greek, Italian, Spanish, Filipino, Korean.
List and tone notes: `CHAT_LANGUAGES` in `src/domain/multilingual.ts`. Add a language there, in `PHRASES`, `LEXICON` and `src/domain/language-detect.ts`.

## How it works
| Piece | File |
|---|---|
| Detection (script, then word lists; confidence; Cantonese and romanised Hindi flagged) | `src/domain/language-detect.ts` |
| Tone per language, fixed phrases, topic words, translation pipeline | `src/domain/multilingual.ts` |
| Preference, answer localisation, message and document translation | `src/domain/multilingual-service.ts` |
| Postgres and wiring | `src/server/multilingual-db.ts`, `db/20261105210000_multilingual.sql` |

- **Answering.** A question in another language is matched on its English meaning (model translation, else the word lists), Elena builds the answer in English from the facts as before, then it is translated with her tone for that language. The English answer stays the record; translations are separate append-only rows (`ml_translation`).
- **Language choice.** `PUT /api/settings/language {language: "auto" | code}`. Auto follows what the person writes; a short "ok" keeps the last language. Stored in `user_preference.chat_language` and `last_detected_language`.
- **Messages.** `POST /api/enquiries/:id/messages/:messageId/translate {to?}` for either party; saved once per language, labelled machine translation, original untouched.
- **Documents.** `POST /api/enquiries/:id/translate-document {text, kind, to?, from?}` (offer, contract, inspection, other; up to 30,000 characters). Layout (lines, bullets, numbering, headings, table cells) is kept. Numbers, money, contact details and the listing's name and address are swapped for placeholders before translation and must come back exactly, or that line stays in English and `complete` is false. Nothing is stored; the audit log records only the kind, languages and length. The result always says the English version applies.
- **Safety.** Prompts keep user text fenced as data. Output must be in the target script. The wording filter also checks the English meaning of a question. Rate limit 60 translations per person per hour.
- **Voice.** Speech and the microphone use the language's BCP 47 tag. Cantonese uses zh-HK. Accent follows the device's voices; the browser picks the nearest.

## No model installed
Elena still understands the main topics in every language (word lists), replies with a short note in the person's language, and shows the English answer. Message and document translation return "unavailable". Welcome text is always shown in the person's language.

## Before announcing a language
1. A native speaker checks `PHRASES` and the tone note for that language (drafted, not yet reviewed).
2. Try real questions on the installed model and check quality. Models differ a lot on Punjabi, Tamil and Cantonese; leave a language out of `CHAT_LANGUAGES` if the model is poor at it.
3. Translated contracts are for understanding only (counsel has not reviewed this wording).

## Deploy
Run `npm run migrate` (adds two columns and `ml_translation`). No new environment variables. Turn AI on at /staff/ai with the model installed (docs/LOCAL_TEST.md). Rollback steps are at the top of the migration.

## Limits
Detection is by script and word lists: very short Latin-script text can be wrong, romanised Vietnamese without accents is not detected, and Hindi vs Marathi/Nepali share a script. Live lip-sync only exists for English scripted lines.

# Elena brain: knowledge, suburb analyst, investment analyzer

Pure code, no external AI. Routes one question to the right part and never gives personal advice ("should I buy", "will prices rise" are declined with the facts she can show instead).

| Part | File | What it does |
|---|---|---|
| Knowledge base | `src/domain/elena-knowledge.ts` | ~40 entries: property types, terms, buying/selling, negotiation, investing, renting, costs. `searchKnowledge()` ranks by keyword. Append to `KNOWLEDGE`; ids never change. |
| Suburb analyst | `src/domain/elena-analysts.ts` `suburbProfile` | Strengths and watch points from platform sales, trend, forecast, fundamentals and buyer demand. Schools, transport, amenities, crime and demographics are only shown if a `SuburbFacts` feed is supplied; otherwise listed as gaps with the official source to check. |
| Investment analyzer | `analyseInvestment`, `portfolioMix` | Gross/net yield, cash flow, break-even rent, +1/2/3 point rate stress, cash-on-cash, optional 5-year view, risk flags, suburb concentration. Assumed inputs are named in the answer. |
| Brain | `src/domain/elena-brain.ts` | `answerQuestion(question, appContext, data)`. Suburb comes from the question, then open listing, project, buyer search. Market questions reuse `extendedAnswer` (market-forecast). |
| Route | `POST /api/elena/ask` | Signed in only, CSRF, 240/hour via the existing intelligence limiter. Body `{question, context?: {page, suburb, postcode, propertyType, role}}`. Returns the answer plus `suggestionId`. |

Learning: each substantive answer is recorded with `noteSuggestion` (feature `other`, type = kind of answer, e.g. `suburb_profile`, `knowledge_negotiation`), only with the person's training consent and without the question text. `POST /api/elena/feedback` with the `suggestionId` records helpful/not, which feeds the existing weekly/monthly learning jobs.

Disclosure: state rules are Compliance-owned (`/staff/disclosures`); the knowledge base only points to the approved checklist.

Limits and next steps: no UI yet (route only); listing price/rent in context is not loaded server-side yet (numbers must be in the question); no neighbourhood data feed; learned weights do not yet re-rank knowledge answers.

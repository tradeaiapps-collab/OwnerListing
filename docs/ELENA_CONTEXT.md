# Elena: page awareness, auto-fill and learning

Code: `src/domain/elena-context.ts` (pure), `app/elena-context.tsx` (tracker, mounted in `app/layout.tsx`), `app/listings/elena-listing-assistant.tsx`, nudge in `app/guide-assistant.tsx`.

**Where is the person.** `ElenaContextTracker` follows the route and the last field or section the person focused or clicked. Listing form fields map to sections (basics, what you are listing, location, price, description, features, photos). Other pages use the nearest `data-elena-section` or labelled region. Elena's own panels are ignored so her clicks never move "where you are". Any component reads it with `useElenaContext()`. It lives in the tab's memory only: never sent to the server, never stored.

**Active presence.** The Elena panel shows "You are in: Price" with a hint and one action for that section, and asks the question for that section first. After 4 seconds in a section with the chat closed, a small bubble beside "Ask Elena" offers help once per section ("Help me here" / "Not now"). The chat shows "I can see you are on Create a listing, in Price".

**Auto-fill.** Elena fills fields herself, only empty ones, and lists each with an Undo: (1) room counts she reads from the description ("3 bed 2 bath"), once per field, and she leaves it alone if the person clears it; (2) "Tell Elena about the property" sends notes to the quick-setup route and fills suburb, postcode, rooms, price, state, type, features, title and description. Numbers are only read from the person's own words. Nothing is saved until the person saves the form.

**How Elena learns.** See `docs/ELENA_LEARNING.md`. Summary: every suggestion and what the person did with it (kept, edited, skipped) is recorded as a coded event; weekly and monthly jobs turn those into acceptance rates and weights (statistics, not model retraining); a super admin activates a proposed version; some features run a control arm to check the learning helps. In the listing form, `listing_assistant_feedback` stores only fixed keys and length change, never the person's text, and "Forget what Elena learned" wipes it. Page and section tracking adds no new data collection.

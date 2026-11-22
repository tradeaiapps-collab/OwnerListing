import { useEffect, useId, useRef, useState } from "react";

interface Parts { address: string; suburb?: string; state?: string; postcode?: string }
interface Suggestion { id: string; main: string; secondary: string; parts?: Parts }
type Status = "idle" | "loading" | "ready" | "error" | "signin";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;
const ATTRIBUTION: Record<string, string> = { google: "Suggestions by Google", osm: "Suggestions © OpenStreetMap contributors" };

const newSession = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2, 10));

/** Sets an uncontrolled sibling field (suburb, postcode, state) in the same form. */
function setFormField(form: HTMLFormElement | null, name: string, value: string | undefined) {
  if (!form || !value) return;
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = value;
}

/**
 * Street address with suggestions while typing (combobox pattern). Picking one fills the address and the suburb, postcode
 * and state fields. The owner can always ignore the list and type the address in full; nothing here blocks saving.
 */
export function AddressField({ defaultValue = "", invalid = false }: { defaultValue?: string; invalid?: boolean }) {
  const id = useId();
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState<string | null>(null); // only set by typing, so filling in a pick does not search again
  const session = useRef(newSession());

  useEffect(() => {
    if (query === null) return;
    const q = query.trim();
    if (q.length < MIN_CHARS) { setItems([]); setStatus("idle"); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setStatus("loading");
      try {
        const res = await fetch(`/api/address/suggest?${new URLSearchParams({ q, session: session.current })}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
        if (res.status === 401) { setItems([]); setStatus("signin"); return; }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { provider?: string; suggestions?: Suggestion[] };
        setItems(Array.isArray(data.suggestions) ? data.suggestions : []);
        setProvider(data.provider ?? "");
        setActive(-1);
        setStatus("ready");
      } catch {
        if (!ctrl.signal.aborted) { setItems([]); setStatus("error"); }
      }
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  async function pick(s: Suggestion) {
    setOpen(false);
    setQuery(null);
    setValue(s.parts?.address ?? [s.main, s.secondary].filter(Boolean).join(", "));
    let parts = s.parts;
    if (!parts) {
      try {
        const res = await fetch(`/api/address/place?${new URLSearchParams({ id: s.id, session: session.current })}`, { headers: { accept: "application/json" } });
        if (res.ok) parts = (await res.json()) as Parts;
      } catch { /* keep the text the owner picked; they can fill the rest */ }
    }
    session.current = newSession(); // a pick ends the billing session
    if (!parts) return;
    setValue(parts.address);
    const form = inputRef.current?.form ?? null;
    setFormField(form, "suburb", parts.suburb);
    setFormField(form, "postcode", parts.postcode);
    setFormField(form, "jurisdiction", parts.state);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (items.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActive(a => (e.key === "ArrowDown" ? (a + 1) % items.length : (a <= 0 ? items.length - 1 : a - 1)));
    } else if (e.key === "Enter" && open && active >= 0 && items[active]) {
      e.preventDefault(); // pick the highlighted address instead of submitting the form
      void pick(items[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  const showList = open && value.trim().length >= MIN_CHARS && status !== "idle";
  const activeId = showList && active >= 0 ? `${id}-opt-${active}` : undefined;
  return (
    <div className="addr-combo">
      <input
        ref={inputRef} name="address" placeholder="Start typing, e.g. 12 Jacaranda St" maxLength={300} required
        value={value} autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={showList} aria-controls={listId}
        aria-activedescendant={activeId}
        {...(invalid ? { "aria-invalid": true, "aria-describedby": "err-address" } : {})}
        onChange={e => { setValue(e.target.value); setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { if (items.length > 0) setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <div className="addr-pop">
          <ul id={listId} role="listbox" aria-label="Address suggestions" className="addr-list">
            {items.map((s, i) => (
              <li key={s.id} id={`${id}-opt-${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : undefined}
                onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => void pick(s)}>
                <span className="addr-main">{s.main}</span>
                {s.secondary && <span className="addr-sub">{s.secondary}</span>}
              </li>
            ))}
          </ul>
          {status === "loading" && items.length === 0 && <p className="addr-note" role="status">Searching addresses...</p>}
          {status === "ready" && items.length === 0 && <p className="addr-note" role="status">No matching address. Keep typing, or enter the full address yourself.</p>}
          {status === "signin" && <p className="addr-note" role="status"><a href="/login?as=owner&next=/listings/new">Sign in</a> to get address suggestions, or type the full address.</p>}
          {status === "error" && <p className="addr-note" role="status">Address suggestions are not available right now. Type the full address.</p>}
          {items.length > 0 && ATTRIBUTION[provider] && <p className="addr-attr">{ATTRIBUTION[provider]}</p>}
        </div>
      )}
    </div>
  );
}

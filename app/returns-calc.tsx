"use client";
import { useId, useState } from "react";
import {
  calculateProject, calculateProperty, parseNumber, PROJECT_DEFAULTS, PROPERTY_DEFAULTS, RETURNS_DISCLAIMER, TERM_OPTIONS
} from "../src/domain/investment-returns";
import "./styles/returns.css";

const aud = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const pc = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(2)}%`);

type FieldProps = { label: string; value: string; set: (v: string) => void; hint?: string; mode?: "numeric" | "decimal"; max?: number };
function Field({ label, value, set, hint, mode = "decimal", max = 11 }: FieldProps) {
  return <label className="rc-f">{label}<input inputMode={mode} value={value} maxLength={max} onChange={e => set(e.target.value)} />{hint && <small>{hint}</small>}</label>;
}

/**
 * Returns and yield calculator. `kind="property"` models a rental purchase (listing price, rent, loan, growth, tax);
 * `kind="project"` models an investor project (amount, assumed return, fees, tax). Prefilled from the listing or project where known;
 * every other starting value is a labelled example. Nothing leaves the browser.
 */
export default function ReturnsCalc(props: {
  kind: "property" | "project"; heading?: string | undefined;
  price?: number | undefined; weeklyRent?: number | undefined; amount?: number | undefined;
}) {
  return props.kind === "project" ? <ProjectCalc {...props} /> : <PropertyCalc {...props} />;
}

function PropertyCalc({ price, weeklyRent, heading }: { price?: number | undefined; weeklyRent?: number | undefined; heading?: string | undefined }) {
  const id = useId();
  const D = PROPERTY_DEFAULTS;
  const startPrice = price && price > 0 ? Math.round(price) : weeklyRent && weeklyRent > 0 ? Math.round((weeklyRent * 52) / (D.grossYieldGuessPct / 100) / 1000) * 1000 : 800000;
  const startRent = weeklyRent && weeklyRent > 0 ? Math.round(weeklyRent) : Math.round((startPrice * D.grossYieldGuessPct) / 100 / 52);
  const [f, setF] = useState({
    price: String(startPrice), upfront: String(Math.round(startPrice * D.upfrontPct / 100)), rent: String(startRent), vac: String(D.vacancyPct),
    rates: String(D.councilWaterYearly), ins: String(D.insuranceYearly), maint: String(D.maintenanceYearly), mgmt: String(D.managementFeePct),
    dep: String(D.depositPct), rate: String(D.ratePct), term: String(D.termYears), rentG: String(D.rentGrowthPct), valG: String(D.valueGrowthPct),
    costG: String(D.costGrowthPct), hold: String(D.holdYears), sell: String(D.sellingCostPct), tax: String(D.marginalTaxPct)
  });
  const [offset, setOffset] = useState(false);
  const [open, setOpen] = useState(false);
  const up = (k: keyof typeof f) => (v: string) => setF(s => ({ ...s, [k]: v }));
  const n = (k: keyof typeof f) => parseNumber(f[k]);
  const r = calculateProperty({
    price: n("price"), upfrontCosts: n("upfront"), weeklyRent: n("rent"), vacancyPct: n("vac"), councilWaterYearly: n("rates"), insuranceYearly: n("ins"),
    maintenanceYearly: n("maint"), managementFeePct: n("mgmt"), depositPct: Math.min(n("dep"), 100), ratePct: n("rate"), termYears: n("term") || 30,
    rentGrowthPct: n("rentG"), valueGrowthPct: n("valG"), costGrowthPct: n("costG"), holdYears: n("hold") || 1, sellingCostPct: n("sell"),
    marginalTaxPct: n("tax"), lossesOffsetIncome: offset
  });
  const hold = Math.min(Math.max(Math.round(n("hold")) || 1, 1), 30);
  return (
    <form className="rc" onSubmit={e => e.preventDefault()} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="rc-h">{heading ?? "Returns and yield calculator"}</h3>
      <p className="rc-badge" role="note">Illustrative only, not financial advice</p>
      <fieldset className="rc-set"><legend>The property</legend>
        <div className="rc-fields">
          <Field label="Purchase price (AUD)" value={f.price} set={up("price")} mode="numeric" hint={price ? "From the listing." : "An example price."} />
          <Field label="Upfront costs (AUD)" value={f.upfront} set={up("upfront")} mode="numeric" hint={`Stamp duty, legals. Example: ${D.upfrontPct}% of price.`} />
          <Field label="Rent a week (AUD)" value={f.rent} set={up("rent")} mode="numeric" hint={weeklyRent ? "From the listing." : "An example. Enter the rent you expect."} />
          <Field label="Vacancy (% of the year)" value={f.vac} set={up("vac")} />
        </div>
      </fieldset>
      <fieldset className="rc-set"><legend>Running costs a year</legend>
        <div className="rc-fields">
          <Field label="Council and water rates (AUD)" value={f.rates} set={up("rates")} mode="numeric" />
          <Field label="Insurance (AUD)" value={f.ins} set={up("ins")} mode="numeric" />
          <Field label="Maintenance (AUD)" value={f.maint} set={up("maint")} mode="numeric" />
          <Field label="Property management (% of rent)" value={f.mgmt} set={up("mgmt")} />
        </div>
      </fieldset>
      <fieldset className="rc-set"><legend>Loan</legend>
        <div className="rc-fields">
          <Field label="Deposit (%)" value={f.dep} set={up("dep")} hint="100 means buying with cash." />
          <Field label="Interest rate (% a year)" value={f.rate} set={up("rate")} hint="An example rate. Use your lender's." />
          <label className="rc-f">Loan term
            <select value={f.term} onChange={e => up("term")(e.target.value)}>{TERM_OPTIONS.map(t => <option key={t} value={t}>{t} years</option>)}</select>
          </label>
        </div>
      </fieldset>
      <fieldset className="rc-set"><legend>Growth, sale and tax</legend>
        <div className="rc-fields">
          <Field label="Rent growth (% a year)" value={f.rentG} set={up("rentG")} />
          <Field label="Value growth (% a year)" value={f.valG} set={up("valG")} />
          <Field label="Cost growth (% a year)" value={f.costG} set={up("costG")} />
          <Field label="Years you hold it" value={f.hold} set={up("hold")} mode="numeric" max={2} />
          <Field label="Selling costs (% of sale price)" value={f.sell} set={up("sell")} />
          <Field label="Your tax rate (%)" value={f.tax} set={up("tax")} hint="Marginal rate. 0 ignores tax." />
        </div>
        <label className="rc-check"><input type="checkbox" checked={offset} onChange={e => setOffset(e.target.checked)} /> Let a rental loss reduce tax on my other income</label>
      </fieldset>
      <output className="rc-out" aria-live="polite">
        <span className="rc-hero">Gross yield <strong>{pc(r.grossYieldPct)}</strong> · Net yield <strong>{pc(r.netYieldPct)}</strong></span>
        <dl className="rc-rows">
          <div><dt>Cash you put in</dt><dd>{aud(r.cashInvested)}</dd></div>
          <div><dt>Amount borrowed</dt><dd>{aud(r.loan)}</dd></div>
          <div><dt>Year 1 cash flow after loan and tax</dt><dd className={r.firstYearCashFlow < 0 ? "rc-neg" : undefined}>{aud(r.firstYearCashFlow)}</dd></div>
          <div><dt>Year 1 cash-on-cash return</dt><dd>{pc(r.cashOnCashPct)}</dd></div>
          <div><dt>Value after {hold} years</dt><dd>{aud(r.saleValue)}</dd></div>
          <div><dt>Equity after sale, loan and tax</dt><dd>{aud(r.equityAtSale)}</dd></div>
          <div><dt>Total profit over {hold} years</dt><dd className={r.totalProfit < 0 ? "rc-neg" : undefined}>{aud(r.totalProfit)}</dd></div>
          <div><dt>Annualised return on cash invested</dt><dd>{pc(r.annualisedReturnPct)}</dd></div>
        </dl>
      </output>
      <button type="button" className="button secondary rc-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Show"} year by year</button>
      {open && (
        <div className="rc-scroll" role="region" aria-label="Year by year projection" tabIndex={0}>
          <table className="rc-table">
            <thead><tr><th scope="col">Year</th><th scope="col">Rent</th><th scope="col">Costs</th><th scope="col">Interest</th><th scope="col">Cash flow</th><th scope="col">Value</th><th scope="col">Loan</th></tr></thead>
            <tbody>{r.years.map(y => (
              <tr key={y.year}><th scope="row">{y.year}</th><td>{aud(y.rent)}</td><td>{aud(y.costs)}</td><td>{aud(y.interest)}</td><td>{aud(y.cashFlow)}</td><td>{aud(y.value)}</td><td>{aud(y.loanBalance)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="rc-note">{RETURNS_DISCLAIMER} Tax is simplified: no depreciation, no state land tax, and a 50% capital gains discount after 12 months.</p>
    </form>
  );
}

function ProjectCalc({ amount, heading }: { amount?: number | undefined; heading?: string | undefined }) {
  const id = useId();
  const D = PROJECT_DEFAULTS;
  const [f, setF] = useState({ amount: String(amount && amount > 0 ? Math.round(amount) : 100000), ret: String(D.returnPct), term: String(D.termYears), up: String(D.upfrontFeePct), ann: String(D.annualFeePct), tax: String(D.taxPct) });
  const [compound, setCompound] = useState(false);
  const up = (k: keyof typeof f) => (v: string) => setF(s => ({ ...s, [k]: v }));
  const n = (k: keyof typeof f) => parseNumber(f[k]);
  const r = calculateProject({ amount: n("amount"), returnPct: n("ret"), termYears: n("term") || 1, upfrontFeePct: n("up"), annualFeePct: n("ann"), taxPct: n("tax"), compound });
  const term = Math.min(Math.max(Math.round(n("term")) || 1, 1), 30);
  return (
    <form className="rc" onSubmit={e => e.preventDefault()} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="rc-h">{heading ?? "Returns calculator"}</h3>
      <p className="rc-badge" role="note">Illustrative only, not financial advice</p>
      <div className="rc-fields">
        <Field label="Amount you invest (AUD)" value={f.amount} set={up("amount")} mode="numeric" hint={amount ? "Starts at the project's minimum." : "An example amount."} />
        <Field label="Return you assume (% a year)" value={f.ret} set={up("ret")} hint="Your own assumption. The project does not promise a return." />
        <Field label="Years invested" value={f.term} set={up("term")} mode="numeric" max={2} />
        <Field label="Upfront fee (%)" value={f.up} set={up("up")} hint="Example. Check the project terms." />
        <Field label="Yearly fee (% of amount)" value={f.ann} set={up("ann")} hint="Example. Check the project terms." />
        <Field label="Your tax rate (%)" value={f.tax} set={up("tax")} />
      </div>
      <label className="rc-check"><input type="checkbox" checked={compound} onChange={e => setCompound(e.target.checked)} /> Reinvest returns each year</label>
      <output className="rc-out" aria-live="polite">
        <span className="rc-hero">Net profit about <strong className={r.netProfit < 0 ? "rc-neg" : undefined}>{aud(r.netProfit)}</strong></span>
        <dl className="rc-rows">
          <div><dt>Return before fees and tax</dt><dd>{aud(r.grossReturn)}</dd></div>
          <div><dt>Fees over {term} {term === 1 ? "year" : "years"}</dt><dd>{aud(r.fees)}</dd></div>
          <div><dt>Tax</dt><dd>{aud(r.tax)}</dd></div>
          <div><dt>Total back after {term} {term === 1 ? "year" : "years"}</dt><dd>{aud(r.finalValue)}</dd></div>
          <div><dt>Total return</dt><dd>{pc(r.totalReturnPct)}</dd></div>
          <div><dt>Annualised return</dt><dd>{pc(r.annualisedPct)}</dd></div>
          <div><dt>Yearly return needed to cover fees</dt><dd>{pc(r.breakEvenPct)}</dd></div>
        </dl>
      </output>
      <p className="rc-note">{RETURNS_DISCLAIMER} Projects can lose money, and capital is not guaranteed. This does not model delays, defaults or the project&apos;s actual payout terms.</p>
    </form>
  );
}

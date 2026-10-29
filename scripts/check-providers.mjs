// Pre-deploy check of the outside-provider keys. Run with the deployment's environment loaded:
//   npm run check:providers               (production rules when NODE_ENV=production)
//   npm run check:providers -- --production   (production rules regardless)
// Prints key names and what is wrong, never values. Exit 1 when something blocks a production deploy. See docs/PROVIDER_KEYS.md.
import { checkProviders, formatReport } from "../src/config/provider-check.mjs";

const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const results = checkProviders(process.env, { production });
console.log(`Provider keys (${production ? "production" : "development"} rules)\n`);
console.log(formatReport(results));
const blocking = results.filter(r => r.blocking);
if (blocking.length) {
  console.error(`\nNot ready to deploy: ${blocking.map(r => r.label).join(", ")}.`);
  process.exit(1);
}
console.log(production ? "\nNo blocking problems." : "\nDevelopment: nothing blocks. Run with --production before a deploy.");

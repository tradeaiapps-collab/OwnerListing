// LOCAL TEST KIT: downloads the demo property photos listed in scripts/demo-photos/manifest.json (Unsplash License).
// Only missing files are fetched. An entry without an unsplashId is matched by its search query (first unused landscape result);
// the chosen id and photographer are written back to the manifest and CREDITS.txt is rebuilt. Usage: node scripts/fetch-demo-photos.mjs
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./demo-photos/", import.meta.url));
const MANIFEST = DIR + "manifest.json";
const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const all = [...manifest.listings.flatMap(l => l.photos), ...manifest.project.photos];
const used = new Set(all.map(p => p.unsplashId).filter(Boolean));
const exists = f => access(DIR + f).then(() => true, () => false);

async function json(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.json();
}
async function pick(query) {
  const res = await json(`https://unsplash.com/napi/search/photos?query=${encodeURIComponent(query)}&per_page=30&orientation=landscape`);
  const hit = (res.results ?? []).find(p => !used.has(p.id) && !p.premium && !p.plus);
  if (!hit) throw new Error(`No free result for "${query}"`);
  return hit;
}

let fetched = 0;
for (const p of all) {
  if (await exists(p.file)) continue;
  const photo = p.unsplashId ? await json(`https://unsplash.com/napi/photos/${p.unsplashId}`) : await pick(p.query);
  used.add(photo.id);
  const r = await fetch(`${photo.urls.raw}&w=1600&h=1067&fit=crop&crop=entropy&q=78&fm=jpg`);
  if (!r.ok) throw new Error(`Download of ${photo.id} answered ${r.status}`);
  await writeFile(DIR + p.file, Buffer.from(await r.arrayBuffer()));
  Object.assign(p, { unsplashId: photo.id, photographer: `${photo.user.name} (@${photo.user.username})` });
  fetched++;
  console.log(`${p.file}  <-  https://unsplash.com/photos/${photo.id}  ${p.photographer}`);
}
await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
const credits = ["OwnerListing demo photos (local test kit only) - all from Unsplash, Unsplash License", "https://unsplash.com/license", "",
  ...all.map(p => `${p.file}  ${p.photographer ?? "?"}  https://unsplash.com/photos/${p.unsplashId ?? "?"}`)];
await writeFile(DIR + "CREDITS.txt", credits.join("\n") + "\n");
console.log(fetched ? `Fetched ${fetched} photos.` : "All demo photos already present.");

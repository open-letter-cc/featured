// Builds featured.json from the submodules in this repo and the opt-in list in
// licensed.txt. Run by .github/workflows/nightly.yml after the submodules are
// moved to their latest commits; runs locally too:
//
//   node scripts/build.mjs            # GITHUB_TOKEN optional, raises API limits
//
// Node 20+, no dependencies.
//
// featured: read from the checked-out submodule (its openletter.json, else its
//   README's first heading and paragraph). The REST API adds stars only.
// licensed: never checked out. openletter.json is fetched from each listed
//   repo; a repo is listed only if that file says "license": "open-letter".

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TOKEN = process.env.GITHUB_TOKEN || "";
const OFFLINE = process.env.OFFLINE === "1";
const LICENSE_ID = "open-letter";

const ghHeaders = { "Accept": "application/vnd.github+json", "User-Agent": "openletter-featured-build",
  ...(TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {}) };

function parseGitmodules(text) {
  const mods = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^\s*\[submodule\s+"(.+)"\]\s*$/);
    if (head) { cur = { name: head[1] }; mods.push(cur); continue; }
    const kv = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    if (kv && cur) cur[kv[1]] = kv[2];
  }
  return mods.filter(m => m.path && m.url);
}

// "https://github.com/o/r(.git)" or "git@github.com:o/r.git" -> { host, owner, repo }
function parseRepo(url) {
  const m = url.trim().match(/^(?:https:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { host: m[1], owner: m[2], repo: m[3], web: `https://${m[1]}/${m[2]}/${m[3]}` } : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// First "# heading" and the first plain paragraph after it.
function readmeSummary(text) {
  const lines = text.split(/\r?\n/);
  const title = (lines.find(l => /^#\s+/.test(l)) || "").replace(/^#\s+/, "").trim();
  let para = [], started = false;
  for (const l of lines.slice(lines.findIndex(l => /^#\s+/.test(l)) + 1)) {
    const plain = l.trim();
    if (!plain) { if (started) break; continue; }
    if (/^(#|!\[|<|>|\||```|[-*] |\[!)/.test(plain)) { if (started) break; continue; }
    started = true; para.push(plain);
  }
  return { title, description: para.join(" ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 280) };
}

function findReadme(dir) {
  for (const n of ["README.md", "readme.md", "Readme.md", "README"]) if (existsSync(join(dir, n))) return join(dir, n);
  return null;
}

async function gh(path) {
  if (OFFLINE) return null;
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders });
  return r.ok ? r.json() : null;
}

async function rawFile(r, path) {
  if (OFFLINE || r.host !== "github.com") return null;
  const resp = await fetch(`https://raw.githubusercontent.com/${r.owner}/${r.repo}/HEAD/${path}`);
  return resp.ok ? resp.text() : null;
}

const clean = s => typeof s === "string" ? s.trim().slice(0, 280) : undefined;
const httpsOnly = s => typeof s === "string" && /^https:\/\//.test(s) ? s : undefined;

// --- featured -----------------------------------------------------------------
const featured = [];
const gm = existsSync(join(ROOT, ".gitmodules")) ? readFileSync(join(ROOT, ".gitmodules"), "utf8") : "";
for (const m of parseGitmodules(gm)) {
  const r = parseRepo(m.url);
  if (!r) { console.warn(`skip ${m.name}: cannot parse ${m.url}`); continue; }
  const dir = join(ROOT, m.path);
  let commit = null;
  try { commit = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  const meta = readJson(join(dir, "openletter.json")) || {};
  const readme = findReadme(dir);
  const fallback = readme ? readmeSummary(readFileSync(readme, "utf8")) : { title: "", description: "" };
  const api = r.host === "github.com" ? await gh(`/repos/${r.owner}/${r.repo}`) : null;
  featured.push({
    id: m.path.split("/").pop(),
    title: clean(meta.title) || fallback.title || r.repo,
    description: clean(meta.description) || fallback.description || clean(api?.description) || "",
    repo: r.web,
    commit,
    sponsor: httpsOnly(meta.sponsor),
    homepage: httpsOnly(meta.homepage) || httpsOnly(api?.homepage),
    stars: api?.stargazers_count ?? null,
    updated: api?.pushed_at ?? null,
  });
}

// --- licensed (opt-in) -----------------------------------------------------------
const licensed = [];
const listed = existsSync(join(ROOT, "licensed.txt"))
  ? readFileSync(join(ROOT, "licensed.txt"), "utf8").split(/\r?\n/).map(l => l.replace(/#.*/, "").trim()).filter(Boolean)
  : [];
for (const line of listed) {
  const r = parseRepo(line);
  if (!r) { console.warn(`skip licensed entry: ${line}`); continue; }
  const text = await rawFile(r, "openletter.json");
  let meta = null;
  try { meta = text ? JSON.parse(text) : null; } catch {}
  if (!OFFLINE && meta?.license !== LICENSE_ID) {
    console.warn(`skip ${r.web}: openletter.json missing or license is not "${LICENSE_ID}"`);
    continue;
  }
  licensed.push({ title: clean(meta?.title) || r.repo, description: clean(meta?.description) || "", repo: r.web });
}
licensed.sort((a, b) => a.title.localeCompare(b.title));

const out = { version: 1, generated: new Date().toISOString(), featured, licensed };
writeFileSync(join(ROOT, "featured.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`featured.json: ${featured.length} featured, ${licensed.length} licensed`);

// Builds featured.json from the submodules in this repo and the opt-in list in
// licensed.txt. Run by .github/workflows/nightly.yml after the submodules are
// moved to their latest commits; runs locally too:
//
//   node scripts/build.mjs            # GITHUB_TOKEN optional, raises API limits
//
// Node 20+, no dependencies.
//
// featured: openletter.json, else the README's first heading and paragraph,
//   read as raw files at the pinned commit. Nothing is cloned. The REST API adds
//   stars only. UPDATE=1 first moves each pointer to the remote's latest commit.
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
  return { title, description: para.join(" ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|__|`/g, "").slice(0, 280) };
}

async function gh(path) {
  if (OFFLINE) return null;
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders });
  return r.ok ? r.json() : null;
}

// One file from a repo at a ref, without cloning. Per-host raw URLs.
function rawUrl(r, ref, path) {
  if (r.host === "github.com") return `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${ref}/${path}`;
  if (r.host === "gitlab.com") return `https://gitlab.com/${r.owner}/${r.repo}/-/raw/${ref}/${path}`;
  if (r.host === "bitbucket.org") return `https://bitbucket.org/${r.owner}/${r.repo}/raw/${ref}/${path}`;
  return null;
}
async function rawFile(r, path, ref = "HEAD") {
  const u = !OFFLINE && rawUrl(r, ref, path);
  if (!u) return null;
  const resp = await fetch(u);
  return resp.ok ? resp.text() : null;
}
async function firstRaw(r, names, ref) {
  for (const n of names) { const t = await rawFile(r, n, ref); if (t) return t; }
  return null;
}

// Latest commit on the remote's default branch, without downloading anything.
function remoteHead(url) {
  try {
    const out = execFileSync("git", ["ls-remote", url, "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 });
    return out.split(/\s/)[0] || null;
  } catch { return null; }
}
// The commit the superproject currently pins, from the index.
function pinned(path) {
  try {
    const out = execFileSync("git", ["-C", ROOT, "ls-files", "-s", "--", path], { encoding: "utf8" });
    return out.split(/\s/)[1] || null;
  } catch { return null; }
}

const clean = s => typeof s === "string" ? s.trim().slice(0, 280) : undefined;
const httpsOnly = s => typeof s === "string" && /^https:\/\//.test(s) ? s : undefined;

// --- featured -----------------------------------------------------------------
// Submodules are never checked out. With UPDATE=1 (the nightly Action) each
// pointer moves to the remote's latest commit via ls-remote + update-index;
// otherwise the pinned commit is used as it is.
const UPDATE = process.env.UPDATE === "1";
const featured = [];
const gm = existsSync(join(ROOT, ".gitmodules")) ? readFileSync(join(ROOT, ".gitmodules"), "utf8") : "";
for (const m of parseGitmodules(gm)) {
  const r = parseRepo(m.url);
  if (!r) { console.warn(`skip ${m.name}: cannot parse ${m.url}`); continue; }
  let commit = pinned(m.path);
  if (UPDATE && !OFFLINE) {
    const head = remoteHead(m.url);
    if (head && head !== commit) {
      execFileSync("git", ["-C", ROOT, "update-index", "--cacheinfo", `160000,${head},${m.path}`]);
      console.log(`${m.path}: ${commit?.slice(0, 7)} -> ${head.slice(0, 7)}`);
      commit = head;
    }
  }
  const ref = commit || "HEAD";
  let meta = {};
  try { meta = JSON.parse(await rawFile(r, "openletter.json", ref) || "{}"); } catch {}
  const readme = await firstRaw(r, ["README.md", "readme.md", "Readme.md", "README"], ref);
  const fallback = readme ? readmeSummary(readme) : { title: "", description: "" };
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

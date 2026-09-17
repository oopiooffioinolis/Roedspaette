/* Rødspætte — background service worker (v0.4.1: iPhone inbox + auto-pilot; pending pass covers all sets). */
importScripts("lib/xlsx.full.min.js", "lib/vocab-sheets.js");

const VS = self.VocabSheets;
const GH = "https://api.github.com";
const MENU_ID = "dv-capture";
const ENRICH_TIMEOUT_MS = 25000; // compound probing can add a few lookups
const PENDING_BATCH = 25;
const INBOX = "inbox";
const INBOX_BATCH = 25;

/* ---------- storage helpers ---------- */

async function getState() {
  const s = await chrome.storage.local.get({
    cfg: { token: "", owner: "", repo: "", folder: "sets", targetLang: "en" },
    activeSet: "",
    sets: [],
    queue: [],
    lastSaved: null
  });
  s.cfg.folder = (s.cfg.folder || "sets").replace(/^\/+|\/+$/g, "");
  s.cfg.targetLang = (s.cfg.targetLang || "en").toLowerCase();
  return s;
}

function configured(cfg) {
  return !!(cfg.token && cfg.owner && cfg.repo);
}

async function setBadge() {
  const { queue } = await getState();
  await chrome.action.setBadgeBackgroundColor({ color: "#8A2318" });
  await chrome.action.setBadgeText({ text: queue.length ? String(queue.length) : "" });
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message: message || ""
  });
}

/* ---------- offscreen document (DOM parsing + built-in translator) ---------- */

let creatingOffscreen = null;
async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch (_) {}
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["DOM_PARSER"],
        justification: "Parse ordnet.dk dictionary pages and run Chrome's on-device translator"
      })
      .catch((e) => {
        if (!/single offscreen/i.test(e.message || "")) throw e;
      })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function askOffscreen(payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(Object.assign({ target: "offscreen" }, payload));
}

/* ---------- ordnet.dk lookup ---------- */

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`ordnet.dk ${res.status}`);
  return res.text();
}

async function ordnetLookup(term) {
  const q = encodeURIComponent(term.toLowerCase());
  // Live ordnet.dk first: it's confirmed reachable and its pages carry both the
  // modern-* structure and legacy markers, so the parser handles it fully.
  // gammel.ordnet.dk is kept only as a fallback in case the main host is down.
  const urls = [
    `https://ordnet.dk/ddo/ordbog?query=${q}`,
    `https://gammel.ordnet.dk/ddo/ordbog?query=${q}`
  ];
  for (const url of urls) {
    try {
      let html = await fetchText(url);
      let parsed = await askOffscreen({ op: "parseDdo", html, baseUrl: url });
      if (parsed && parsed.needsFollow) {
        html = await fetchText(parsed.needsFollow);
        parsed = await askOffscreen({ op: "parseDdo", html, baseUrl: parsed.needsFollow });
      }
      if (parsed && parsed.found) return parsed;
      if (parsed && parsed.notFound) return parsed;
    } catch (_) { /* try the next host */ }
  }
  return { found: false };
}

/* DDO rarely lists transparent compounds (patientoplysninger, bilværksted…),
   but the compound's last element — the head — determines its gender and
   inflection. Probe a few plausible split points, verify the hit is a real
   word form of the head's lemma, and synthesize the compound's grammar. */
async function resolveCompound(term) {
  for (const cand of VS.compoundSplits(term, 6)) {
    let dd;
    try { dd = await ordnetLookup(cand.suffix); } catch (_) { continue; }
    if (!dd || !dd.found || !dd.lemma) continue;
    if (!["substantiv", "verbum", "adjektiv"].includes(dd.wordClass || "")) continue;
    const lemma = VS.compoundLemma(term, cand.prefix, dd.lemma, dd.inflections);
    if (!lemma) continue; // suffix wasn't an exact form of the head — fuzzy match, reject
    return {
      found: true,
      compound: true,
      lemma,
      wordClass: dd.wordClass || "",
      gender: dd.gender || "",
      // suffix-style inflections ("-en, -er, -erne") apply to the whole compound
      inflections: /^-/.test(String(dd.inflections || "").trim()) ? dd.inflections : "",
      ipa: "",      // the head's pronunciation is not the compound's
      audioURL: "",
      definition: `sammensat af ${cand.prefix} + ${dd.lemma}`
    };
  }
  return null;
}

/* ---------- translation ---------- */

function tokenize(phrase) {
  return phrase
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => w && /\p{L}/u.test(w));
}

async function translateBatch(texts, targetLang) {
  if (!texts.length) return { translations: [] };
  return askOffscreen({ op: "translate", texts, source: "da", targetLang });
}

/* ---------- enrichment ---------- */

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

async function enrichEntryInner(entry, cfg) {
  const info = { needsSetup: false };
  const userTranslation = !!(entry.translation && entry.translation.trim());
  if (entry.type === "word") {
    let dd = await ordnetLookup(entry.term);
    if (!dd.found && entry.term.length >= 8) {
      const comp = await resolveCompound(entry.term);
      if (comp) dd = comp;
    }
    // Ambiguous: DDO returned several distinct senses. Don't guess — translate
    // each sense's definition for an English hint and hand the choice to the user.
    if (!dd.found && dd.ambiguous && Array.isArray(dd.candidates) && dd.candidates.length >= 2) {
      const defs = dd.candidates.map((c) => c.definition || c.lemma || entry.term);
      const tr = await translateBatch(defs, cfg.targetLang);
      if (tr.error === "needs-setup") { info.needsSetup = true; }
      const hints = tr && tr.translations ? tr.translations : [];
      entry.candidates = dd.candidates.map((c, i) => Object.assign({}, c, { hint: (hints[i] || "").slice(0, 160) }));
      entry.status = "choose";
      return info;
    }
    if (dd.found) {
      entry.lemma = dd.lemma || "";
      entry.wordClass = dd.wordClass || "";
      entry.gender = dd.gender || "";
      entry.inflections = dd.inflections || "";
      entry.ipa = dd.ipa || "";
      entry.audioURL = dd.audioURL || "";
      entry.definition = dd.definition || "";
    }
    if (!userTranslation) {
      const tr = await translateBatch([dd.lemma || entry.term], cfg.targetLang);
      if (tr.error === "needs-setup") info.needsSetup = true;
      else if (tr.translations) entry.translation = tr.translations[0] || "";
    }
    if (info.needsSetup && !dd.found) entry.status = "pending";
    else if (dd.found && (entry.inflections || entry.wordClass) && entry.translation) entry.status = "ok";
    else if (dd.found || entry.translation) entry.status = "partial";
    else if (dd.notFound) entry.status = "not-found";
    else entry.status = "pending";
  } else {
    const tokens = tokenize(entry.term);
    const res = await translateBatch([entry.term, ...tokens], cfg.targetLang);
    if (res.error === "needs-setup") {
      info.needsSetup = true;
      entry.status = userTranslation ? "partial" : "pending";
    } else if (res.error === "unsupported") {
      entry.status = userTranslation ? "partial" : "manual";
    } else {
      if (!userTranslation) entry.translation = res.translations[0] || "";
      entry.gloss = tokens
        .map((t, i) => `${t}=${res.translations[i + 1] || "?"}`)
        .join(" · ");
      entry.status = entry.translation && entry.gloss ? "ok" : "partial";
    }
  }
  return info;
}

async function enrichEntry(entry, cfg) {
  try {
    return await withTimeout(enrichEntryInner(entry, cfg), ENRICH_TIMEOUT_MS, { timedOut: true });
  } catch (_) {
    return { failed: true };
  }
}

/* ---------- GitHub contents API ---------- */

async function gh(cfg, path, options = {}) {
  const res = await fetch(`${GH}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  return res;
}

function repoPath(cfg, relPath) {
  return `/repos/${cfg.owner}/${cfg.repo}/contents/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

function filePath(cfg, name) {
  return repoPath(cfg, `${cfg.folder}/${name}`);
}

async function getFileAt(cfg, relPath) {
  const res = await gh(cfg, repoPath(cfg, relPath));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} while reading ${relPath}`);
  const json = await res.json();
  const b64 = (json.content || "").replace(/\n/g, "");
  // GitHub's contents API only inlines files up to 1 MB; larger files come back with
  // empty content and encoding "none". Reading that blank as an empty workbook and
  // writing it back is exactly what wiped the set, so refuse rather than return empty
  // content for a file that actually exists. (A genuine 404 is handled above as null.)
  if (!b64 && (json.encoding === "none" || (json.size || 0) > 0)) {
    throw new Error(`Cannot read ${relPath}: GitHub returned no inline content (file is ${Math.round((json.size || 0) / 1024)} KB; the contents API caps inline reads at 1 MB). Refusing to overwrite it.`);
  }
  return { b64, sha: json.sha };
}

async function deleteFileAt(cfg, relPath, sha, message) {
  const res = await gh(cfg, repoPath(cfg, relPath), {
    method: "DELETE",
    body: JSON.stringify({ message, sha })
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} while deleting ${relPath}`);
}

async function getFile(cfg, name) {
  return getFileAt(cfg, `${cfg.folder}/${name}`);
}

async function putFile(cfg, name, b64, message, sha) {
  const body = { message, content: b64 };
  if (sha) body.sha = sha;
  const res = await gh(cfg, filePath(cfg, name), { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    const e = new Error(`GitHub ${res.status} while writing ${name}`);
    e.status = res.status;
    throw e;
  }
}

async function listSetFiles(cfg) {
  const res = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(cfg.folder)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} while listing sets`);
  const json = await res.json();
  return (Array.isArray(json) ? json : [])
    .filter((f) => f.type === "file" && /\.xlsx$/i.test(f.name))
    .map((f) => ({ name: f.name, sha: f.sha, size: f.size || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, "da"));
}

async function listSets(cfg) {
  return (await listSetFiles(cfg)).map((f) => f.name);
}

/* sets/index.json — a plain JSON array of family labels (["Nyheder", "Arbejde"…])
   kept in the repo so the iPhone Shortcut can offer a "Choose from List" picker
   without parsing the folder listing. Best-effort; never blocks a save. */
async function updateSetsIndex(cfg) {
  try {
    const files = await listSetFiles(cfg);
    const bases = VS.groupFamilies(files).map((f) => f.base);
    const body = JSON.stringify(bases);
    const rel = `${cfg.folder}/index.json`;
    const existing = await getFileAt(cfg, rel).catch(() => null);
    if (existing && VS.decodeB64Utf8(existing.b64).trim() === body) return;
    const b64 = btoa(unescape(encodeURIComponent(body)));
    const payload = { message: "Update set index for the iPhone Shortcut", content: b64 };
    if (existing) payload.sha = existing.sha;
    await gh(cfg, repoPath(cfg, rel), { method: "PUT", body: JSON.stringify(payload) });
  } catch (_) { /* index is a convenience — never fail a save over it */ }
}

/* ---------- save pipeline (serialized to avoid sha races) ---------- */

let chain = Promise.resolve();
function serialized(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

/* Walks a set's family (Name.xlsx, Name-2.xlsx, …) to the newest existing part,
   and rolls to a fresh part when that one is full. Returns { name, file, base }. */
async function resolveTargetFile(cfg, setName) {
  const fam = VS.setFamily(setName);
  let num = fam.num;
  let name = setName;
  let file = await getFile(cfg, name);
  while (file !== null) {
    const nextName = VS.familyFile(fam.base, num + 1);
    const nextFile = await getFile(cfg, nextName);
    if (nextFile === null) break;
    num++; name = nextName; file = nextFile;
  }
  if (file && VS.b64Bytes(file.b64) >= VS.SIZE_FULL) {
    num++;
    name = VS.familyFile(fam.base, num);
    file = null; // brand-new part; the family still reads as one deck
    notify("Rødspætte — new file started", `${VS.familyFile(fam.base, num - 1)} is full. Continuing in ${name}; the apps keep showing one “${fam.base}” deck.`);
  }
  return { name, file, base: fam.base };
}

/* Warn once per file when it crosses the 95 % mark. */
async function maybeWarnCapacity(name, b64) {
  const bytes = VS.b64Bytes(b64);
  if (bytes < VS.SIZE_FULL * VS.SIZE_WARN_RATIO) return;
  const { capWarned } = await chrome.storage.local.get({ capWarned: {} });
  if (capWarned[name]) return;
  capWarned[name] = true;
  await chrome.storage.local.set({ capWarned });
  const fam = VS.setFamily(name);
  notify("Rødspætte — set almost full",
    `${name} is at ${Math.round((bytes / VS.SIZE_FULL) * 100)} % of its safe size. The next capture past full starts ${VS.familyFile(fam.base, fam.num + 1)} automatically.`);
}

async function appendToSet(cfg, setName, entry) {
  const target = await resolveTargetFile(cfg, setName);
  let name = target.name;
  let file = target.file;
  let wb = file ? VS.readWorkbook(file.b64) : VS.newWorkbook(target.base);
  let result = VS.appendEntry(wb, entry);
  if (result.duplicate) return { duplicate: true, set: name };
  const label = entry.type === "word" ? "word" : "phrase";
  const msg = `Add ${label} "${entry.term}" to ${name}`;
  let written = VS.writeWorkbook(wb);
  try {
    await putFile(cfg, name, written, msg, file ? file.sha : undefined);
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      file = await getFile(cfg, name);
      wb = file ? VS.readWorkbook(file.b64) : VS.newWorkbook(target.base);
      result = VS.appendEntry(wb, entry);
      if (result.duplicate) return { duplicate: true, set: name };
      written = VS.writeWorkbook(wb);
      await putFile(cfg, name, written, msg, file ? file.sha : undefined);
    } else {
      throw e;
    }
  }
  await maybeWarnCapacity(name, written);
  return { duplicate: false, set: name, status: entry.status, counts: VS.counts(wb) };
}

async function saveEntry(entry) {
  const { cfg } = await getState();
  if (!configured(cfg)) return { error: "Not set up yet — open the extension options first." };
  const enrichInfo = await enrichEntry(entry, cfg);
  return serialized(async () => {
    const state = await getState();
    const setName = entry.set || state.activeSet;
    if (!setName) return { error: "No active set — pick or create one in the extension popup." };
    try {
      await flushQueueInner(cfg);
      const res = await appendToSet(cfg, setName, entry);
      if (!res.duplicate) {
        await chrome.storage.local.set({ lastSaved: { term: entry.term, set: setName, at: Date.now() } });
      }
      res.needsSetup = !!enrichInfo.needsSetup;
      return res;
    } catch (e) {
      entry.set = setName;
      state.queue.push(entry);
      await chrome.storage.local.set({ queue: state.queue });
      await setBadge();
      return { queued: true, reason: e.message };
    }
  });
}

async function flushQueueInner(cfg) {
  const { queue } = await getState();
  while (queue.length) {
    await appendToSet(cfg, queue[0].set, queue[0]);
    queue.shift();
    await chrome.storage.local.set({ queue });
  }
  await setBadge();
}

/* ---------- process pending rows in the active set ---------- */

async function processPending(cfg, setName, includePartial) {
  const file = await getFile(cfg, setName);
  if (!file) return { error: `${setName} not found in the repo.` };
  const wb = VS.readWorkbook(file.b64);
  VS.ensureColumns(wb);
  const pending = VS.listPending(wb, { includePartial: !!includePartial });
  if (!pending.length) return { processed: 0, updated: 0, remaining: 0 };

  const batch = pending.slice(0, PENDING_BATCH);
  let updated = 0;
  let choose = 0;
  let needsSetup = false;
  for (const row of batch) {
    // carry the row's existing translation so a hand-edited one survives the retry
    const entry = { type: row.type, term: row.term, translation: row.translation || "" };
    const info = await enrichEntry(entry, cfg);
    if (info.needsSetup) { needsSetup = true; continue; }
    if (!entry.status || entry.status === "pending") continue;
    // a retried row must actually improve; identical results shouldn't make commits
    if (row.status && row.status !== "pending" && entry.status === row.status &&
        !entry.wordClass && !entry.inflections && !entry.definition && !entry.gloss &&
        (entry.translation || "") === (row.translation || "")) continue;
    let fields;
    if (entry.status === "choose") {
      // store the candidate senses; leave grammar blank until the user picks
      fields = { Status: "choose", Candidates: JSON.stringify(entry.candidates || []) };
      choose++;
    } else if (entry.type === "word") {
      fields = { Lemma: entry.lemma, WordClass: entry.wordClass, Gender: entry.gender,
        Inflections: entry.inflections, IPA: entry.ipa, AudioURL: entry.audioURL,
        Definition: entry.definition, Translation: entry.translation, Status: entry.status,
        Candidates: "" };
    } else {
      fields = { Gloss: entry.gloss, Translation: entry.translation, Status: entry.status };
    }
    if (VS.updateRow(wb, row.sheet, row.row, fields)) updated++;
  }
  if (updated) {
    await putFile(cfg, setName, VS.writeWorkbook(wb), `Enrich ${updated} pending entr${updated === 1 ? "y" : "ies"} in ${setName}`, file.sha);
  }
  return { processed: batch.length, updated, choose, remaining: pending.length - batch.length, needsSetup };
}

/* ---------- iPhone inbox (inbox/* files created by the iOS Shortcut) ---------- */

async function listInbox(cfg) {
  const res = await gh(cfg, repoPath(cfg, INBOX));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} while listing inbox`);
  const json = await res.json();
  return (Array.isArray(json) ? json : [])
    .filter((f) => f.type === "file" && !/^failed-/i.test(f.name))
    .map((f) => ({ name: f.name, sha: f.sha }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* Unreadable captures are renamed failed-* and kept, instead of being retried forever. */
async function quarantineInboxFile(cfg, name, file) {
  try {
    await gh(cfg, repoPath(cfg, `${INBOX}/failed-${name}`), {
      method: "PUT",
      body: JSON.stringify({ message: `Quarantine unreadable capture ${name}`, content: file.b64 })
    });
    await deleteFileAt(cfg, `${INBOX}/${name}`, file.sha, `Remove unreadable capture ${name}`);
  } catch (_) { /* leave it for the next run */ }
}

async function processInbox(cfg, activeSet, knownSets) {
  const all = await listInbox(cfg);
  if (!all.length) return { found: 0, filed: 0, skipped: 0, errors: 0, remaining: 0 };
  const batch = all.slice(0, INBOX_BATCH);
  let filed = 0, skipped = 0, errors = 0, lastSet = "";
  for (const f of batch) {
    let file = null;
    try {
      file = await getFileAt(cfg, `${INBOX}/${f.name}`);
      if (!file) { skipped++; continue; }
      let entry = null;
      try {
        entry = VS.inboxEntry(VS.decodeB64Utf8(file.b64), crypto.randomUUID(), new Date().toISOString().slice(0, 10));
      } catch (_) {
        await quarantineInboxFile(cfg, f.name, file);
        errors++;
        continue;
      }
      if (!entry) {
        await deleteFileAt(cfg, `${INBOX}/${f.name}`, file.sha, `Remove empty capture ${f.name}`);
        skipped++;
        continue;
      }
      // a payload may target a set family, but only one that already exists — typos can't spawn files
      let setName = activeSet;
      if (entry.set) {
        const wantedBase = VS.setFamily(entry.set).base.toLowerCase();
        const match = knownSets.find((n) => VS.setFamily(n).base.toLowerCase() === wantedBase);
        if (match) setName = match;
      }
      delete entry.set;
      await enrichEntry(entry, cfg);
      const res = await appendToSet(cfg, setName, entry);
      if (res.duplicate) skipped++; else { filed++; lastSet = setName; }
      await deleteFileAt(cfg, `${INBOX}/${f.name}`, file.sha, `Filed phone capture "${entry.term}"`);
    } catch (_) {
      errors++; // network etc. — the file stays in the inbox for the next run
    }
  }
  return { found: all.length, filed, skipped, errors, remaining: all.length - batch.length, set: lastSet };
}

/* Pending pass across every set file. The quiz app saves manual adds into
   whichever set the user picks, so scanning only the active set would leave
   rows in other sets pending forever. Active set goes first. */
async function processPendingAll(cfg, activeSet, knownSets, includePartial) {
  const sets = [activeSet].concat(knownSets.filter((n) => n && n !== activeSet)).filter(Boolean);
  const total = { processed: 0, updated: 0, choose: 0, remaining: 0, needsSetup: false };
  let firstError = "";
  for (const name of sets) {
    try {
      const r = await processPending(cfg, name, includePartial);
      if (r.error) { if (!firstError) firstError = r.error; continue; }
      total.processed += r.processed;
      total.updated += r.updated;
      total.choose += (r.choose || 0);
      total.remaining += r.remaining;
      if (r.needsSetup) total.needsSetup = true;
    } catch (e) {
      if (!firstError) firstError = e.message;
    }
  }
  if (firstError && !total.processed && !total.updated) total.error = firstError;
  return total;
}

/* Inbox + pending in one pass; used by the popup button and the background
   auto-pilot. The popup pass also retries "partial" rows; the silent 15-min
   pass only does "pending" so unfindable words don't burn requests forever. */
async function processAll(cfg, activeSet, silent) {
  const knownSets = await listSets(cfg).catch(() => [activeSet]);
  const inbox = await processInbox(cfg, activeSet, knownSets).catch((e) => ({ error: e.message, found: 0, filed: 0, skipped: 0 }));
  const pend = await processPendingAll(cfg, activeSet, knownSets, !silent).catch((e) => ({ error: e.message, processed: 0, updated: 0 }));
  const didSomething = (inbox.filed || 0) + (pend.updated || 0) > 0;
  if (!silent || didSomething) {
    const bits = [];
    if (inbox.filed) bits.push(`${inbox.filed} phone capture${inbox.filed > 1 ? "s" : ""} filed → ${inbox.set}`);
    if (inbox.skipped) bits.push(`${inbox.skipped} skipped`);
    if (pend.updated) bits.push(`${pend.updated} pending entr${pend.updated > 1 ? "ies" : "y"} enriched`);
    if (pend.choose) bits.push(`${pend.choose} need${pend.choose > 1 ? "" : "s"} a sense picked — open the popup`);
    if (bits.length) notify("Rødspætte", bits.join(" · "));
  }
  return { inbox, pending: pend };
}

async function autoProcess() {
  const { cfg, activeSet } = await getState();
  if (!configured(cfg) || !activeSet) return;
  await serialized(() => processAll(cfg, activeSet, true)).catch(() => {});
}

/* ---------- known-words highlight index ---------- */

async function buildHighlightIndex(cfg) {
  const files = await listSetFiles(cfg);
  const { hlCache } = await chrome.storage.local.get({ hlCache: {} });
  const newCache = {};
  const map = {};
  for (const f of files) {
    let rec = hlCache[f.name];
    if (!rec || rec.sha !== f.sha) {
      let file;
      try {
        file = await getFile(cfg, f.name);
      } catch (e) {
        // Set unreadable right now (e.g. temporarily over 1 MB). Keep the words we
        // already had cached rather than wiping this set out of the highlight map.
        if (rec) newCache[f.name] = rec;
        continue;
      }
      if (!file) continue;
      rec = { sha: f.sha, words: VS.listWords(VS.readWorkbook(file.b64)) };
    }
    newCache[f.name] = rec;
    for (const w of rec.words) {
      for (const form of VS.expandForms(w.term, w.lemma, w.inflections)) {
        const existing = map[form];
        if (!existing || (!existing.t && w.translation)) {
          map[form] = { t: w.translation || "", term: w.term, lemma: w.lemma || "", set: f.name, id: w.id || "" };
        }
      }
    }
  }
  await chrome.storage.local.set({ hlCache: newCache });
  return map;
}

async function toggleHighlight(tab) {
  if (!tab?.id) return { error: "No tab." };
  const { cfg } = await getState();
  if (!configured(cfg)) return { error: "Not set up yet — open options first." };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (e) {
    return { error: "Can't highlight on this page." };
  }
  const probe = await chrome.tabs.sendMessage(tab.id, { type: "DV_HIGHLIGHT", action: "toggle" });
  if (!probe || !probe.needWords) return probe || { error: "No response from page." };
  const words = await buildHighlightIndex(cfg);
  return chrome.tabs.sendMessage(tab.id, { type: "DV_HIGHLIGHT", action: "on", words });
}

/* Force highlight on or off for one tab (used when flipping the persistent mode). */
async function applyHighlight(tab, on) {
  if (!tab?.id) return { error: "No tab." };
  const { cfg } = await getState();
  if (on && !configured(cfg)) return { error: "Not set up yet — open options first." };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (e) {
    return { error: "Can't highlight on this page." };
  }
  if (!on) return chrome.tabs.sendMessage(tab.id, { type: "DV_HIGHLIGHT", action: "off" }).catch(() => ({ on: false }));
  const words = await buildHighlightIndex(cfg);
  return chrome.tabs.sendMessage(tab.id, { type: "DV_HIGHLIGHT", action: "on", words });
}

/* Persistent "highlight known words everywhere" mode. When on, a dynamic content
   script auto-highlights every page on load (needs all-sites access, requested
   from the popup/reader). The reader reads the same flag to auto-highlight PDFs. */
const AUTO_HL_ID = "dv-auto-hl";

async function registerAutoHl() {
  try {
    const has = await chrome.permissions.contains({ origins: ["*://*/*"] });
    if (!has) return false; // no broad access yet; UI should request it
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_HL_ID] }).catch(() => []);
    if (!existing.length) {
      await chrome.scripting.registerContentScripts([{
        id: AUTO_HL_ID, js: ["content.js"], matches: ["*://*/*"], runAt: "document_idle", allFrames: false
      }]);
    }
    return true;
  } catch (_) { return false; }
}

async function unregisterAutoHl() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [AUTO_HL_ID] }); } catch (_) {}
}

async function setAutoHighlight(on) {
  await chrome.storage.local.set({ hlAuto: !!on });
  if (on) {
    await registerAutoHl();
  } else {
    await unregisterAutoHl();
    // best-effort: remove existing highlights from any open pages right away
    const tabs = await chrome.tabs.query({}).catch(() => []);
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { type: "DV_HIGHLIGHT", action: "off" }).catch(() => {});
    }
  }
  return !!on;
}

async function ensureAutoHlRegistration() {
  const { hlAuto } = await chrome.storage.local.get({ hlAuto: false });
  if (hlAuto) await registerAutoHl();
}

async function updateTranslation(cfg, setName, id, translation) {
  return serialized(async () => {
    const file = await getFile(cfg, setName);
    if (!file) return { error: `${setName} not found.` };
    const wb = VS.readWorkbook(file.b64);
    VS.ensureColumns(wb);
    const term = VS.updateRowById(wb, "Words", id, { Translation: translation });
    if (term === null) return { error: "Entry not found in the file (was it deleted?)." };
    await putFile(cfg, setName, VS.writeWorkbook(wb), `Update translation of "${term}" in ${setName}`, file.sha);
    const { hlCache } = await chrome.storage.local.get({ hlCache: {} });
    if (hlCache[setName]) {
      for (const w of hlCache[setName].words) if (w.id === id) w.translation = translation;
      hlCache[setName].sha = "stale";
      await chrome.storage.local.set({ hlCache });
    }
    return { ok: true, term };
  });
}

/* ---------- capture flow ---------- */

function looksLikeWord(text) {
  return text.trim().split(/\s+/).length === 1;
}

function minimalEntry(text, tab) {
  const realUrl = viewerFileUrl(tab?.url || "") || tab?.url || "";
  return {
    id: crypto.randomUUID(),
    type: looksLikeWord(text) ? "word" : "phrase",
    term: text.trim().replace(/\s+/g, " "),
    snippet: "",
    sourceTitle: tab?.title || "",
    sourceURL: realUrl,
    deepLink: "",
    note: "",
    dateAdded: new Date().toISOString().slice(0, 10)
  };
}

/* Chrome's built-in PDF viewer renders through an out-of-process plugin: content
   scripts can't read window.getSelection() there, nor render our capture card. The
   context menu still hands us the selected text, so for PDFs we save straight from
   the background (still DDO-enriched via saveEntry) instead of injecting a card. */
function isPdfTab(tab) {
  const u = (tab && tab.url) || "";
  return /\.pdf(?:[?#]|$)/i.test(u) ||
         u.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/") || // built-in PDF viewer
         !!viewerFileUrl(u);                                                     // our own bundled reader
}

/* If this is our bundled reader (viewer.html?file=…), return the real PDF URL. */
function viewerFileUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "chrome-extension:" && u.hostname === chrome.runtime.id && u.pathname.endsWith("/viewer.html")) {
      return u.searchParams.get("file") || "";
    }
  } catch (_) {}
  return "";
}

async function captureInBackground(tab, text) {
  const res = await saveEntry(minimalEntry(text, tab));
  reportSave(res, text);
  return res;
}

async function startCapture(tab, fallbackText) {
  if (!tab?.id) return;
  const text = (fallbackText || "").trim();
  if (isPdfTab(tab)) {
    if (text) await captureInBackground(tab, text);
    else notify("Rødspætte",
      "Select a word in the PDF, then right-click → “Save … to Rødspætte”. (The keyboard shortcut can’t read a PDF selection.)");
    return;
  }
  const { activeSet, sets } = await getState();
  // The card offers one entry per set family; saves land in the family's newest part.
  const famBases = VS.groupFamilies(sets.map((n) => ({ name: n }))).map((f) => VS.familyFile(f.base, 1));
  const activeFam = activeSet ? VS.familyFile(VS.setFamily(activeSet).base, 1) : (famBases[0] || "");
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, {
      type: "DV_SHOW_CARD",
      activeSet: activeFam,
      sets: famBases,
      fallbackText: text
    });
  } catch (e) {
    if (text) await captureInBackground(tab, text);
    else notify("Rødspætte", "Can't capture on this page.");
  }
}

function reportSave(res, term) {
  if (res.error) notify("Rødspætte — not saved", res.error);
  else if (res.duplicate) notify("Already in the set", `"${term}" was skipped — it's already in ${res.set}.`);
  else if (res.queued) notify("Saved offline", `"${term}" is queued and will retry (${res.reason}).`);
  else if (res.needsSetup) notify("Saved — translation needs setup", `"${term}" → ${res.set}. Open Options once to download the free Danish language pack.`);
  else notify("Saved", `"${term}" → ${res.set}`);
}

/* ---------- disambiguation: list rows needing a choice, and resolve one ---------- */

/* Gather every "choose" row across all set files, for the popup to present. */
async function listAllChoices(cfg, knownSets) {
  const sets = knownSets && knownSets.length ? knownSets : await listSets(cfg).catch(() => []);
  const out = [];
  for (const name of sets) {
    let file;
    try { file = await getFile(cfg, name); } catch (_) { continue; }
    if (!file) continue;
    const wb = VS.readWorkbook(file.b64);
    for (const c of VS.listChoices(wb)) {
      out.push({ set: name, id: String(c.id || ""), term: c.term, translation: c.translation, candidates: c.candidates });
    }
  }
  return out;
}

/* Apply the user's chosen sense to a "choose" row: look up the chosen lemma for
   full grammar (inflections, IPA, audio, definition), write the user's translation,
   clear the Candidates blob, and flip Status to ok (or partial if no translation). */
async function resolveChoice(cfg, setName, id, choice) {
  return serialized(async () => {
    const file = await getFile(cfg, setName);
    if (!file) return { error: `${setName} not found.` };
    const wb = VS.readWorkbook(file.b64);
    VS.ensureColumns(wb);
    // find the row by id among the choose rows
    const target = VS.listChoices(wb).find((c) => String(c.id) === String(id));
    if (!target) return { error: "That entry was already resolved or removed." };

    const cand = choice && choice.candidate ? choice.candidate : {};
    const translation = (choice && typeof choice.translation === "string") ? choice.translation.trim() : target.translation;

    // Prefer the chosen sense's own fields; fill any gaps (IPA/audio) from a
    // fresh lookup of its specific lemma so the card is complete.
    let lemma = cand.lemma || "", wordClass = cand.wordClass || "", gender = cand.gender || "";
    let inflections = cand.inflections || "", ipa = "", audioURL = "", definition = cand.definition || "";
    if (lemma) {
      try {
        const dd = await ordnetLookup(lemma);
        if (dd && dd.found) {
          inflections = inflections || dd.inflections || "";
          ipa = dd.ipa || "";
          audioURL = dd.audioURL || "";
          definition = definition || dd.definition || "";
          wordClass = wordClass || dd.wordClass || "";
          gender = gender || dd.gender || "";
        }
      } catch (_) { /* keep candidate fields */ }
    }
    const status = (wordClass || inflections) && translation ? "ok" : (translation || wordClass ? "partial" : "choose");
    const ok = VS.updateRow(wb, target.sheet, target.row, {
      Lemma: lemma, WordClass: wordClass, Gender: gender, Inflections: inflections,
      IPA: ipa, AudioURL: audioURL, Definition: definition, Translation: translation,
      Status: status, Candidates: ""
    });
    if (!ok) return { error: "Couldn't write the row." };
    await putFile(cfg, setName, VS.writeWorkbook(wb),
      `Resolve "${target.term}" → ${lemma || translation} (${wordClass || "?"}) in ${setName}`, file.sha);
    return { ok: true, term: target.term, status };
  });
}

/* ---------- wiring ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Save "%s" to Rødspætte', contexts: ["selection"] });
  });
  chrome.alarms.create("dv-auto", { periodInMinutes: 15, delayInMinutes: 1 });
  setBadge();
  ensureAutoHlRegistration();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("dv-auto", { periodInMinutes: 15, delayInMinutes: 1 });
  autoProcess();
  ensureAutoHlRegistration();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "dv-auto") autoProcess();
});

function isReaderTab(tab) {
  return !!(tab && tab.url && tab.url.startsWith(chrome.runtime.getURL("viewer.html")));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (isReaderTab(tab)) { chrome.runtime.sendMessage({ type: "DV_READER_CMD", cmd: "capture", text: info.selectionText || "" }); return; }
  startCapture(tab, info.selectionText || "");
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  // In our own reader we can't read the selection from here, so hand off to the
  // reader page, which reads its own selection and shows the card / toggles HL.
  if (isReaderTab(tab)) {
    if (command === "capture-selection") chrome.runtime.sendMessage({ type: "DV_READER_CMD", cmd: "capture" });
    else if (command === "toggle-highlight") chrome.runtime.sendMessage({ type: "DV_READER_CMD", cmd: "highlight" });
    return;
  }
  if (command === "capture-selection") startCapture(tab, "");
  if (command === "toggle-highlight") {
    const { hlAuto } = await chrome.storage.local.get({ hlAuto: false });
    const on = !hlAuto;
    await setAutoHighlight(on);              // note: registers only if all-sites already granted
    const res = await applyHighlight(tab, on);
    if (res && res.error) notify("Rødspætte", res.error);
    else notify("Rødspætte", on ? "Highlighting on." : "Highlighting off.");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === "offscreen") return false; // not for us
  handleMessage(msg, sender).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
  return true;
});

async function handleMessage(msg, sender) {
  const state = await getState();
  const cfg = state.cfg;

  switch (msg.type) {
    case "DV_SAVE": {
      const res = await saveEntry(msg.entry);
      if (res.error || res.queued || res.needsSetup) reportSave(res, msg.entry.term);
      return res;
    }
    case "DV_PREVIEW": {
      const r = await withTimeout(translateBatch([msg.term], cfg.targetLang), 5000, { error: "timeout" });
      if (r.error) return { error: r.error };
      return { translation: (r.translations && r.translations[0]) || "" };
    }
    case "DV_TOGGLE_HIGHLIGHT": {
      const tab = msg.tabId ? { id: msg.tabId } : sender.tab;
      return toggleHighlight(tab);
    }
    case "DV_GET_HL_WORDS": {
      if (!configured(cfg)) return { error: "not-configured" };
      return { words: await buildHighlightIndex(cfg) };
    }
    case "DV_GET_AUTO_HL": {
      const { hlAuto } = await chrome.storage.local.get({ hlAuto: false });
      return { auto: !!hlAuto };
    }
    case "DV_SET_AUTO_HL": {
      const auto = await setAutoHighlight(!!msg.on);
      return { auto };
    }
    case "DV_APPLY_HL": {
      const tab = msg.tabId ? { id: msg.tabId } : sender.tab;
      return applyHighlight(tab, !!msg.on);
    }
    case "DV_UPDATE_TRANSLATION": {
      if (!configured(cfg)) return { error: "not-configured" };
      return updateTranslation(cfg, msg.set, msg.id, msg.translation);
    }
    case "DV_GET_STATE": {
      const { setFiles } = await chrome.storage.local.get({ setFiles: [] });
      return {
        configured: configured(cfg),
        owner: cfg.owner, repo: cfg.repo, folder: cfg.folder,
        activeSet: state.activeSet, sets: state.sets, setFiles,
        sizeFull: VS.SIZE_FULL, warnRatio: VS.SIZE_WARN_RATIO,
        queue: state.queue.length, lastSaved: state.lastSaved
      };
    }
    case "DV_REFRESH_SETS": {
      if (!configured(cfg)) return { error: "not-configured" };
      const files = await listSetFiles(cfg);
      const sets = files.map((f) => f.name);
      const activeSet = sets.includes(state.activeSet) ? state.activeSet : (sets[0] || "");
      await chrome.storage.local.set({ sets, activeSet, setFiles: files });
      updateSetsIndex(cfg);
      return { sets, activeSet, setFiles: files, sizeFull: VS.SIZE_FULL, warnRatio: VS.SIZE_WARN_RATIO };
    }
    case "DV_SET_ACTIVE":
      await chrome.storage.local.set({ activeSet: msg.set });
      return { ok: true };
    case "DV_NEW_SET": {
      if (!configured(cfg)) return { error: "Not set up yet — open options first." };
      const clean = (msg.name || "").replace(/[^\p{L}\p{N} _-]/gu, "").trim();
      if (!clean) return { error: "Give the set a name." };
      const name = `${clean}.xlsx`;
      if ((await getFile(cfg, name)) !== null) return { error: `${name} already exists.` };
      const wb = VS.newWorkbook(clean);
      await putFile(cfg, name, VS.writeWorkbook(wb), `Create vocab set ${name}`);
      const files = await listSetFiles(cfg);
      const sets = files.map((f) => f.name);
      await chrome.storage.local.set({ sets, activeSet: name, setFiles: files });
      updateSetsIndex(cfg);
      return { ok: true, name, sets, setFiles: files };
    }
    case "DV_PROCESS_ALL": {
      if (!configured(cfg)) return { error: "not-configured" };
      if (!state.activeSet) return { error: "No active set." };
      return serialized(() => processAll(cfg, state.activeSet, false));
    }
    case "DV_LIST_CHOICES": {
      if (!configured(cfg)) return { error: "not-configured" };
      try {
        const choices = await listAllChoices(cfg, state.sets);
        return { choices };
      } catch (e) {
        return { error: e.message };
      }
    }
    case "DV_RESOLVE_CHOICE": {
      if (!configured(cfg)) return { error: "not-configured" };
      if (!msg.set || !msg.id) return { error: "Missing set or id." };
      return resolveChoice(cfg, msg.set, msg.id, { candidate: msg.candidate, translation: msg.translation });
    }
    case "DV_RETRY_QUEUE": {
      if (!configured(cfg)) return { error: "not-configured" };
      try {
        await serialized(() => flushQueueInner(cfg));
        return { ok: true, remaining: (await getState()).queue.length };
      } catch (e) {
        return { error: e.message, remaining: (await getState()).queue.length };
      }
    }
    case "DV_TEST_CONN": {
      const c = msg.cfg;
      if (!configured(c)) return { error: "Fill in token, owner and repository first." };
      const repoRes = await gh(c, `/repos/${c.owner}/${c.repo}`);
      if (repoRes.status === 401) return { error: "Token rejected (401). Check it was copied fully and hasn't expired." };
      if (repoRes.status === 404) return { error: "Repository not found (404). Check owner/repo spelling and that the token can access it." };
      if (!repoRes.ok) return { error: `GitHub answered ${repoRes.status}.` };
      const sets = await listSets(c).catch(() => []);
      return {
        ok: true,
        note: sets.length
          ? `Connected. Found ${sets.length} set file(s) in /${c.folder}.`
          : `Connected. The /${c.folder} folder will be created with your first set.`
      };
    }
    default:
      return { error: "unknown-message" };
  }
}

setBadge();

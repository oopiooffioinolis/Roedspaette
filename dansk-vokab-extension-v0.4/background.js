/* Dansk Vokab — background service worker (v0.4: iPhone inbox + auto-pilot). */
importScripts("lib/xlsx.full.min.js", "lib/vocab-sheets.js");

const VS = self.VocabSheets;
const GH = "https://api.github.com";
const MENU_ID = "dv-capture";
const ENRICH_TIMEOUT_MS = 9000;
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
  await chrome.action.setBadgeBackgroundColor({ color: "#C8102E" });
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
    const dd = await ordnetLookup(entry.term);
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
  return { b64: (json.content || "").replace(/\n/g, ""), sha: json.sha };
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
    .map((f) => ({ name: f.name, sha: f.sha }))
    .sort((a, b) => a.name.localeCompare(b.name, "da"));
}

async function listSets(cfg) {
  return (await listSetFiles(cfg)).map((f) => f.name);
}

/* ---------- save pipeline (serialized to avoid sha races) ---------- */

let chain = Promise.resolve();
function serialized(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function appendToSet(cfg, setName, entry) {
  let file = await getFile(cfg, setName);
  let wb = file ? VS.readWorkbook(file.b64) : VS.newWorkbook(setName.replace(/\.xlsx$/i, ""));
  let result = VS.appendEntry(wb, entry);
  if (result.duplicate) return { duplicate: true, set: setName };
  const label = entry.type === "word" ? "word" : "phrase";
  const msg = `Add ${label} "${entry.term}" to ${setName}`;
  try {
    await putFile(cfg, setName, VS.writeWorkbook(wb), msg, file ? file.sha : undefined);
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      file = await getFile(cfg, setName);
      wb = file ? VS.readWorkbook(file.b64) : VS.newWorkbook(setName.replace(/\.xlsx$/i, ""));
      result = VS.appendEntry(wb, entry);
      if (result.duplicate) return { duplicate: true, set: setName };
      await putFile(cfg, setName, VS.writeWorkbook(wb), msg, file ? file.sha : undefined);
    } else {
      throw e;
    }
  }
  return { duplicate: false, set: setName, status: entry.status, counts: VS.counts(wb) };
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

async function processPending(cfg, setName) {
  const file = await getFile(cfg, setName);
  if (!file) return { error: `${setName} not found in the repo.` };
  const wb = VS.readWorkbook(file.b64);
  VS.ensureColumns(wb);
  const pending = VS.listPending(wb);
  if (!pending.length) return { processed: 0, updated: 0, remaining: 0 };

  const batch = pending.slice(0, PENDING_BATCH);
  let updated = 0;
  let needsSetup = false;
  for (const row of batch) {
    const entry = { type: row.type, term: row.term };
    const info = await enrichEntry(entry, cfg);
    if (info.needsSetup) { needsSetup = true; continue; }
    if (!entry.status || entry.status === "pending") continue;
    const fields = entry.type === "word"
      ? { Lemma: entry.lemma, WordClass: entry.wordClass, Gender: entry.gender,
          Inflections: entry.inflections, IPA: entry.ipa, AudioURL: entry.audioURL,
          Definition: entry.definition, Translation: entry.translation, Status: entry.status }
      : { Gloss: entry.gloss, Translation: entry.translation, Status: entry.status };
    if (VS.updateRow(wb, row.sheet, row.row, fields)) updated++;
  }
  if (updated) {
    await putFile(cfg, setName, VS.writeWorkbook(wb), `Enrich ${updated} pending entr${updated === 1 ? "y" : "ies"} in ${setName}`, file.sha);
  }
  return { processed: batch.length, updated, remaining: pending.length - batch.length, needsSetup };
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
      // a payload may target a set, but only one that already exists — typos can't spawn files
      const setName = (entry.set && knownSets.includes(entry.set)) ? entry.set : activeSet;
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

/* Inbox + pending in one pass; used by the popup button and the background auto-pilot. */
async function processAll(cfg, activeSet, silent) {
  const knownSets = await listSets(cfg).catch(() => [activeSet]);
  const inbox = await processInbox(cfg, activeSet, knownSets).catch((e) => ({ error: e.message, found: 0, filed: 0, skipped: 0 }));
  const pend = await processPending(cfg, activeSet).catch((e) => ({ error: e.message, processed: 0, updated: 0 }));
  const didSomething = (inbox.filed || 0) + (pend.updated || 0) > 0;
  if (!silent || didSomething) {
    const bits = [];
    if (inbox.filed) bits.push(`${inbox.filed} phone capture${inbox.filed > 1 ? "s" : ""} filed → ${inbox.set}`);
    if (inbox.skipped) bits.push(`${inbox.skipped} skipped`);
    if (pend.updated) bits.push(`${pend.updated} pending entr${pend.updated > 1 ? "ies" : "y"} enriched`);
    if (bits.length) notify("Dansk Vokab", bits.join(" · "));
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
      const file = await getFile(cfg, f.name);
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
  return {
    id: crypto.randomUUID(),
    type: looksLikeWord(text) ? "word" : "phrase",
    term: text.trim().replace(/\s+/g, " "),
    snippet: "",
    sourceTitle: tab?.title || "",
    sourceURL: tab?.url || "",
    deepLink: "",
    note: "",
    dateAdded: new Date().toISOString().slice(0, 10)
  };
}

async function startCapture(tab, fallbackText) {
  if (!tab?.id) return;
  const { activeSet, sets } = await getState();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, {
      type: "DV_SHOW_CARD",
      activeSet,
      sets,
      fallbackText: fallbackText || ""
    });
  } catch (e) {
    if (fallbackText && fallbackText.trim()) {
      const res = await saveEntry(minimalEntry(fallbackText, tab));
      reportSave(res, fallbackText);
    } else {
      notify("Dansk Vokab", "Can't capture on this page.");
    }
  }
}

function reportSave(res, term) {
  if (res.error) notify("Dansk Vokab — not saved", res.error);
  else if (res.duplicate) notify("Already in the set", `"${term}" was skipped — it's already in ${res.set}.`);
  else if (res.queued) notify("Saved offline", `"${term}" is queued and will retry (${res.reason}).`);
  else if (res.needsSetup) notify("Saved — translation needs setup", `"${term}" → ${res.set}. Open Options once to download the free Danish language pack.`);
  else notify("Saved", `"${term}" → ${res.set}`);
}

/* ---------- wiring ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Save "%s" to Danish vocab', contexts: ["selection"] });
  });
  chrome.alarms.create("dv-auto", { periodInMinutes: 15, delayInMinutes: 1 });
  setBadge();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("dv-auto", { periodInMinutes: 15, delayInMinutes: 1 });
  autoProcess();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "dv-auto") autoProcess();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) startCapture(tab, info.selectionText || "");
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "capture-selection") startCapture(tab, "");
  if (command === "toggle-highlight") {
    const res = await toggleHighlight(tab);
    if (res && res.error) notify("Dansk Vokab", res.error);
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
    case "DV_UPDATE_TRANSLATION": {
      if (!configured(cfg)) return { error: "not-configured" };
      return updateTranslation(cfg, msg.set, msg.id, msg.translation);
    }
    case "DV_GET_STATE":
      return {
        configured: configured(cfg),
        owner: cfg.owner, repo: cfg.repo, folder: cfg.folder,
        activeSet: state.activeSet, sets: state.sets,
        queue: state.queue.length, lastSaved: state.lastSaved
      };
    case "DV_REFRESH_SETS": {
      if (!configured(cfg)) return { error: "not-configured" };
      const sets = await listSets(cfg);
      const activeSet = sets.includes(state.activeSet) ? state.activeSet : (sets[0] || "");
      await chrome.storage.local.set({ sets, activeSet });
      return { sets, activeSet };
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
      const sets = await listSets(cfg);
      await chrome.storage.local.set({ sets, activeSet: name });
      return { ok: true, name, sets };
    }
    case "DV_PROCESS_ALL": {
      if (!configured(cfg)) return { error: "not-configured" };
      if (!state.activeSet) return { error: "No active set." };
      return serialized(() => processAll(cfg, state.activeSet, false));
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

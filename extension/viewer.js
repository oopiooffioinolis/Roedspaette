/* Rødspætte — bundled PDF reader. Renders a PDF with PDF.js and runs the
   known-words highlighter over its text layer (which Chrome's built-in viewer
   can't expose). Opened opt-in from the popup as viewer.html?file=<pdf url>. */
import * as pdfjsLib from "./lib/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.mjs");

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fileUrl = params.get("file") || "";

const state = { hlOn: false, map: null, pages: [], doc: null, sourceTitle: "", sourceURL: "" };

function setStatus(t) { $("status").textContent = t || ""; }
function showError(html) { const e = $("error"); e.hidden = false; e.innerHTML = html; $("pages").hidden = true; }

function fileName(url) {
  try { return decodeURIComponent(url.split("#")[0].split("?")[0].split("/").pop()) || "PDF"; }
  catch (_) { return "PDF"; }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Load the raw PDF bytes ourselves. fetch() can't read file:// in Chrome, but
   XMLHttpRequest can (with "Allow access to file URLs" on), and for http(s) it
   works once the site's access has been granted. We then hand the bytes to
   PDF.js as {data}, so PDF.js never has to fetch anything itself. */
function loadBytes(url) {
  return new Promise((resolve, reject) => {
    let xhr;
    try { xhr = new XMLHttpRequest(); xhr.open("GET", url, true); }
    catch (e) { reject(new Error("bad-url")); return; }
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      const ok = xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300); // file:// resolves as status 0
      if (ok && xhr.response && xhr.response.byteLength) resolve(new Uint8Array(xhr.response));
      else if (ok) reject(new Error("empty"));
      else reject(new Error("http-" + xhr.status));
    };
    xhr.onerror = () => reject(new Error("access"));
    xhr.send();
  });
}

async function main() {
  if (!fileUrl) {
    document.title = "Rødspætte reader";
    $("title").textContent = "Rødspætte reader";
    showPicker("");
    return;
  }
  const name = fileName(fileUrl);
  document.title = name + " — Rødspætte";
  $("title").textContent = name;

  // Local files: Chrome forbids an extension page from reading file:// URLs
  // ("Not allowed to load local resource"), regardless of the file-access
  // toggle. So the user picks the file once via a normal dialog — the browser
  // then hands us the bytes with no path restriction.
  if (/^file:/i.test(fileUrl)) { showPicker(name); return; }

  setStatus("Loading…");
  let data;
  try {
    data = await loadBytes(fileUrl);
  } catch (e) {
    const reason = e && e.message;
    const advice = reason === "access"
      ? `<p>The extension isn't allowed to read this site yet. Reopen it from the extension popup and approve access when Chrome asks.</p>`
      : `<p>The server may have blocked the request, or the file needs a login. You can also open it as a local file below.</p>`;
    showError(
      `<p>Couldn't open this PDF.</p>` + advice +
      `<p style="opacity:.7">Details: ${esc(reason || String(e))}</p>` +
      `<p><a href="${esc(fileUrl)}">Open the PDF directly ↗</a> &nbsp;·&nbsp; <a href="#" id="err-pick">choose a file instead</a></p>`
    );
    const p = $("err-pick");
    if (p) p.onclick = (ev) => { ev.preventDefault(); showPicker(name); };
    setStatus("");
    return;
  }
  await openData(data, name, fileUrl);
}

/* Build page placeholders and lazily render them. */
async function openData(data, name, srcUrl) {
  state.sourceTitle = name || "";
  state.sourceURL = srcUrl || "";
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    showError(`<p>That file couldn't be read as a PDF.</p><p style="opacity:.7">${esc(e.message || String(e))}</p>`);
    return;
  }
  $("error").hidden = true;
  $("pick").hidden = true;
  $("pages").hidden = false;
  if (name) { document.title = name + " — Rødspætte"; $("title").textContent = name; }

  state.doc = doc;
  const container = $("pages");
  container.innerHTML = "";
  state.pages = [];
  const targetW = Math.min(window.innerWidth - 40, 900);

  for (let i = 1; i <= doc.numPages; i++) {
    const holder = document.createElement("div");
    holder.className = "page";
    holder.dataset.page = String(i);
    container.appendChild(holder);
    state.pages.push({ num: i, holder, rendered: false, textLayer: null });
  }
  setStatus(`${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const p = state.pages.find((x) => x.holder === en.target);
      if (p && !p.rendered) renderPage(p, targetW);
    }
  }, { rootMargin: "800px 0px" });
  state.pages.forEach((p) => io.observe(p.holder));
  maybeAutoHighlight();
}

/* File picker for local PDFs. */
function showPicker(name) {
  $("pages").hidden = true;
  $("error").hidden = true;
  const pick = $("pick");
  pick.hidden = false;
  $("pick-lead").textContent = name ? "This PDF is on your computer." : "Open a PDF to read it here.";
  $("pick-name").textContent = name ? `“${name}”` : "";
}
$("pick-btn").addEventListener("click", () => $("pick-input").click());
$("pick-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  setStatus("Loading…");
  try {
    const buf = await file.arrayBuffer();
    await openData(new Uint8Array(buf), file.name, "");
  } catch (err) {
    showError(`<p>Couldn't read that file.</p><p style="opacity:.7">${esc(err.message || String(err))}</p>`);
    setStatus("");
  }
});

async function renderPage(p, targetW) {
  p.rendered = true;
  let page;
  try { page = await state.doc.getPage(p.num); } catch (_) { p.rendered = false; return; }
  const base = page.getViewport({ scale: 1 });
  const scale = targetW / base.width;
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  p.holder.style.width = Math.floor(viewport.width) + "px";
  p.holder.style.height = Math.floor(viewport.height) + "px";

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = Math.floor(viewport.width) + "px";
  canvas.style.height = Math.floor(viewport.height) + "px";
  const ctx = canvas.getContext("2d", { alpha: false });
  p.holder.appendChild(canvas);
  await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;

  const tl = document.createElement("div");
  tl.className = "textLayer";
  tl.style.setProperty("--scale-factor", String(scale));
  p.holder.appendChild(tl);
  const textLayer = new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: tl, viewport });
  await textLayer.render();
  p.textLayer = tl;

  if (state.hlOn && state.map) highlightContainer(tl);
}

/* ---------------- known-words highlighter ---------------- */

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.classList.contains("dv-known-word") || p.classList.contains("endOfContent")) return NodeFilter.FILTER_REJECT;
      if (!/\p{L}/u.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

function highlightContainer(root) {
  if (!state.map) return 0;
  const re = /\p{L}+/gu;
  let count = 0;
  for (const node of collectTextNodes(root)) {
    const text = node.nodeValue;
    let m, last = 0, frag = null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const entry = state.map.get(m[0].toLowerCase());
      if (!entry) continue;
      if (!frag) frag = document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const s = document.createElement("span");
      s.className = "dv-known-word";
      s.textContent = m[0];
      s.dataset.form = m[0].toLowerCase();
      if (entry.t) s.title = entry.t;
      frag.appendChild(s);
      last = m.index + m[0].length;
      count++;
    }
    if (frag) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
  }
  return count;
}

function highlightAll() {
  let count = 0;
  for (const p of state.pages) if (p.textLayer) count += highlightContainer(p.textLayer);
  return count;
}

function unhighlightAll() {
  closePop();
  for (const s of document.querySelectorAll(".dv-known-word")) {
    const t = document.createTextNode(s.textContent);
    s.replaceWith(t);
  }
  // merge adjacent text nodes so future passes see whole words again
  for (const p of state.pages) if (p.textLayer) p.textLayer.normalize();
}

async function toggleHighlight() {
  const btn = $("hl");
  if (state.hlOn) {
    unhighlightAll();
    state.hlOn = false;
    btn.classList.remove("on");
    setStatus(state.doc ? `${state.doc.numPages} pages` : "");
    chrome.runtime.sendMessage({ type: "DV_SET_AUTO_HL", on: false }).catch(() => {});
    return;
  }
  btn.disabled = true;
  setStatus("Building word index…");
  const r = await chrome.runtime.sendMessage({ type: "DV_GET_HL_WORDS" }).catch((e) => ({ error: e.message }));
  btn.disabled = false;
  if (!r || r.error) { setStatus(r && r.error === "not-configured" ? "Set up the extension first (Options)." : "Couldn't build the index."); return; }
  state.map = new Map(Object.entries(r.words || {}));
  state.hlOn = true;
  btn.classList.add("on");
  const count = highlightAll();
  setStatus(`${count} known word${count === 1 ? "" : "s"}`);
  // Persist the mode so it stays on for future PDFs and web pages. Best-effort
  // ask for all-sites access so web pages auto-highlight too (needs a gesture).
  try { await chrome.permissions.request({ origins: ["*://*/*"] }); } catch (_) {}
  chrome.runtime.sendMessage({ type: "DV_SET_AUTO_HL", on: true }).catch(() => {});
}
$("hl").addEventListener("click", toggleHighlight);

async function maybeAutoHighlight() {
  try {
    const a = await chrome.runtime.sendMessage({ type: "DV_GET_AUTO_HL" });
    if (!a || !a.auto || state.hlOn) return;
    const r = await chrome.runtime.sendMessage({ type: "DV_GET_HL_WORDS" });
    if (!r || r.error || !r.words) return;
    state.map = new Map(Object.entries(r.words));
    state.hlOn = true;
    $("hl").classList.add("on");
    highlightAll();
    setStatus("Highlighting on");
  } catch (_) {}
}

/* ---------------- translation popover ---------------- */

let popEntry = null;

function closePop() { $("pop").style.display = "none"; popEntry = null; }

function openPop(span) {
  const entry = state.map && state.map.get(span.dataset.form);
  if (!entry) return;
  popEntry = { set: entry.set, id: entry.id, span };
  $("pop-word").innerHTML = esc(span.textContent) +
    (entry.lemma && entry.lemma.toLowerCase() !== span.textContent.toLowerCase()
      ? `<span class="base">→ ${esc(entry.lemma)}</span>` : "");
  $("pop-set").textContent = (entry.set || "").replace(/\.xlsx$/i, "");
  $("pop-tr").value = entry.t || "";
  const msg = $("pop-msg"); msg.textContent = entry.id ? "" : "This word has no ID yet — translation can't be saved."; msg.className = "msg" + (entry.id ? "" : " bad");

  const pop = $("pop");
  pop.style.display = "block";
  const r = span.getBoundingClientRect();
  const top = window.scrollY + r.bottom + 6;
  let left = window.scrollX + r.left;
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - pop.offsetWidth - 8));
  pop.style.top = top + "px";
  pop.style.left = left + "px";
  setTimeout(() => $("pop-tr").focus(), 30);
}

document.addEventListener("click", (e) => {
  const hit = e.target.closest && e.target.closest(".dv-known-word");
  if (hit) { e.preventDefault(); openPop(hit); return; }
  if (!e.target.closest || !e.target.closest("#pop")) closePop();
}, true);

$("pop-x").addEventListener("click", closePop);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });

async function savePopTranslation() {
  if (!popEntry || !popEntry.id) return;
  const translation = $("pop-tr").value.trim();
  const msg = $("pop-msg");
  msg.textContent = "Saving…"; msg.className = "msg";
  const r = await chrome.runtime.sendMessage({ type: "DV_UPDATE_TRANSLATION", set: popEntry.set, id: popEntry.id, translation })
    .catch((e) => ({ error: e.message }));
  if (r && r.error) { msg.textContent = r.error; msg.className = "msg bad"; return; }
  msg.textContent = "Saved ✓"; msg.className = "msg ok";
  // update in-memory index + any highlighted spans for this form
  const form = popEntry.span.dataset.form;
  const entry = state.map.get(form);
  if (entry) entry.t = translation;
  for (const s of document.querySelectorAll('.dv-known-word[data-form="' + CSS.escape(form) + '"]')) s.title = translation;
  setTimeout(closePop, 500);
}
$("pop-tr").addEventListener("keydown", (e) => { if (e.key === "Enter") savePopTranslation(); });

/* ---------------- capture: card + selection button + shortcuts ---------------- */

let capState = null;                       // cached { configured, sets, activeSet }
let lastSel = { text: "", rect: null };
let previewSeq = 0;
let capTermDebounce = null;

function currentSelectionText() {
  const s = window.getSelection();
  return (s && s.toString().replace(/\s+/g, " ").trim()) || "";
}
function selectionRect() {
  const s = window.getSelection();
  try { if (s && s.rangeCount) return s.getRangeAt(0).getBoundingClientRect(); } catch (_) {}
  return null;
}

function showSavebar(rect) {
  const b = $("savebar");
  b.hidden = false; b.style.display = "block";
  b.style.top = (window.scrollY + (rect ? rect.bottom + 8 : 80)) + "px";
  b.style.left = Math.max(8, window.scrollX + (rect ? rect.left : 40)) + "px";
}
function hideSavebar() { $("savebar").style.display = "none"; }

document.addEventListener("mouseup", (e) => {
  if (e.target.closest && (e.target.closest("#cap") || e.target.closest("#pop") || e.target.closest("#bar") || e.target.closest("#savebar"))) return;
  setTimeout(() => {
    const t = currentSelectionText();
    if (t) { lastSel = { text: t, rect: selectionRect() }; showSavebar(lastSel.rect); }
    else hideSavebar();
  }, 0);
});
document.addEventListener("scroll", hideSavebar, true);
$("savebar").addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection alive
$("savebar").addEventListener("click", () => { hideSavebar(); openCaptureCard(lastSel.text, lastSel.rect); });

function closeCap() { $("cap").style.display = "none"; }

async function openCaptureCard(text, rect) {
  text = (text || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  closePop(); hideSavebar();
  if (!capState) capState = await chrome.runtime.sendMessage({ type: "DV_GET_STATE" }).catch(() => null);

  const setSel = $("cap-set");
  setSel.innerHTML = "";
  const sets = (capState && capState.sets) || [];
  const active = (capState && capState.activeSet) || sets[0] || "";
  if (sets.length) {
    for (const s of sets) { const o = document.createElement("option"); o.textContent = s; o.selected = s === active; setSel.appendChild(o); }
  } else {
    const o = document.createElement("option"); o.value = ""; o.textContent = "(no sets — create one in the popup)"; setSel.appendChild(o);
  }
  $("cap-term").value = text;
  $("cap-note").value = "";
  const tr = $("cap-tr"); tr.value = ""; tr.placeholder = "translating…"; tr.dataset.dirty = "";
  const msg = $("cap-msg");
  msg.className = "msg";
  msg.textContent = (capState && !capState.configured) ? "Set up the extension first (Options)." : "";
  $("cap-save").disabled = false;

  const cap = $("cap");
  cap.style.display = "block";
  const maxTop = window.scrollY + window.innerHeight - cap.offsetHeight - 12;
  const top = window.scrollY + (rect ? rect.bottom + 10 : 90);
  let left = window.scrollX + (rect ? rect.left : 40);
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - cap.offsetWidth - 8));
  cap.style.top = Math.max(window.scrollY + 8, Math.min(top, maxTop)) + "px";
  cap.style.left = left + "px";
  setTimeout(() => $("cap-term").focus(), 20);
  previewTr(text);
}

async function previewTr(term) {
  if (!term) return;
  const tr = $("cap-tr");
  const seq = ++previewSeq;
  const r = await chrome.runtime.sendMessage({ type: "DV_PREVIEW", term }).catch(() => null);
  if (seq !== previewSeq || tr.dataset.dirty || $("cap").style.display !== "block") return;
  if (r && r.translation) tr.value = r.translation;
  else tr.placeholder = "type a translation…";
}

async function saveCap() {
  const term = $("cap-term").value.replace(/\s+/g, " ").trim();
  if (!term) return;
  const setVal = $("cap-set").value;
  const entry = {
    id: crypto.randomUUID(),
    type: term.split(/\s+/).length === 1 ? "word" : "phrase",
    term,
    translation: $("cap-tr").value.trim(),
    snippet: "",
    note: $("cap-note").value.trim(),
    set: setVal || undefined,
    sourceTitle: state.sourceTitle || document.title.replace(/ — Rødspætte$/, ""),
    sourceURL: state.sourceURL || "",
    deepLink: "",
    dateAdded: new Date().toISOString().slice(0, 10)
  };
  const msg = $("cap-msg");
  msg.textContent = "Looking up & saving…"; msg.className = "msg";
  $("cap-save").disabled = true;
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "DV_SAVE", entry }); }
  catch (e) { res = { error: e.message }; }
  $("cap-save").disabled = false;
  if (res && res.error) { msg.textContent = res.error; msg.className = "msg bad"; return; }
  if (res && res.duplicate) { msg.textContent = `Already in ${res.set} — skipped`; msg.className = "msg"; }
  else if (res && res.queued) { msg.textContent = "Queued — will retry"; msg.className = "msg"; }
  else if (res && res.needsSetup) { msg.textContent = `Saved → ${res.set} (enable translation in Options)`; msg.className = "msg ok"; }
  else { msg.textContent = `Saved → ${res.set}${res.status === "ok" ? " ✓ enriched" : res.status === "not-found" ? " (not in DDO)" : ""}`; msg.className = "msg ok"; }
  setTimeout(closeCap, 1300);
}

$("cap-x").addEventListener("click", closeCap);
$("cap-cancel").addEventListener("click", closeCap);
$("cap-save").addEventListener("click", saveCap);
$("cap-tr").addEventListener("input", () => { $("cap-tr").dataset.dirty = "1"; });
$("cap-term").addEventListener("input", (e) => {
  clearTimeout(capTermDebounce);
  const v = e.target.value.trim();
  capTermDebounce = setTimeout(() => { if (!$("cap-tr").dataset.dirty) previewTr(v); }, 400);
});
for (const id of ["cap-term", "cap-tr", "cap-note"]) {
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveCap(); } });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeCap(); hideSavebar(); } });

// Global shortcuts (Alt+Shift+D / Alt+Shift+H) fire in the background; it relays
// them here so they can read this page's selection.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "DV_READER_CMD" || !document.hasFocus()) return;
  if (msg.cmd === "capture") openCaptureCard(msg.text || currentSelectionText(), lastSel.rect || selectionRect());
  else if (msg.cmd === "highlight") toggleHighlight();
});

main();

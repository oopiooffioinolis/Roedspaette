/* Dansk Vokab — bundled PDF reader. Renders a PDF with PDF.js and runs the
   known-words highlighter over its text layer (which Chrome's built-in viewer
   can't expose). Opened opt-in from the popup as viewer.html?file=<pdf url>. */
import * as pdfjsLib from "./lib/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.mjs");

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fileUrl = params.get("file") || "";

const state = { hlOn: false, map: null, pages: [], doc: null };

function setStatus(t) { $("status").textContent = t || ""; }
function showError(html) { const e = $("error"); e.hidden = false; e.innerHTML = html; $("pages").hidden = true; }

function fileName(url) {
  try { return decodeURIComponent(url.split("#")[0].split("?")[0].split("/").pop()) || "PDF"; }
  catch (_) { return "PDF"; }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function main() {
  if (!fileUrl) { showError("No file was specified."); return; }
  const name = fileName(fileUrl);
  document.title = name + " — Dansk Vokab";
  $("title").textContent = name;
  setStatus("Loading…");

  let doc;
  try {
    doc = await pdfjsLib.getDocument({ url: fileUrl, isEvalSupported: false }).promise;
  } catch (e) {
    const isFile = /^file:/i.test(fileUrl);
    showError(
      `<p>Couldn't open this PDF.</p>` +
      (isFile
        ? `<p>For local files, enable <b>“Allow access to file URLs”</b> for Dansk Vokab at <code>chrome://extensions</code> → Details, then reopen.</p>`
        : `<p>The extension may not have permission to read this site's files, or the server blocked the request.</p>`) +
      `<p style="opacity:.7">${esc(e.message || String(e))}</p>` +
      `<p><a href="${esc(fileUrl)}">Open the PDF directly ↗</a></p>`
    );
    setStatus("");
    return;
  }

  state.doc = doc;
  const container = $("pages");
  const targetW = Math.min(window.innerWidth - 40, 900);

  // Placeholders sized to each page; render lazily as they scroll into view.
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
}

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

$("hl").addEventListener("click", async () => {
  const btn = $("hl");
  if (state.hlOn) {
    unhighlightAll();
    state.hlOn = false;
    btn.classList.remove("on");
    setStatus(state.doc ? `${state.doc.numPages} pages` : "");
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
  setStatus(`${count} known word${count === 1 ? "" : "s"} on rendered pages`);
});

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
  $("pop-save").disabled = !entry.id;

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

$("pop-close").addEventListener("click", closePop);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });

async function savePopTranslation() {
  if (!popEntry || !popEntry.id) return;
  const translation = $("pop-tr").value.trim();
  const msg = $("pop-msg");
  msg.textContent = "Saving…"; msg.className = "msg";
  $("pop-save").disabled = true;
  const r = await chrome.runtime.sendMessage({ type: "DV_UPDATE_TRANSLATION", set: popEntry.set, id: popEntry.id, translation })
    .catch((e) => ({ error: e.message }));
  $("pop-save").disabled = false;
  if (r && r.error) { msg.textContent = r.error; msg.className = "msg bad"; return; }
  msg.textContent = "Saved ✓"; msg.className = "msg ok";
  // update in-memory index + any highlighted spans for this form
  const form = popEntry.span.dataset.form;
  const entry = state.map.get(form);
  if (entry) entry.t = translation;
  for (const s of document.querySelectorAll('.dv-known-word[data-form="' + CSS.escape(form) + '"]')) s.title = translation;
  setTimeout(closePop, 500);
}
$("pop-save").addEventListener("click", savePopTranslation);
$("pop-tr").addEventListener("keydown", (e) => { if (e.key === "Enter") savePopTranslation(); });

main();

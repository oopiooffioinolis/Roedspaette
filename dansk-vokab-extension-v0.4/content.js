/* Dansk Vokab — in-page capture card + known-words highlighter. Injected on demand. */
(() => {
  if (window.__dvLoaded) return;
  window.__dvLoaded = true;

  const BLOCKS = new Set(["P", "LI", "TD", "TH", "BLOCKQUOTE", "ARTICLE", "SECTION",
    "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "DD", "DT", "FIGCAPTION", "PRE", "MAIN", "ASIDE"]);

  let host = null;

  const send = (msg) => chrome.runtime.sendMessage(msg);

  function closestBlock(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && el !== document.body) {
      if (BLOCKS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function paragraphAround(sel, text) {
    const block = closestBlock(sel.anchorNode) || closestBlock(sel.focusNode);
    let para = (block ? block.innerText : "").replace(/\s+/g, " ").trim();
    if (!para) return "";
    if (para.length > 480) {
      const i = para.indexOf(text);
      if (i >= 0) {
        const start = Math.max(0, i - 180);
        const end = Math.min(para.length, i + text.length + 180);
        para = (start > 0 ? "… " : "") + para.slice(start, end).trim() + (end < para.length ? " …" : "");
      } else {
        para = para.slice(0, 480).trim() + " …";
      }
    }
    return para;
  }

  function deepLink(text) {
    const base = location.href.split("#")[0];
    let frag = text.trim().replace(/\s+/g, " ");
    if (frag.length > 80) {
      frag = frag.slice(0, 80);
      const cut = frag.lastIndexOf(" ");
      if (cut > 30) frag = frag.slice(0, cut);
    }
    return frag ? `${base}#:~:text=${encodeURIComponent(frag)}` : base;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function removeCard() {
    if (host) { host.remove(); host = null; }
    document.removeEventListener("keydown", onKey, true);
  }

  function onKey(e) {
    if (e.key === "Escape") { removeCard(); e.stopPropagation(); }
  }

  /* ====================== capture card ====================== */

  function showCard(msg) {
    removeCard();
    const sel = window.getSelection();
    const raw = (sel && sel.toString().trim()) || msg.fallbackText || "";
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return { error: "no-selection" };

    const snippet = sel && sel.rangeCount ? paragraphAround(sel, text) : "";
    const link = deepLink(text);
    let rect = { bottom: 80, left: 40 };
    try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (_) {}

    const sets = msg.sets || [];
    const active = msg.activeSet || sets[0] || "";
    const isWord = text.split(/\s+/).length === 1;

    host = document.createElement("div");
    host.style.cssText = "all:initial; position:fixed; z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .card { width: 344px; background: #fff; color: #1c1c1c; border: 1px solid #e3e0db;
                border-left: 4px solid #C8102E; border-radius: 10px;
                box-shadow: 0 10px 30px rgba(20,16,12,.18); padding: 14px 16px 16px; }
        .top { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .flag { width: 16px; height: 12px; background: #C8102E; position: relative; border-radius: 2px; flex: none; }
        .flag::before, .flag::after { content: ""; position: absolute; background: #fff; }
        .flag::before { left: 5px; top: 0; width: 2px; height: 100%; }
        .flag::after { top: 5px; left: 0; height: 2px; width: 100%; }
        .brand { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8a857d; flex: 1; }
        .pills { display: flex; gap: 6px; }
        .pill { font-size: 11px; padding: 3px 9px; border-radius: 99px; border: 1px solid #d8d4cd;
                background: #faf9f7; color: #6b665e; cursor: pointer; }
        .pill[aria-pressed="true"] { background: #C8102E; border-color: #C8102E; color: #fff; }
        label { display: block; font-size: 11px; color: #8a857d; margin: 9px 0 3px; }
        input[type="text"], textarea, select { width: 100%; font-size: 13px; color: #1c1c1c;
                border: 1px solid #d8d4cd; border-radius: 6px; padding: 6px 8px; background: #fff; }
        textarea { resize: vertical; min-height: 52px; line-height: 1.35; }
        input:focus, textarea:focus, select:focus, .pill:focus, button:focus {
                outline: 2px solid #C8102E; outline-offset: 1px; }
        .term { font-size: 15px; font-weight: 600; }
        .tr { font-style: italic; color: #2a2722; }
        .row { display: flex; gap: 8px; align-items: center; }
        .row > div { flex: 1; }
        .remember { display: flex; gap: 6px; align-items: center; font-size: 11.5px; color: #6b665e; margin-top: 8px; }
        .remember input { width: auto; }
        .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
        button { font-size: 13px; border-radius: 7px; padding: 7px 14px; cursor: pointer; border: 1px solid #d8d4cd; background: #fff; color: #1c1c1c; }
        button.save { background: #C8102E; border-color: #C8102E; color: #fff; font-weight: 600; }
        button:disabled { opacity: .55; cursor: default; }
        .status { font-size: 12px; margin-right: auto; align-self: center; color: #6b665e; }
        .status.ok { color: #1d7a3a; } .status.bad { color: #C8102E; }
        .src { font-size: 11px; color: #a09a91; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      </style>
      <div class="card" role="dialog" aria-label="Save to Danish vocab">
        <div class="top">
          <div class="flag" aria-hidden="true"></div>
          <div class="brand">Dansk Vokab</div>
          <div class="pills">
            <button class="pill" data-type="word" aria-pressed="${isWord}">Word</button>
            <button class="pill" data-type="phrase" aria-pressed="${!isWord}">Phrase</button>
          </div>
        </div>
        <label for="dv-term">${isWord ? "Word" : "Phrase"}</label>
        <input class="term" id="dv-term" type="text" value="${esc(text)}">
        <label for="dv-tr">Translation — click to edit · Enter saves</label>
        <input class="tr" id="dv-tr" type="text" placeholder="translating…">
        <label for="dv-snippet">Context snippet</label>
        <textarea id="dv-snippet">${esc(snippet)}</textarea>
        <div class="row">
          <div>
            <label for="dv-set">Save to set</label>
            <select id="dv-set">${
              sets.length
                ? sets.map((s) => `<option ${s === active ? "selected" : ""}>${esc(s)}</option>`).join("")
                : `<option value="">(no sets yet — create one in the popup)</option>`
            }</select>
          </div>
          <div>
            <label for="dv-note">Note (optional)</label>
            <input id="dv-note" type="text" placeholder="e.g. heard at work">
          </div>
        </div>
        <div class="remember"><input type="checkbox" id="dv-remember"><label for="dv-remember" style="margin:0">Make this the active set</label></div>
        <div class="actions">
          <div class="status" id="dv-status"></div>
          <button class="cancel" id="dv-cancel">Cancel</button>
          <button class="save" id="dv-save">Save</button>
        </div>
        <div class="src" title="${esc(location.href)}">${esc(document.title || location.hostname)}</div>
      </div>`;

    document.documentElement.appendChild(host);
    const card = shadow.querySelector(".card");
    const top = Math.min(Math.max(8, rect.bottom + 10), window.innerHeight - card.offsetHeight - 12);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - 360);
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    document.addEventListener("keydown", onKey, true);

    let type = isWord ? "word" : "phrase";
    const $ = (q) => shadow.querySelector(q);
    shadow.querySelectorAll(".pill").forEach((p) =>
      p.addEventListener("click", () => {
        type = p.dataset.type;
        shadow.querySelectorAll(".pill").forEach((x) => x.setAttribute("aria-pressed", String(x === p)));
      })
    );
    $("#dv-cancel").addEventListener("click", removeCard);

    /* live translation preview, editable */
    let trDirty = false;
    let previewSeq = 0;
    const trInput = $("#dv-tr");
    trInput.addEventListener("input", () => { trDirty = true; });
    async function preview(term) {
      const seq = ++previewSeq;
      const r = await send({ type: "DV_PREVIEW", term }).catch(() => null);
      if (seq !== previewSeq || trDirty || !host) return;
      if (r && r.translation) trInput.value = r.translation;
      else if (r && r.error === "needs-setup") trInput.placeholder = "enable translation in Options";
      else if (r && r.error === "unsupported") trInput.placeholder = "type a translation…";
      else if (!r || r.error) trInput.placeholder = "type a translation…";
    }
    preview(text);
    let debounce = null;
    $("#dv-term").addEventListener("input", (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (!trDirty) preview(e.target.value.trim()); }, 400);
    });

    const saveNow = () => $("#dv-save").click();
    $("#dv-term").addEventListener("keydown", (e) => { if (e.key === "Enter") saveNow(); });
    trInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveNow(); });
    $("#dv-note").addEventListener("keydown", (e) => { if (e.key === "Enter") saveNow(); });

    $("#dv-save").addEventListener("click", async () => {
      const setSel = $("#dv-set").value;
      const entry = {
        id: crypto.randomUUID(),
        type,
        term: $("#dv-term").value.trim(),
        translation: trInput.value.trim(),
        snippet: $("#dv-snippet").value.trim(),
        note: $("#dv-note").value.trim(),
        set: setSel || undefined,
        sourceTitle: document.title || "",
        sourceURL: location.href.split("#")[0],
        deepLink: link,
        dateAdded: new Date().toISOString().slice(0, 10)
      };
      if (!entry.term) return;
      const status = $("#dv-status");
      $("#dv-save").disabled = true;
      status.textContent = "Looking up & saving…"; status.className = "status";
      let res;
      try {
        if ($("#dv-remember").checked && setSel) {
          await send({ type: "DV_SET_ACTIVE", set: setSel });
        }
        res = await send({ type: "DV_SAVE", entry });
      } catch (e) {
        res = { error: e.message };
      }
      if (res?.error) { status.textContent = res.error; status.className = "status bad"; $("#dv-save").disabled = false; return; }
      if (res?.duplicate) { status.textContent = `Already in ${res.set} — skipped`; status.className = "status"; }
      else if (res?.queued) { status.textContent = "Queued — will retry"; status.className = "status"; }
      else if (res?.needsSetup) { status.textContent = `Saved → ${res.set} (enable translation in Options)`; status.className = "status"; }
      else { status.textContent = `Saved → ${res.set}${res.status === "ok" ? " ✓ enriched" : res.status === "not-found" ? " (not in DDO)" : ""}`; status.className = "status ok"; }
      setTimeout(removeCard, 1400);
    });

    setTimeout(() => $("#dv-term").focus(), 0);
    return { ok: true };
  }

  /* ====================== known-words highlighter ====================== */

  const HL = { on: false, map: null, spans: [], styleEl: null, clickBound: false };
  const MAX_SPANS = 3000;
  let trBox = null;

  function injectHlStyle() {
    if (HL.styleEl) return;
    HL.styleEl = document.createElement("style");
    HL.styleEl.textContent = `
      .dv-known-word { background: rgba(200,16,46,.13); border-bottom: 2px solid rgba(200,16,46,.6);
                       border-radius: 2px; cursor: pointer; }
      .dv-known-word:hover { background: rgba(200,16,46,.28); }`;
    document.documentElement.appendChild(HL.styleEl);
  }

  function collectTextNodes() {
    const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|SELECT|OPTION|CODE|PRE)$/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || skip.test(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (p.closest(".dv-known-word")) return NodeFilter.FILTER_REJECT;
        if (!/\p{L}/u.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function wrapMatches() {
    const nodes = collectTextNodes();
    const re = /\p{L}+/gu;
    let count = 0;
    for (const node of nodes) {
      if (count >= MAX_SPANS) break;
      const text = node.nodeValue;
      let m, last = 0, frag = null;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        const entry = HL.map.get(m[0].toLowerCase());
        if (!entry) continue;
        if (!frag) frag = document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const s = document.createElement("span");
        s.className = "dv-known-word";
        s.textContent = m[0];
        s.dataset.dvForm = m[0].toLowerCase();
        frag.appendChild(s);
        HL.spans.push(s);
        last = m.index + m[0].length;
        if (++count >= MAX_SPANS) break;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.replaceWith(frag);
      }
    }
    return count;
  }

  function onHlClick(e) {
    if (!HL.on) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const hit = path.find((el) => el && el.classList && el.classList.contains("dv-known-word"));
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    openTrBox(hit);
  }

  function hlOn(words) {
    HL.map = new Map(Object.entries(words || {}));
    injectHlStyle();
    const count = wrapMatches();
    HL.on = true;
    if (!HL.clickBound) {
      document.addEventListener("click", onHlClick, true);
      HL.clickBound = true;
    }
    return count;
  }

  function hlOff() {
    closeTrBox();
    for (const s of HL.spans) {
      if (s.isConnected) s.replaceWith(document.createTextNode(s.textContent));
    }
    HL.spans = [];
    HL.on = false;
    if (HL.styleEl) { HL.styleEl.remove(); HL.styleEl = null; }
  }

  /* ---- the persistent translation box (Enter saves & closes, Esc closes) ---- */

  function closeTrBox() {
    if (trBox) { trBox.remove(); trBox = null; }
  }

  function openTrBox(span) {
    closeTrBox();
    const form = span.dataset.dvForm;
    const entry = HL.map.get(form);
    if (!entry) return;
    const rect = span.getBoundingClientRect();

    trBox = document.createElement("div");
    trBox.style.cssText = "all:initial; position:absolute; z-index:2147483647;";
    trBox.style.top = `${rect.bottom + window.scrollY + 6}px`;
    trBox.style.left = `${Math.min(Math.max(8, rect.left + window.scrollX), window.scrollX + Math.max(8, window.innerWidth - 312))}px`;
    const shadow = trBox.attachShadow({ mode: "closed" });
    const showsLemma = entry.lemma && entry.lemma.toLowerCase() !== form;
    const showsTerm = !showsLemma && entry.term && entry.term.toLowerCase() !== form;
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .box { width: 300px; background: #fff; color: #1c1c1c; border: 1px solid #e3e0db;
               border-left: 4px solid #C8102E; border-radius: 9px; padding: 11px 13px 12px;
               box-shadow: 0 8px 26px rgba(20,16,12,.2); }
        .word { font-size: 15px; font-weight: 700; }
        .base { font-size: 12px; color: #8a857d; margin-left: 6px; font-weight: 400; }
        input { width: 100%; margin-top: 8px; font-size: 13.5px; font-style: italic; color: #2a2722;
                border: 1px solid transparent; border-bottom: 1px dashed #d8d4cd; border-radius: 4px;
                padding: 4px 6px; background: #fff; cursor: text; }
        input:hover { border-color: #d8d4cd; }
        input:focus { outline: none; border: 1px solid #C8102E; font-style: normal; }
        .meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px;
                font-size: 10.5px; color: #a09a91; }
        .status { font-size: 11.5px; margin-top: 5px; color: #6b665e; min-height: 13px; }
        .status.bad { color: #C8102E; }
      </style>
      <div class="box" role="dialog" aria-label="Translation">
        <div class="word">${esc(span.textContent)}${showsLemma ? `<span class="base">→ ${esc(entry.lemma)}</span>` : showsTerm ? `<span class="base">→ ${esc(entry.term)}</span>` : ""}</div>
        <input id="dv-hl-tr" type="text" value="${esc(entry.t || "")}" placeholder="add a translation…">
        <div class="status" id="dv-hl-status"></div>
        <div class="meta"><span>${esc(entry.set)}</span><span>Enter saves · Esc closes</span></div>
      </div>`;
    document.documentElement.appendChild(trBox);

    const input = shadow.querySelector("#dv-hl-tr");
    const status = shadow.querySelector("#dv-hl-status");

    if (!entry.t) {
      input.placeholder = "translating…";
      send({ type: "DV_PREVIEW", term: entry.lemma || entry.term })
        .then((r) => {
          if (trBox && r && r.translation && !input.value) {
            input.value = r.translation;
            status.textContent = "suggestion — Enter to keep it";
          } else if (trBox && !input.value) {
            input.placeholder = "add a translation…";
          }
        })
        .catch(() => {});
    }

    async function commit() {
      const v = input.value.trim();
      if (v === (entry.t || "")) { closeTrBox(); return; }
      if (!entry.id) { status.textContent = "Can't save — this row has no ID."; status.className = "status bad"; return; }
      status.textContent = "Saving…"; status.className = "status";
      let r;
      try { r = await send({ type: "DV_UPDATE_TRANSLATION", set: entry.set, id: entry.id, translation: v }); }
      catch (e) { r = { error: e.message }; }
      if (r && r.ok) {
        for (const [, ent] of HL.map) if (ent.id === entry.id) ent.t = v;
        closeTrBox();
      } else {
        status.textContent = (r && r.error) || "Save failed."; status.className = "status bad";
      }
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.stopPropagation(); closeTrBox(); }
    });
    setTimeout(() => input.focus(), 0);
  }

  /* ====================== messaging ====================== */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "DV_SHOW_CARD") {
      sendResponse(showCard(msg));
    } else if (msg.type === "DV_HIGHLIGHT") {
      if (msg.action === "toggle") {
        if (HL.on) { hlOff(); sendResponse({ on: false }); }
        else sendResponse({ needWords: true });
      } else if (msg.action === "on") {
        const count = hlOn(msg.words);
        sendResponse({ on: true, count });
      } else if (msg.action === "off") {
        hlOff();
        sendResponse({ on: false });
      }
    }
    return false;
  });
})();

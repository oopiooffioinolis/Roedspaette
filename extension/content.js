/* Rødspætte — in-page capture card + known-words highlighter. Injected on demand. */
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
        .flag { width: 20px; height: auto; flex: none; display: block; }
        .brand { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8a857d; flex: 1; }
        .pills { display: flex; gap: 6px; }
        .pill { font-size: 11px; padding: 3px 9px; border-radius: 99px; border: 1px solid #d8d4cd;
                background: #faf9f7; color: #6b665e; cursor: pointer; }
        .pill[aria-pressed="true"] { background: #C8102E; border-color: #C8102E; color: #fff; }
        .x { border: none; background: none; font-size: 15px; line-height: 1; color: #a09a91; cursor: pointer; padding: 0 2px; flex: none; }
        .x:hover { color: #4d483f; }
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
      <div class="card" role="dialog" aria-label="Save to Rødspætte">
        <div class="top">
          <svg class="flag" viewBox="50 40 430 280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M174.5 150.4L170.9 141.4M174.5 209.6L170.9 218.6M196.2 137L190.4 121.5M196.2 223L190.4 238.5M217.8 124.1L210.6 104.2M217.8 235.9L210.6 255.8M239.5 112.2L231.2 89.2M239.5 247.8L231.2 270.8M261.2 101.9L252.1 76.8M261.2 258.1L252.1 283.2M282.9 93.8L273.4 67.5M282.9 266.2L273.4 292.5M304.5 88.5L294.9 61.8M304.5 271.5L294.9 298.2M326.2 86.5L316.8 60.4M326.2 273.5L316.8 299.6M347.9 88.2L339 63.6M347.9 271.8L339 296.4M369.6 94L361.5 71.8M369.6 266L361.5 288.2M391.2 104L384.3 85.2M391.2 256L384.3 274.8M412.9 118.4L407.7 104.5M412.9 241.6L407.7 255.5M434.6 137.5L431.9 131M434.6 222.5L431.9 229" fill="none" stroke="#C8102E" stroke-width="8" stroke-linecap="round"/><path d="M160.7 157.3L160.9 157.1L161.3 156.4L162 155.3L163 153.9L164.2 152.2L165.8 150.2L167.6 148.1L169.7 145.8L172 143.2L174.6 140.5L177.5 137.6L180.6 134.6L184 131.4L187.6 128.1L191.4 124.6L195.5 121.1L199.7 117.4L204.2 113.7L208.9 109.9L213.7 106L218.7 102.2L223.9 98.3L229.3 94.5L234.8 90.8L240.4 87.1L246.1 83.5L252 80L258 76.7L264 73.6L270.1 70.8L276.3 68.1L282.6 65.8L288.9 63.7L295.2 62L301.5 60.6L307.8 59.5L314.1 58.9L320.4 58.6L326.6 58.6L332.8 59.1L338.9 60L345 61.2L350.9 62.8L356.8 64.7L362.5 67L368.2 69.6L373.7 72.4L379 75.5L384.2 78.9L389.2 82.5L394.1 86.2L398.7 90L403.2 94L407.5 98L411.5 102L415.3 106.1L418.9 110.1L422.3 114L425.4 117.9L428.3 121.6L430.9 125.1L433.3 128.5L435.3 131.7L437.2 134.5L438.7 137.1L440 139.4L441 141.3L441.7 142.7L442.1 143.7L442.2 144M160.7 202.7L160.9 202.9L161.3 203.6L162 204.7L163 206.1L164.2 207.8L165.8 209.8L167.6 211.9L169.7 214.2L172 216.8L174.6 219.5L177.5 222.4L180.6 225.4L184 228.6L187.6 231.9L191.4 235.4L195.5 238.9L199.7 242.6L204.2 246.3L208.9 250.1L213.7 254L218.7 257.8L223.9 261.7L229.3 265.5L234.8 269.2L240.4 272.9L246.1 276.5L252 280L258 283.3L264 286.4L270.1 289.2L276.3 291.9L282.6 294.2L288.9 296.3L295.2 298L301.5 299.4L307.8 300.5L314.1 301.1L320.4 301.4L326.6 301.4L332.8 300.9L338.9 300L345 298.8L350.9 297.2L356.8 295.3L362.5 293L368.2 290.4L373.7 287.6L379 284.5L384.2 281.1L389.2 277.5L394.1 273.8L398.7 270L403.2 266L407.5 262L411.5 258L415.3 253.9L418.9 249.9L422.3 246L425.4 242.1L428.3 238.4L430.9 234.9L433.3 231.5L435.3 228.3L437.2 225.5L438.7 222.9L440 220.6L441 218.7L441.7 217.3L442.1 216.3L442.2 216" fill="none" stroke="#C8102E" stroke-width="6"/><path d="M150 167C126 162 104 152 84 138C70 166 70 194 84 222C104 208 126 198 150 193" fill="none" stroke="#C8102E" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><path d="M150 167L150.1 166.9L150.4 166.8L150.8 166.5L151.5 166.1L152.3 165.6L153.3 165L154.5 164.3L155.9 163.4L157.5 162.5L159.2 161.4L161.1 160.2L163.2 158.9L165.5 157.5L167.9 156L170.5 154.4L173.2 152.7L176.2 150.9L179.2 149L182.4 147L185.8 144.9L189.3 142.7L192.9 140.5L196.7 138.2L200.6 135.8L204.7 133.4L208.8 130.9L213.1 128.4L217.4 125.8L221.9 123.3L226.5 120.7L231.2 118.1L235.9 115.6L240.8 113.1L245.7 110.6L250.7 108.2L255.7 105.8L260.8 103.6L266 101.4L271.2 99.4L276.4 97.5L281.7 95.7L287 94.1L292.3 92.6L297.7 91.4L303 90.3L308.3 89.4L313.7 88.7L319 88.3L324.3 88L329.6 88L334.8 88.2L340 88.6L345.2 89.3L350.3 90.2L355.3 91.2L360.3 92.5L365.2 94L370.1 95.7L374.8 97.5L379.5 99.5L384.1 101.7L388.6 104L392.9 106.5L397.2 109L401.3 111.7L405.4 114.4L409.3 117.2L413.1 120L416.7 122.9L420.2 125.8L423.6 128.6L426.8 131.5L429.8 134.4L432.8 137.2L435.5 139.9L438.1 142.6L440.5 145.2L442.8 147.8L444.9 150.2L446.8 152.5L448.5 154.7L450.1 156.8L451.5 158.8L452.7 160.6L453.7 162.2L454.5 163.6L455.2 164.9L455.6 165.9L455.9 166.6L456 167Q472 180 456 193L455.9 193.4L455.6 194.1L455.2 195.1L454.5 196.4L453.7 197.8L452.7 199.4L451.5 201.2L450.1 203.2L448.5 205.3L446.8 207.5L444.9 209.8L442.8 212.2L440.5 214.8L438.1 217.4L435.5 220.1L432.8 222.8L429.8 225.6L426.8 228.5L423.6 231.4L420.2 234.2L416.7 237.1L413.1 240L409.3 242.8L405.4 245.6L401.3 248.3L397.2 251L392.9 253.5L388.6 256L384.1 258.3L379.5 260.5L374.8 262.5L370.1 264.3L365.2 266L360.3 267.5L355.3 268.8L350.3 269.8L345.2 270.7L340 271.4L334.8 271.8L329.6 272L324.3 272L319 271.7L313.7 271.3L308.3 270.6L303 269.7L297.7 268.6L292.3 267.4L287 265.9L281.7 264.3L276.4 262.5L271.2 260.6L266 258.6L260.8 256.4L255.7 254.2L250.7 251.8L245.7 249.4L240.8 246.9L235.9 244.4L231.2 241.9L226.5 239.3L221.9 236.7L217.4 234.2L213.1 231.6L208.8 229.1L204.7 226.6L200.6 224.2L196.7 221.8L192.9 219.5L189.3 217.3L185.8 215.1L182.4 213L179.2 211L176.2 209.1L173.2 207.3L170.5 205.6L167.9 204L165.5 202.5L163.2 201.1L161.1 199.8L159.2 198.6L157.5 197.5L155.9 196.6L154.5 195.7L153.3 195L152.3 194.4L151.5 193.9L150.8 193.5L150.4 193.2L150.1 193.1L150 193" fill="none" stroke="#C8102E" stroke-width="20" stroke-linejoin="round"/><path d="M394 128Q362 180 392 230M390 176C374 158 354 158 342 170C332 180 318 182 304 182C260 182 214 181 172 180M452 190Q444 197 434 200" fill="none" stroke="#C8102E" stroke-width="10" stroke-linecap="round"/><path d="M214.3 172A15.3 15.3 0 1 0 183.7 172A15.3 15.3 0 1 0 214.3 172ZM238.7 197.8A15.3 15.3 0 1 0 208.1 197.8A15.3 15.3 0 1 0 238.7 197.8ZM266.3 150.8A15.3 15.3 0 1 0 235.7 150.8A15.3 15.3 0 1 0 266.3 150.8ZM287.7 185.8A15.3 15.3 0 1 0 257.1 185.8A15.3 15.3 0 1 0 287.7 185.8ZM306.1 134.2A15.3 15.3 0 1 0 275.5 134.2A15.3 15.3 0 1 0 306.1 134.2ZM324.4 217.1A15.3 15.3 0 1 0 293.8 217.1A15.3 15.3 0 1 0 324.4 217.1ZM339.7 160.8A15.3 15.3 0 1 0 309.1 160.8A15.3 15.3 0 1 0 339.7 160.8ZM367.3 226.3A15.3 15.3 0 1 0 336.7 226.3A15.3 15.3 0 1 0 367.3 226.3ZM379.5 145.3A15.3 15.3 0 1 0 348.9 145.3A15.3 15.3 0 1 0 379.5 145.3ZM404 195.8A15.3 15.3 0 1 0 373.4 195.8A15.3 15.3 0 1 0 404 195.8Z" fill="#C8102E"/><path d="M427.6 150A13.6 13.6 0 1 0 400.4 150A13.6 13.6 0 1 0 427.6 150ZM443.6 173A13.6 13.6 0 1 0 416.4 173A13.6 13.6 0 1 0 443.6 173Z" fill="none" stroke="#C8102E" stroke-width="9"/><path d="M419.4 150A5.4 5.4 0 1 0 408.6 150A5.4 5.4 0 1 0 419.4 150ZM435.4 173A5.4 5.4 0 1 0 424.6 173A5.4 5.4 0 1 0 435.4 173Z" fill="#C8102E"/></svg>
          <div class="brand">Rødspætte</div>
          <div class="pills">
            <button class="pill" data-type="word" aria-pressed="${isWord}">Word</button>
            <button class="pill" data-type="phrase" aria-pressed="${!isWord}">Phrase</button>
          </div>
          <button class="x" id="dv-x" title="Close" aria-label="Close">✕</button>
        </div>
        <label for="dv-term">${isWord ? "Word" : "Phrase"}</label>
        <input class="term" id="dv-term" type="text" value="${esc(text)}">
        <label for="dv-tr">Translation</label>
        <input class="tr" id="dv-tr" type="text" placeholder="translating…">
        <label for="dv-snippet">Context snippet</label>
        <textarea id="dv-snippet">${esc(snippet)}</textarea>
        <div class="row">
          <div>
            <label for="dv-set">Save to set</label>
            <select id="dv-set">${
              sets.length
                ? sets.map((s) => `<option value="${esc(s)}" ${s === active ? "selected" : ""}>${esc(s.replace(/\.xlsx$/i, ""))}</option>`).join("")
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
    $("#dv-x").addEventListener("click", removeCard);

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

  const HL = { on: false, map: null, spans: [], styleEl: null, clickBound: false,
               observer: null, pending: new Set(), flushTimer: null, count: 0 };
  const MAX_SPANS = 8000; // global cap across the whole (possibly infinite-scroll) page
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

  function collectTextNodes(root) {
    const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|SELECT|OPTION|CODE|PRE)$/;
    const ok = (n) => {
      const p = n.parentElement;
      if (!p || skip.test(p.tagName) || p.isContentEditable) return false;
      if (p.closest(".dv-known-word")) return false;
      return /\p{L}/u.test(n.nodeValue);
    };
    if (root && root.nodeType === 3) return ok(root) ? [root] : [];
    const base = root && root.nodeType === 1 ? root : document.body;
    if (!base) return [];
    const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (ok(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function wrapMatches(root) {
    if (HL.count >= MAX_SPANS) return 0;
    const nodes = collectTextNodes(root);
    const re = /\p{L}+/gu;
    let count = 0;
    for (const node of nodes) {
      if (HL.count >= MAX_SPANS) break;
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
        count++;
        if (++HL.count >= MAX_SPANS) break;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.replaceWith(frag);
      }
    }
    return count;
  }

  /* Keep highlighting content that arrives after load (infinite scroll, SPA
     route changes). We disconnect while writing our own spans so we never
     observe — and re-process — our own edits. */
  function startObserver() {
    if (HL.observer || !document.body) return;
    HL.observer = new MutationObserver((muts) => {
      if (!HL.on) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.classList && n.classList.contains("dv-known-word")) continue;
            if (n === HL.styleEl) continue;
            HL.pending.add(n);
          } else if (n.nodeType === 3) {
            HL.pending.add(n);
          }
        }
      }
      if (HL.pending.size) scheduleFlush();
    });
    HL.observer.observe(document.body, { childList: true, subtree: true });
  }
  function scheduleFlush() {
    if (HL.flushTimer) return;
    HL.flushTimer = setTimeout(flushPending, 350);
  }
  function flushPending() {
    HL.flushTimer = null;
    if (!HL.on || !HL.pending.size) { HL.pending.clear(); return; }
    const roots = [...HL.pending];
    HL.pending.clear();
    if (HL.observer) HL.observer.disconnect();
    for (const r of roots) { if (r.isConnected) wrapMatches(r); }
    if (HL.on && HL.observer) HL.observer.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() {
    if (HL.observer) { HL.observer.disconnect(); HL.observer = null; }
    if (HL.flushTimer) { clearTimeout(HL.flushTimer); HL.flushTimer = null; }
    HL.pending.clear();
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
    if (HL.on) return HL.spans.length;
    HL.map = new Map(Object.entries(words || {}));
    HL.count = 0;
    injectHlStyle();
    const count = wrapMatches(document.body);
    HL.on = true;
    startObserver();
    if (!HL.clickBound) {
      document.addEventListener("click", onHlClick, true);
      HL.clickBound = true;
    }
    return count;
  }

  function hlOff() {
    closeTrBox();
    stopObserver();
    for (const s of HL.spans) {
      if (s.isConnected) s.replaceWith(document.createTextNode(s.textContent));
    }
    HL.spans = [];
    HL.on = false;
    HL.count = 0;
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
        .hd { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .x { border: none; background: none; font-size: 15px; line-height: 1; color: #a09a91; cursor: pointer; padding: 0 2px; flex: none; }
        .x:hover { color: #4d483f; }
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
        <div class="hd">
          <div class="word">${esc(span.textContent)}${showsLemma ? `<span class="base">→ ${esc(entry.lemma)}</span>` : showsTerm ? `<span class="base">→ ${esc(entry.term)}</span>` : ""}</div>
          <button class="x" id="dv-hl-x" title="Close" aria-label="Close">✕</button>
        </div>
        <input id="dv-hl-tr" type="text" value="${esc(entry.t || "")}" placeholder="add a translation…">
        <div class="status" id="dv-hl-status"></div>
        <div class="meta"><span>${esc(entry.set)}</span><span>Enter saves · Esc closes</span></div>
      </div>`;
    document.documentElement.appendChild(trBox);

    const input = shadow.querySelector("#dv-hl-tr");
    const status = shadow.querySelector("#dv-hl-status");
    shadow.querySelector("#dv-hl-x").addEventListener("click", closeTrBox);

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

  /* Esc closes whichever popup is open, wherever focus happens to be. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (host) { e.stopPropagation(); removeCard(); }
    else if (trBox) { e.stopPropagation(); closeTrBox(); }
  }, true);

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

  /* When the persistent highlight mode is on, highlight automatically on load. */
  (async () => {
    try {
      const { hlAuto } = await chrome.storage.local.get({ hlAuto: false });
      if (!hlAuto || HL.on) return;
      const r = await chrome.runtime.sendMessage({ type: "DV_GET_HL_WORDS" });
      if (r && r.words && !HL.on) hlOn(r.words);
    } catch (_) {}
  })();
})();

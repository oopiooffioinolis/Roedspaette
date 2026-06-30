/* Dansk Vokab — workbook data layer.
   Runs in the extension service worker (importScripts) and in Node (tests). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("xlsx"));
  } else {
    root.VocabSheets = factory(root.XLSX);
  }
})(typeof self !== "undefined" ? self : this, function (XLSX) {
  "use strict";

  const SCHEMA_VERSION = 3;

  const WORD_HEADERS = [
    "ID", "DateAdded", "Term", "Lemma", "WordClass", "Gender", "Inflections",
    "IPA", "AudioURL", "Definition", "Translation", "Snippet", "SourceTitle",
    "SourceURL", "DeepLink", "Note", "Status", "Candidates", "Due", "Interval", "Ease", "Reps", "Lapses"
  ];
  const PHRASE_HEADERS = [
    "ID", "DateAdded", "Phrase", "Gloss", "Translation", "Snippet",
    "SourceTitle", "SourceURL", "DeepLink", "Note", "Status", "Candidates",
    "Due", "Interval", "Ease", "Reps", "Lapses"
  ];
  // Hidden in Excel: spaced-repetition bookkeeping + the JSON disambiguation blob.
  const HIDDEN = new Set(["Candidates", "Due", "Interval", "Ease", "Reps", "Lapses"]);

  const WIDTHS = {
    ID: 10, DateAdded: 11, Term: 18, Lemma: 14, WordClass: 11, Gender: 8,
    Inflections: 26, IPA: 16, AudioURL: 18, Definition: 36, Phrase: 30,
    Gloss: 36, Translation: 36, Snippet: 50, SourceTitle: 24, SourceURL: 24,
    DeepLink: 24, Note: 18, Status: 10, Candidates: 40, Due: 11, Interval: 9, Ease: 7,
    Reps: 6, Lapses: 7
  };

  function colsFor(headers) {
    return headers.map((h) => ({ wch: WIDTHS[h] || 14, hidden: HIDDEN.has(h) }));
  }

  function sheetFromHeaders(headers) {
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    ws["!cols"] = colsFor(headers);
    return ws;
  }

  function newWorkbook(setName) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFromHeaders(WORD_HEADERS), "Words");
    XLSX.utils.book_append_sheet(wb, sheetFromHeaders(PHRASE_HEADERS), "Phrases");
    const meta = XLSX.utils.aoa_to_sheet([
      ["SchemaVersion", SCHEMA_VERSION],
      ["App", "Dansk Vokab"],
      ["SetName", setName || ""],
      ["Created", new Date().toISOString().slice(0, 10)]
    ]);
    meta["!cols"] = [{ wch: 16 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, meta, "Meta");
    return wb;
  }

  function readWorkbook(b64) {
    // cellStyles makes SheetJS parse !cols, so hidden SRS columns survive saves
    return XLSX.read(b64, { type: "base64", cellStyles: true });
  }

  function writeWorkbook(wb) {
    return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  }

  function rowsOf(ws) {
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  }

  /* Maps a capture entry onto the sheet's own header row, so user-reordered
     or user-extended columns keep working. */
  function entryFields(entry) {
    const today = entry.dateAdded || new Date().toISOString().slice(0, 10);
    const common = {
      ID: entry.id || "",
      DateAdded: today,
      Snippet: entry.snippet || "",
      SourceTitle: entry.sourceTitle || "",
      SourceURL: entry.sourceURL || "",
      DeepLink: entry.deepLink || "",
      Note: entry.note || "",
      Status: entry.status || "pending"
    };
    if (entry.type === "word") {
      return Object.assign(common, {
        Term: entry.term || "",
        Lemma: entry.lemma || "",
        WordClass: entry.wordClass || "",
        Gender: entry.gender || "",
        Inflections: entry.inflections || "",
        IPA: entry.ipa || "",
        AudioURL: entry.audioURL || "",
        Definition: entry.definition || "",
        Translation: entry.translation || ""
      });
    }
    return Object.assign(common, {
      Phrase: entry.term || "",
      Gloss: entry.gloss || "",
      Translation: entry.translation || ""
    });
  }

  /* Appends an entry to its sheet. Returns { duplicate, rowCount, sheet }. */
  function appendEntry(wb, entry) {
    ensureColumns(wb);
    const sheetName = entry.type === "word" ? "Words" : "Phrases";
    const defaults = entry.type === "word" ? WORD_HEADERS : PHRASE_HEADERS;
    let ws = wb.Sheets[sheetName];
    if (!ws) {
      ws = sheetFromHeaders(defaults);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }
    let rows = rowsOf(ws);
    let headers = rows.length ? rows[0].map(String) : [];
    if (!headers.length || headers.every((h) => !h)) {
      XLSX.utils.sheet_add_aoa(ws, [defaults], { origin: 0 });
      headers = defaults.slice();
      rows = rowsOf(ws);
    }
    const keyCol = headers.indexOf(entry.type === "word" ? "Term" : "Phrase");
    const key = (entry.term || "").trim().toLowerCase();
    if (keyCol >= 0 && key) {
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][keyCol] || "").trim().toLowerCase() === key) {
          return { duplicate: true, rowCount: rows.length - 1, sheet: sheetName };
        }
      }
    }
    const fields = entryFields(entry);
    const row = headers.map((h) => (h in fields ? fields[h] : ""));
    XLSX.utils.sheet_add_aoa(ws, [row], { origin: -1 });
    ws["!cols"] = headers.map((h) => ({ wch: WIDTHS[h] || 14, hidden: HIDDEN.has(h) }));
    return { duplicate: false, rowCount: rows.length, sheet: sheetName };
  }

  /* Adds any headers from the current schema that an older file is missing
     (appended at the end; rows map by name, so order never matters). */
  function ensureColumns(wb) {
    let changed = false;
    for (const [name, defaults] of [["Words", WORD_HEADERS], ["Phrases", PHRASE_HEADERS]]) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const rows = rowsOf(ws);
      const headers = rows.length ? rows[0].map(String) : [];
      if (!headers.length || headers.every((h) => !h)) continue;
      const missing = defaults.filter((h) => !headers.includes(h));
      if (missing.length) {
        XLSX.utils.sheet_add_aoa(ws, [missing], { origin: { r: 0, c: headers.length } });
        const all = headers.concat(missing);
        ws["!cols"] = all.map((h) => ({ wch: WIDTHS[h] || 14, hidden: HIDDEN.has(h) }));
        changed = true;
      }
    }
    return changed;
  }

  /* Rows whose Status column equals "pending" (plus "partial" when
     opts.includePartial is set, so a manual pass can retry them). Returns
     [{ sheet, row (0-based aoa index), type, term, id, status, translation }]. */
  function listPending(wb, opts) {
    const statuses = new Set(["pending"]);
    if (opts && opts.includePartial) statuses.add("partial");
    const out = [];
    for (const [name, type, keyHeader] of [["Words", "word", "Term"], ["Phrases", "phrase", "Phrase"]]) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const rows = rowsOf(ws);
      if (!rows.length) continue;
      const headers = rows[0].map(String);
      const statusCol = headers.indexOf("Status");
      const keyCol = headers.indexOf(keyHeader);
      const idCol = headers.indexOf("ID");
      const trCol = headers.indexOf("Translation");
      if (statusCol < 0 || keyCol < 0) continue;
      for (let r = 1; r < rows.length; r++) {
        const status = String(rows[r][statusCol] || "").trim().toLowerCase();
        if (statuses.has(status) && String(rows[r][keyCol] || "").trim()) {
          out.push({
            sheet: name, row: r, type, term: String(rows[r][keyCol]).trim(),
            id: idCol >= 0 ? rows[r][idCol] : "",
            status,
            translation: trCol >= 0 ? String(rows[r][trCol] || "").trim() : ""
          });
        }
      }
    }
    return out;
  }

  /* Rows with Status "choose": ambiguous lookups awaiting a user pick.
     Returns [{ sheet, row, type, term, id, translation, candidates }] where
     candidates is the parsed JSON array stored in the Candidates column. */
  function listChoices(wb) {
    const out = [];
    for (const [name, type, keyHeader] of [["Words", "word", "Term"], ["Phrases", "phrase", "Phrase"]]) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const rows = rowsOf(ws);
      if (!rows.length) continue;
      const headers = rows[0].map(String);
      const statusCol = headers.indexOf("Status");
      const keyCol = headers.indexOf(keyHeader);
      const idCol = headers.indexOf("ID");
      const trCol = headers.indexOf("Translation");
      const candCol = headers.indexOf("Candidates");
      if (statusCol < 0 || keyCol < 0) continue;
      for (let r = 1; r < rows.length; r++) {
        if (String(rows[r][statusCol] || "").trim().toLowerCase() !== "choose") continue;
        if (!String(rows[r][keyCol] || "").trim()) continue;
        let candidates = [];
        if (candCol >= 0) {
          try { candidates = JSON.parse(String(rows[r][candCol] || "[]")); } catch (_) { candidates = []; }
        }
        if (!Array.isArray(candidates)) candidates = [];
        out.push({
          sheet: name, row: r, type, term: String(rows[r][keyCol]).trim(),
          id: idCol >= 0 ? rows[r][idCol] : "",
          translation: trCol >= 0 ? String(rows[r][trCol] || "").trim() : "",
          candidates
        });
      }
    }
    return out;
  }

  /* Writes the given fields into an existing row, mapped by header name. */
  function updateRow(wb, sheetName, rowIndex, fields) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return false;
    const headers = (rowsOf(ws)[0] || []).map(String);
    for (const [key, value] of Object.entries(fields)) {
      const c = headers.indexOf(key);
      if (c < 0 || value === undefined || value === null) continue;
      ws[XLSX.utils.encode_cell({ r: rowIndex, c })] = { t: "s", v: String(value) };
    }
    return true;
  }

  /* All word rows with the fields the highlighter needs. */
  function listWords(wb) {
    const ws = wb.Sheets.Words;
    if (!ws) return [];
    const rows = rowsOf(ws);
    if (rows.length < 2) return [];
    const h = rows[0].map(String);
    const col = (n) => h.indexOf(n);
    const c = { id: col("ID"), term: col("Term"), lemma: col("Lemma"), infl: col("Inflections"), tr: col("Translation") };
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const term = c.term >= 0 ? String(rows[r][c.term] || "").trim() : "";
      if (!term) continue;
      out.push({
        id: c.id >= 0 ? String(rows[r][c.id] || "") : "",
        term,
        lemma: c.lemma >= 0 ? String(rows[r][c.lemma] || "").trim() : "",
        inflections: c.infl >= 0 ? String(rows[r][c.infl] || "").trim() : "",
        translation: c.tr >= 0 ? String(rows[r][c.tr] || "").trim() : ""
      });
    }
    return out;
  }

  /* Locate a row by its ID column and update fields. Returns the row's term or null. */
  function updateRowById(wb, sheetName, id, fields) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !id) return null;
    const rows = rowsOf(ws);
    if (rows.length < 2) return null;
    const h = rows[0].map(String);
    const idCol = h.indexOf("ID");
    if (idCol < 0) return null;
    for (let r = 1; r < rows.length; r++) {
      if (String(rows[r][idCol] || "") === String(id)) {
        updateRow(wb, sheetName, r, fields);
        const keyCol = h.indexOf(sheetName === "Words" ? "Term" : "Phrase");
        return keyCol >= 0 ? String(rows[r][keyCol] || "") : "";
      }
    }
    return null;
  }

  /* Expands a DDO inflection string into concrete lowercase word forms.
     "-en, -e, -ene" on "hund" -> hunden, hunde, hundene; full forms pass through. */
  function expandForms(term, lemma, inflections) {
    const base = (lemma || term || "").trim();
    const forms = new Set();
    const add = (w) => { w = String(w || "").trim().toLowerCase(); if (w && /^[\p{L}]+$/u.test(w)) forms.add(w); };
    add(term);
    add(lemma);
    for (let chunk of String(inflections || "").split(/[,;]|\beller\b|\bel\.\s/iu)) {
      chunk = chunk.trim();
      if (!chunk) continue;
      if (chunk.startsWith("-")) {
        const suffix = chunk.slice(1).trim();
        if (base && /^[\p{L}]*$/u.test(suffix)) add(base + suffix);
      } else {
        add(chunk);
      }
    }
    return Array.from(forms);
  }

  /* Split positions for a possible Danish compound, best-guess order:
     linking-s boundaries (sikkerheds|hændelse), then short first elements
     (bil|værksted, patient|oplysninger), then linking-e (børne|have).
     Returns at most `cap` candidates: [{ i, prefix, suffix }]. */
  function compoundSplits(term, cap) {
    const t = String(term || "").toLowerCase();
    const n = t.length;
    const max = cap || 6;
    if (n < 8 || !/^[\p{L}]+$/u.test(t)) return [];
    const seen = new Set();
    const out = [];
    const add = (i) => {
      if (i < 3 || n - i < 4 || seen.has(i)) return;
      seen.add(i);
      out.push({ i, prefix: t.slice(0, i), suffix: t.slice(i) });
    };
    for (let i = n - 4; i >= 3; i--) if (t[i - 1] === "s") add(i);
    for (const i of [3, 4, 5, 6, 7, 8]) add(i);
    for (let i = n - 4; i >= 3; i--) if (t[i - 1] === "e") add(i);
    return out.slice(0, max);
  }

  /* True when `suffix` is exactly one of the head entry's word forms —
     guards compound resolution against fuzzy dictionary matches. */
  function isFormOf(suffix, headLemma, headInflections) {
    if (!headLemma) return false;
    return expandForms(headLemma, headLemma, headInflections).includes(String(suffix || "").toLowerCase());
  }

  /* patientoplysninger + (oplysning, "-en, -er, -erne") -> patientoplysning.
     Returns "" when the head doesn't verify. */
  function compoundLemma(term, prefix, headLemma, headInflections) {
    const suffix = String(term || "").toLowerCase().slice(String(prefix || "").length);
    if (!isFormOf(suffix, headLemma, headInflections)) return "";
    return String(prefix || "") + headLemma;
  }

  /* Decodes GitHub's base64 file content as proper UTF-8 (æøå-safe). */
  function decodeB64Utf8(b64) {
    const bin = typeof atob !== "undefined"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  /* Turns a phone-inbox payload (JSON object or plain text) into a capture entry.
     Returns null if unusable. */
  function inboxEntry(rawText, id, today) {
    const raw = String(rawText || "").trim();
    if (!raw) return null;
    let data = null;
    if (raw[0] === "{") { try { data = JSON.parse(raw); } catch (_) { data = null; } }
    if (!data || typeof data !== "object") data = { term: raw };
    const cap = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
    const term = cap(data.term || data.text, 200);
    if (!term) return null;
    const set = cap(data.set, 80);
    const date = String(data.date || "");
    return {
      id,
      type: term.split(/\s+/).length === 1 ? "word" : "phrase",
      term,
      snippet: cap(data.snippet, 600),
      sourceTitle: cap(data.sourceTitle, 200),
      sourceURL: cap(data.sourceURL || data.url, 500),
      deepLink: cap(data.deepLink, 500),
      note: cap(data.note, 200),
      set: set ? (/\.xlsx$/i.test(set) ? set : set + ".xlsx") : undefined,
      dateAdded: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : today
    };
  }

  function counts(wb) {
    const n = (name) => {
      const ws = wb.Sheets[name];
      if (!ws) return 0;
      return Math.max(0, rowsOf(ws).length - 1);
    };
    return { words: n("Words"), phrases: n("Phrases") };
  }

  return {
    SCHEMA_VERSION, WORD_HEADERS, PHRASE_HEADERS,
    newWorkbook, readWorkbook, writeWorkbook, appendEntry, counts,
    ensureColumns, listPending, listChoices, updateRow,
    listWords, updateRowById, expandForms,
    compoundSplits, isFormOf, compoundLemma,
    decodeB64Utf8, inboxEntry
  };
});

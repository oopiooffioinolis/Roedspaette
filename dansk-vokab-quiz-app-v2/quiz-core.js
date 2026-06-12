/* Dansk Vokab Quiz — core logic (no DOM). Runs in the browser app and in Node tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("xlsx"));
  else root.QuizCore = factory(root.XLSX);
})(typeof self !== "undefined" ? self : this, function (XLSX) {
  "use strict";

  const SRS = ["Due", "Interval", "Ease", "Reps", "Lapses"];

  const rowsOf = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const read = (b64) => XLSX.read(b64, { type: "base64", cellStyles: true });
  const write = (wb) => XLSX.write(wb, { type: "base64", bookType: "xlsx" });

  function todayStr(d) {
    return (d || new Date()).toISOString().slice(0, 10);
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /* ---------- cards out of a workbook ---------- */

  function sheetCards(ws, type) {
    if (!ws) return [];
    const rows = rowsOf(ws);
    if (rows.length < 2) return [];
    const h = rows[0].map(String);
    const c = (n) => h.indexOf(n);
    const key = c(type === "word" ? "Term" : "Phrase");
    const cols = {
      id: c("ID"), tr: c("Translation"), gloss: c("Gloss"), ipa: c("IPA"),
      wc: c("WordClass"), g: c("Gender"), infl: c("Inflections"), def: c("Definition"),
      audio: c("AudioURL"), snip: c("Snippet"), note: c("Note"), src: c("SourceURL"),
      due: c("Due"), int: c("Interval"), ease: c("Ease"), reps: c("Reps"), lap: c("Lapses")
    };
    const v = (row, i) => (i >= 0 ? String(row[i] || "").trim() : "");
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const term = v(row, key);
      if (!term) continue;
      out.push({
        id: v(row, cols.id), type, term,
        translation: v(row, cols.tr), gloss: v(row, cols.gloss), ipa: v(row, cols.ipa),
        wordClass: v(row, cols.wc), gender: v(row, cols.g), inflections: v(row, cols.infl),
        definition: v(row, cols.def), audio: v(row, cols.audio), snippet: v(row, cols.snip),
        note: v(row, cols.note),
        due: v(row, cols.due),
        interval: parseFloat(v(row, cols.int)) || 0,
        ease: parseFloat(v(row, cols.ease)) || 0,
        reps: parseInt(v(row, cols.reps)) || 0,
        lapses: parseInt(v(row, cols.lap)) || 0
      });
    }
    return out;
  }

  function parseCards(b64) {
    const wb = read(b64);
    return sheetCards(wb.Sheets.Words, "word").concat(sheetCards(wb.Sheets.Phrases, "phrase"));
  }

  /* ---------- SM-2 (Anki-style) scheduler ---------- */
  /* grade: "again" | "hard" | "good" | "easy". Returns the new SRS fields. */

  function schedule(card, grade, today) {
    today = today || todayStr();
    let ease = card.ease || 2.5;
    let interval = card.interval || 0;
    let reps = card.reps || 0;
    let lapses = card.lapses || 0;

    if (grade === "again") {
      if (reps > 0) lapses++;
      reps = 0;
      interval = 0;
      ease = Math.max(1.3, ease - 0.2);
      return { due: today, interval, ease: round2(ease), reps, lapses };
    }
    if (grade === "hard") {
      ease = Math.max(1.3, ease - 0.15);
      interval = interval < 1 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
    } else if (grade === "good") {
      interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.max(interval + 1, Math.round(interval * ease));
    } else { // easy
      ease = ease + 0.15;
      interval = reps === 0 ? 3 : reps === 1 ? 8 : Math.max(interval + 2, Math.round(interval * ease * 1.3));
    }
    reps++;
    interval = Math.min(interval, 730);
    return { due: addDays(today, interval), interval, ease: round2(ease), reps, lapses };
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  /* Preview text like "6d" / "3mo" for grade buttons. */
  function intervalPreview(card, grade, today) {
    const s = schedule(card, grade, today);
    const d = s.interval;
    if (grade === "again" || d < 1) return "now";
    if (d < 30) return d + "d";
    if (d < 365) return Math.round(d / 30) + "mo";
    return (d / 365).toFixed(1) + "y";
  }

  /* ---------- session queue ---------- */

  function buildQueue(cards, opts) {
    const o = Object.assign({ newLimit: 10, today: todayStr(), reverse: false, shuffle: true }, opts || {});
    let pool = cards.filter((c) => c.id);
    if (o.reverse) pool = pool.filter((c) => c.translation);
    const due = pool.filter((c) => c.due && c.due <= o.today).sort((a, b) => (a.due < b.due ? -1 : 1));
    const fresh = pool.filter((c) => !c.due).slice(0, o.newLimit);
    const q = due.concat(fresh);
    if (o.shuffle) {
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q[i], q[j]] = [q[j], q[i]];
      }
    }
    return { queue: q, dueCount: due.length, newCount: fresh.length };
  }

  function deckCounts(cards, today) {
    today = today || todayStr();
    const withId = cards.filter((c) => c.id);
    return {
      total: withId.length,
      due: withId.filter((c) => c.due && c.due <= today).length,
      fresh: withId.filter((c) => !c.due).length
    };
  }

  /* ---------- progress write-back ---------- */

  function ensureSrsColumns(ws) {
    const rows = rowsOf(ws);
    if (!rows.length) return null;
    let h = rows[0].map(String);
    const missing = SRS.filter((n) => !h.includes(n));
    if (missing.length) {
      XLSX.utils.sheet_add_aoa(ws, [missing], { origin: { r: 0, c: h.length } });
      h = h.concat(missing);
    }
    return h;
  }

  /* updates: { [cardId]: {due, interval, ease, reps, lapses} }.
     Returns { b64, applied } — applied lists the ids actually written. */
  function applyProgress(b64, updates) {
    const wb = read(b64);
    const applied = [];
    for (const name of ["Words", "Phrases"]) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const h = ensureSrsColumns(ws);
      if (!h) continue;
      const idCol = h.indexOf("ID");
      if (idCol < 0) continue;
      const rows = rowsOf(ws);
      const col = Object.fromEntries(SRS.map((n) => [n, h.indexOf(n)]));
      for (let r = 1; r < rows.length; r++) {
        const id = String(rows[r][idCol] || "");
        const u = id && updates[id];
        if (!u) continue;
        const put = (c, val) => { ws[XLSX.utils.encode_cell({ r, c })] = { t: "s", v: String(val) }; };
        put(col.Due, u.due);
        put(col.Interval, u.interval);
        put(col.Ease, u.ease);
        put(col.Reps, u.reps);
        put(col.Lapses, u.lapses);
        applied.push(id);
      }
    }
    return { b64: write(wb), applied };
  }

  return { todayStr, addDays, parseCards, schedule, intervalPreview, buildQueue, deckCounts, applyProgress };
});

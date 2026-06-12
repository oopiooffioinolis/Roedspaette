/* Dansk Vokab — ordnet.dk (Den Danske Ordbog) page parser.
   Strategy: prefer stable text labels ("Bøjning", "Udtale") over CSS classes,
   with legacy-selector fast paths, so redesigns degrade gracefully. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DdoParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const WORD_CLASSES = [
    "substantiv", "verbum", "adjektiv", "adverbium", "pronomen", "præposition",
    "konjunktion", "udråbsord", "interjektion", "talord", "lydord", "proprium",
    "forkortelse", "suffiks", "præfiks"
  ];

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  function genderFrom(text) {
    const t = text.toLowerCase();
    const fk = t.includes("fælleskøn");
    const ik = t.includes("intetkøn");
    if (fk && ik) return "en/et";
    if (fk) return "en";
    if (ik) return "et";
    return "";
  }

  /* Text that follows a short label element like "Bøjning" within its section. */
  function textAfterLabel(doc, label) {
    const all = doc.querySelectorAll("span, div, h2, h3, h4, dt, b, strong, td, th, p, a");
    for (const el of all) {
      if (clean(el.textContent).toLowerCase().replace(/[:：]\s*$/, "") !== label) continue;
      // 1) following siblings inside the same parent
      let sib = el.nextElementSibling;
      const parts = [];
      while (sib) { parts.push(clean(sib.textContent)); sib = sib.nextElementSibling; }
      const joined = clean(parts.join(" "));
      if (joined) return { text: joined, scope: el.parentElement };
      // 2) parent text minus the label (label + content share a wrapper)
      const parent = el.parentElement;
      if (parent) {
        const rest = clean(parent.textContent).replace(new RegExp("^" + label, "i"), "");
        if (clean(rest)) return { text: clean(rest), scope: parent };
        // 3) dt/dd or header followed by content block
        let after = parent.nextElementSibling;
        if (after && clean(after.textContent)) return { text: clean(after.textContent), scope: after };
      }
      return null;
    }
    return null;
  }

  function firstAudio(scopeEl, doc, baseUrl) {
    const scopes = [scopeEl, doc].filter(Boolean);
    for (const scope of scopes) {
      const a = scope.querySelector && (
        scope.querySelector('a[href$=".mp3"], a[href*=".mp3?"]') ||
        scope.querySelector("audio source[src], audio[src]")
      );
      if (a) {
        const href = a.getAttribute("href") || a.getAttribute("src");
        if (href) {
          try { return new URL(href, baseUrl).href; } catch (_) { return href; }
        }
      }
    }
    return "";
  }

  /* Detects a search-results page and returns the first entry link to follow. */
  function followLink(doc, baseUrl) {
    const candidates = doc.querySelectorAll(
      '.searchResultBox a[href*="ddo"], .search-results a[href*="ddo"], li a[href*="ordbog?"], a[href*="select="]'
    );
    for (const a of candidates) {
      const href = a.getAttribute("href");
      if (!href) continue;
      try { return new URL(href, baseUrl).href; } catch (_) {}
    }
    return "";
  }

  /* First short element whose own text matches the regex (avoids the
     textContent-concatenation trap where adjacent blocks join without spaces). */
  function findShortElementText(doc, rx, maxLen) {
    const els = doc.querySelectorAll("span, p, div, em, i, b, strong, h2, h3, h4, dd, td, a, li");
    for (const el of els) {
      const t = clean(el.textContent);
      if (t && t.length <= (maxLen || 80) && rx.test(t)) return t;
    }
    return "";
  }

  function parse(html, baseUrl, DOMParserCtor) {
    const Parser = DOMParserCtor || (typeof DOMParser !== "undefined" ? DOMParser : null);
    if (!Parser) throw new Error("DOMParser unavailable");
    const doc = new Parser().parseFromString(html, "text/html");
    const pageText = clean(doc.body ? doc.body.textContent : "");

    if (/der blev ikke fundet|ingen resultater|gav ikke noget resultat/i.test(pageText)) {
      return { found: false, notFound: true };
    }

    const out = { found: false, lemma: "", wordClass: "", gender: "", inflections: "", ipa: "", audioURL: "", definition: "" };

    // Lemma / headword: legacy ".match", new designs typically use a top heading
    const headEl = doc.querySelector(".match") || doc.querySelector(".artikel h1, article h1, h1");
    if (headEl) out.lemma = clean(headEl.textContent).replace(/[0-9¹²³⁴⁵]+$/, "").trim();

    // Word class + gender: legacy span fast path, else scan short elements
    const wcRx = new RegExp("\\b(" + WORD_CLASSES.join("|") + ")\\b", "i");
    let wcText = "";
    const legacyWc = doc.querySelector(".tekstmedium");
    if (legacyWc && wcRx.test(clean(legacyWc.textContent))) {
      wcText = clean(legacyWc.textContent);
    } else {
      wcText = findShortElementText(doc, wcRx, 80);
    }
    if (wcText) {
      const wc = WORD_CLASSES.find((w) => wcText.toLowerCase().includes(w));
      out.wordClass = wc || "";
      out.gender = genderFrom(wcText);
    }
    if (!out.gender) {
      const gText = findShortElementText(doc, /fælleskøn|intetkøn/i, 80);
      if (gText) out.gender = genderFrom(gText);
    }

    // Inflections: legacy #id-boj, else label "bøjning"
    const bojEl = doc.querySelector("#id-boj");
    if (bojEl) {
      out.inflections = clean(bojEl.textContent).replace(/^Bøjning/i, "").trim();
    } else {
      const r = textAfterLabel(doc, "bøjning");
      if (r) out.inflections = r.text;
    }
    out.inflections = out.inflections.replace(/\s*Rapportér.*$/i, "").slice(0, 200);

    // Pronunciation: legacy .lydskrift / #id-udt, else label "udtale", IPA = [...] chunk
    let udtScope = doc.querySelector("#id-udt");
    let udtText = udtScope ? clean(udtScope.textContent) : "";
    if (!udtText) {
      const r = textAfterLabel(doc, "udtale");
      if (r) { udtText = r.text; udtScope = r.scope; }
    }
    const lyd = doc.querySelector(".lydskrift");
    const ipaSource = lyd ? clean(lyd.textContent) : udtText;
    const ipaMatch = ipaSource.match(/\[[^\][]{1,60}\]/);
    if (ipaMatch) out.ipa = ipaMatch[0];
    out.audioURL = firstAudio(udtScope, doc, baseUrl);

    // First definition: legacy .definition, else label "betydninger"
    const defEl = doc.querySelector(".definition");
    if (defEl) out.definition = clean(defEl.textContent);
    else {
      const r = textAfterLabel(doc, "betydninger");
      if (r) out.definition = r.text;
    }
    out.definition = out.definition.slice(0, 250);

    out.found = !!(out.inflections || out.ipa || out.wordClass || out.definition);
    if (!out.found) {
      const next = followLink(doc, baseUrl);
      if (next) return { found: false, needsFollow: next };
    }
    return out;
  }

  return { parse };
});

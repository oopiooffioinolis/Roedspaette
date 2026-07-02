/* Rødspætte — ordnet.dk (Den Danske Ordbog) page parser.
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

  /* Redesigned site: a .modern-label ("Bøjning", "Udtale") sits in a wrapper
     whose text is "LabelValue…". Returns the wrapper text minus the label. */
  function labelValue(doc, label) {
    const lab = [...doc.querySelectorAll(".modern-label")]
      .find((e) => new RegExp("^" + label, "i").test(clean(e.textContent)));
    if (!lab) return "";
    const next = lab.nextElementSibling ? clean(lab.nextElementSibling.textContent) : "";
    if (next) return next;
    const parent = lab.parentElement;
    if (parent) return clean(parent.textContent).replace(new RegExp("^\\s*" + label, "i"), "").trim();
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
      '.searchResultBox a[href*="ddo"], .search-results a[href*="ddo"], li a[href*="ordbog?"], a[href*="select="], a[href*="/ddo/ordbog/"]'
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

  /* Collects every distinct headword sense on the page (homographs like
     ram1/ram2/ram3/ramme2), each with its own grammar + definition. Idioms and
     phrases (no word class) are skipped. Used to detect ambiguity and to offer
     the user a choice. */
  function collectCandidates(doc, WORD_CLASSES) {
    const wcRx = new RegExp("\\b(" + WORD_CLASSES.join("|") + ")\\b", "i");
    const out = [];
    const seen = new Set();
    for (const mm of doc.querySelectorAll(".modern-match")) {
      const rawLemma = clean(mm.textContent);
      const lemma = rawLemma.replace(/[0-9¹²³⁴⁵]+$/, "").trim();
      if (!lemma) continue;
      const wcLine = mm.parentElement ? clean(mm.parentElement.textContent) : "";
      if (!wcRx.test(wcLine)) continue; // skip idioms / multiword entries
      // climb to the article container that also holds this sense's definition
      let cont = mm;
      for (let i = 0; i < 8 && cont.parentElement; i++) {
        cont = cont.parentElement;
        if (cont.querySelector && cont.querySelector(".modern-definition")) break;
      }
      const defEl = cont.querySelector ? cont.querySelector(".modern-definition") : null;
      let definition = defEl ? clean(defEl.textContent) : "";
      const dCut = definition.search(/Ord i nærheden|Eksempler\b|grammatik\b|Synonym(er)?\b|Se også\b/);
      if (dCut > 0) definition = definition.slice(0, dCut);
      definition = clean(definition).slice(0, 160);
      const wc = WORD_CLASSES.find((w) => wcLine.toLowerCase().includes(w)) || "";
      const gender = /fælleskøn/i.test(wcLine) ? (/intetkøn/i.test(wcLine) ? "en/et" : "en")
        : (/intetkøn/i.test(wcLine) ? "et" : "");
      // inflection for this sense, if its container exposes a Bøjning label
      let inflections = "";
      if (cont.querySelector) {
        const lab = [...cont.querySelectorAll(".modern-label")].find((e) => /^bøjning/i.test(clean(e.textContent)));
        if (lab && lab.parentElement) {
          inflections = clean(lab.parentElement.textContent)
            .replace(/^\s*Bøjning/i, "").replace(/\s*Bøjningsform(er)?.*$/i, "").trim().slice(0, 80);
        }
      }
      const key = lemma + "|" + wc;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ lemma, rawLemma, wordClass: wc, gender, inflections, definition });
    }
    return out;
  }

  function parse(html, baseUrl, DOMParserCtor) {
    const Parser = DOMParserCtor || (typeof DOMParser !== "undefined" ? DOMParser : null);
    if (!Parser) throw new Error("DOMParser unavailable");
    const doc = new Parser().parseFromString(html, "text/html");
    const pageText = clean(doc.body ? doc.body.textContent : "");

    if (/der blev ikke fundet|ingen resultater|gav ikke noget resultat|matcher ingen opslag/i.test(pageText)) {
      return { found: false, notFound: true };
    }

    // Multiple distinct headword senses on one page (ram1/ram2/ram3/ramme2…) —
    // don't silently pick the first; hand the choices back so the user decides.
    const candidates = collectCandidates(doc, WORD_CLASSES);
    if (candidates.length >= 2) {
      return { found: false, ambiguous: true, candidates };
    }

    const out = { found: false, lemma: "", wordClass: "", gender: "", inflections: "", ipa: "", audioURL: "", definition: "" };

    // The word we asked for, recovered from the URL — used to sanity-check
    // headword candidates (the redesign's first <h1> can be site chrome).
    let queried = "";
    try {
      const u = new URL(baseUrl);
      queried = decodeURIComponent(u.searchParams.get("query") || (u.pathname.match(/\/ordbog\/([^/?#]+)/) || [])[1] || "");
    } catch (_) {}
    // the live site sometimes serves a double-encoded path (afsl%25C3%25B8ring)
    try { if (/%[0-9A-Fa-f]{2}/.test(queried)) queried = decodeURIComponent(queried); } catch (_) {}
    queried = clean(queried).toLowerCase();
    const plausibleLemma = (s) => {
      s = clean(s);
      if (!s || s.length > 40 || s.split(/\s+/).length > 3) return "";
      const w = s.toLowerCase().replace(/[0-9¹²³⁴⁵]+$/, "").trim();
      if (!queried) return w;
      return w && (queried.startsWith(w.slice(0, 3)) || w.startsWith(queried.slice(0, 3))) ? w : "";
    };

    // Lemma / headword. Redesigned site: .modern-match. Legacy: .match. Then headings.
    const headEl = doc.querySelector(".modern-match") || doc.querySelector(".match")
      || doc.querySelector(".artikel h1, article h1, h1");
    if (headEl) out.lemma = plausibleLemma(headEl.textContent);
    if (!out.lemma) {
      for (const el of doc.querySelectorAll("h1, h2, .headword, [class*='headword'], [class*='opslagsord']")) {
        const w = plausibleLemma(el.textContent);
        if (w) { out.lemma = w; break; }
      }
    }

    // Word class + gender. Redesign: the .modern-match parent reads
    // "oplysning substantiv, fælleskøn". Legacy: .tekstmedium. Else scan.
    const wcRx = new RegExp("\\b(" + WORD_CLASSES.join("|") + ")\\b", "i");
    let wcText = "";
    const modernWcEl = doc.querySelector(".modern-match");
    if (modernWcEl && modernWcEl.parentElement && wcRx.test(clean(modernWcEl.parentElement.textContent))) {
      wcText = clean(modernWcEl.parentElement.textContent).slice(0, 80);
    }
    if (!wcText) {
      const legacyWc = doc.querySelector(".tekstmedium");
      if (legacyWc && wcRx.test(clean(legacyWc.textContent))) wcText = clean(legacyWc.textContent);
    }
    if (!wcText) wcText = findShortElementText(doc, wcRx, 80);
    if (wcText) {
      const wc = WORD_CLASSES.find((w) => wcText.toLowerCase().includes(w));
      out.wordClass = wc || "";
      out.gender = genderFrom(wcText);
    }
    if (!out.gender) {
      const gText = findShortElementText(doc, /fælleskøn|intetkøn/i, 80);
      if (gText) out.gender = genderFrom(gText);
    }

    // Inflections. Redesign: .modern-label "Bøjning" sits in a wrapper whose
    // text is "Bøjning-en, -er, -erneBøjningsformer…". Legacy: #id-boj. Then label scan.
    const modernBoj = labelValue(doc, "Bøjning");
    const bojEl = doc.querySelector("#id-boj");
    if (modernBoj) {
      out.inflections = modernBoj;
    } else if (bojEl) {
      out.inflections = clean(bojEl.textContent).replace(/^Bøjning/i, "").trim();
    } else {
      const r = textAfterLabel(doc, "bøjning");
      if (r) out.inflections = r.text;
    }
    out.inflections = out.inflections
      .replace(/^Bøjning/i, "")
      .replace(/\s*Rapportér.*$/i, "")
      .replace(/\s*Bøjningsform(er)?.*$/i, "")
      .trim()
      .slice(0, 200);

    // Pronunciation. Redesign: .modern-label "Udtale" wrapper, IPA = first [...].
    // Legacy: .lydskrift / #id-udt. The pronunciation guide table is glued on,
    // so we only take the first bracketed chunk.
    const modernUdt = labelValue(doc, "Udtale");
    let udtScope = doc.querySelector("#id-udt");
    let udtText = udtScope ? clean(udtScope.textContent) : "";
    if (!udtText) {
      const r = textAfterLabel(doc, "udtale");
      if (r) { udtText = r.text; udtScope = r.scope; }
    }
    const lyd = doc.querySelector(".lydskrift");
    const ipaSource = modernUdt || (lyd ? clean(lyd.textContent) : udtText);
    const ipaMatch = ipaSource.match(/\[[^\][]{1,60}\]/);
    if (ipaMatch) out.ipa = ipaMatch[0];

    // Audio: the mp3 is in the raw HTML (player loads it via JS, not an <a href>),
    // so a direct scan of the markup is the reliable extraction. Fall back to <a>.
    const mp3 = html.match(/https?:\/\/static\.ordnet\.dk\/mp3\/[^\s"'<>\\)]+\.mp3/);
    out.audioURL = mp3 ? mp3[0] : firstAudio(udtScope, doc, baseUrl);

    // Definition. Redesign: .modern-definition holds clean text. Legacy: .definition.
    // Else label "betydninger" (which glues sidebar widgets on — strip them).
    const modernDef = doc.querySelector(".modern-definition");
    const defEl = doc.querySelector(".definition");
    if (modernDef) {
      out.definition = clean(modernDef.textContent);
    } else if (defEl) {
      out.definition = clean(defEl.textContent);
    } else {
      const r = textAfterLabel(doc, "betydninger");
      if (r) out.definition = r.text;
    }
    out.definition = out.definition.replace(/\s*Henter \.\.\./g, " ");
    const defCut = out.definition.search(/Ord i nærheden|Eksempler\b|grammatik\b|Synonym(er)?\b|Se også\b|Rapportér|Bøjningsform/);
    if (defCut > 0) out.definition = out.definition.slice(0, defCut);
    out.definition = clean(out.definition).slice(0, 250);

    out.found = !!(out.inflections || out.ipa || out.wordClass || out.definition);
    if (!out.found) {
      const next = followLink(doc, baseUrl);
      if (next) return { found: false, needsFollow: next };
    }
    return out;
  }

  return { parse };
});

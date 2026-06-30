/* Dansk Vokab — offscreen worker: HTML parsing + on-device translation. */
"use strict";

const translators = new Map(); // "da>en" -> translator instance
const wordCache = new Map();   // "da>en:hund" -> "dog"

function api() {
  if (typeof Translator !== "undefined" && Translator.create) {
    return {
      availability: (o) => Translator.availability(o),
      create: (o) => Translator.create(o)
    };
  }
  if (typeof self.translation !== "undefined" && self.translation.createTranslator) {
    // Older Chrome shape
    return {
      availability: (o) => self.translation.canTranslate(o),
      create: (o) => self.translation.createTranslator(o)
    };
  }
  return null;
}

async function getTranslator(source, target) {
  const key = `${source}>${target}`;
  if (translators.has(key)) return translators.get(key);
  const t = api();
  if (!t) return { error: "unsupported" };
  try {
    const status = await t.availability({ sourceLanguage: source, targetLanguage: target });
    if (status === "unavailable" || status === "no") return { error: "unsupported" };
    const tr = await t.create({ sourceLanguage: source, targetLanguage: target });
    translators.set(key, tr);
    return tr;
  } catch (e) {
    // Most commonly: language pack download requires a user gesture
    if (e && (e.name === "NotAllowedError" || /user (gesture|activation)/i.test(e.message || ""))) {
      return { error: "needs-setup" };
    }
    return { error: "unsupported", detail: e && e.message };
  }
}

async function translateTexts(texts, source, target) {
  const tr = await getTranslator(source, target);
  if (tr.error) return { error: tr.error, detail: tr.detail };
  const out = [];
  for (const text of texts) {
    const ck = `${source}>${target}:${text}`;
    if (wordCache.has(ck)) { out.push(wordCache.get(ck)); continue; }
    try {
      const res = (await tr.translate(text)).trim();
      wordCache.set(ck, res);
      out.push(res);
    } catch (_) {
      out.push("");
    }
  }
  return { translations: out };
}

async function checkAvailability(source, target) {
  const t = api();
  if (!t) return { status: "unsupported" };
  try {
    return { status: await t.availability({ sourceLanguage: source, targetLanguage: target }) };
  } catch (e) {
    return { status: "unsupported", detail: e && e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  (async () => {
    switch (msg.op) {
      case "parseDdo":
        try { return DdoParser.parse(msg.html, msg.baseUrl); }
        catch (e) { return { found: false, error: e.message }; }
      case "translate":
        return translateTexts(msg.texts || [], msg.source || "da", msg.targetLang || "en");
      case "availability":
        return checkAvailability(msg.source || "da", msg.targetLang || "en");
      default:
        return { error: "unknown-op" };
    }
  })().then(sendResponse);
  return true;
});

const $ = (id) => document.getElementById(id);

function current() {
  return {
    token: $("token").value.trim(),
    owner: $("owner").value.trim(),
    repo: $("repo").value.trim(),
    folder: ($("folder").value.trim() || "sets").replace(/^\/+|\/+$/g, ""),
    targetLang: ($("targetLang").value.trim() || "en").toLowerCase()
  };
}

function say(text, cls) { const s = $("status"); s.textContent = text || ""; s.className = cls || ""; }
function trSay(text) { $("trStatus").textContent = "Status: " + text; }

chrome.storage.local.get({ cfg: { token: "", owner: "", repo: "", folder: "sets", targetLang: "en" } }).then(({ cfg }) => {
  $("token").value = cfg.token; $("owner").value = cfg.owner;
  $("repo").value = cfg.repo; $("folder").value = cfg.folder || "sets";
  $("targetLang").value = cfg.targetLang || "en";
  checkTranslator(false);
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ cfg: current() });
  say("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  say("Testing…");
  await chrome.storage.local.set({ cfg: current() });
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: "DV_TEST_CONN", cfg: current() });
  } catch (e) {
    say("Background worker unreachable: " + (e.message || e) + " — try reloading the extension on chrome://extensions.", "bad");
    return;
  }
  if (!r) { say("Background worker didn't reply — check chrome://extensions → Rødspætte → Errors, then reload the extension.", "bad"); return; }
  if (r.error) say(r.error, "bad");
  else say(r.note, "ok");
});

/* ---- built-in translator setup (runs here because downloads need a user click) ---- */

function translatorApi() {
  if (typeof Translator !== "undefined" && Translator.create) {
    return { availability: (o) => Translator.availability(o), create: (o) => Translator.create(o) };
  }
  if (typeof self.translation !== "undefined" && self.translation.createTranslator) {
    return { availability: (o) => self.translation.canTranslate(o), create: (o) => self.translation.createTranslator(o) };
  }
  return null;
}

async function checkTranslator(verbose) {
  const t = translatorApi();
  if (!t) {
    trSay("this Chrome doesn't expose the built-in Translator API (needs Chrome 138+ on desktop). Phrases will stay 'pending' until available.");
    return null;
  }
  const target = ($("targetLang").value.trim() || "en").toLowerCase();
  try {
    const status = await t.availability({ sourceLanguage: "da", targetLanguage: target });
    if (status === "available" || status === "readily") trSay(`ready — da → ${target} ✓`);
    else if (status === "downloadable" || status === "after-download") trSay(`da → ${target} is supported but the language pack isn't downloaded yet. Click the button to download it.`);
    else if (status === "downloading") trSay("language pack is downloading…");
    else trSay(`da → ${target} is not supported by the on-device translator. Try "en", or entries stay 'pending'.`);
    return status;
  } catch (e) {
    if (verbose) trSay("check failed: " + (e.message || e));
    return null;
  }
}

$("targetLang").addEventListener("change", () => checkTranslator(false));

$("enableTr").addEventListener("click", async () => {
  await chrome.storage.local.set({ cfg: current() });
  const t = translatorApi();
  if (!t) { checkTranslator(true); return; }
  const target = current().targetLang;
  trSay("preparing…");
  try {
    const tr = await t.create({
      sourceLanguage: "da",
      targetLanguage: target,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const pct = e.total ? Math.round((e.loaded / e.total) * 100) : Math.round((e.loaded || 0) * 100);
          trSay(`downloading language pack… ${pct}%`);
        });
      }
    });
    const sample = await tr.translate("Jeg lærer dansk hver dag.");
    trSay(`ready ✓ — test: "Jeg lærer dansk hver dag." → "${sample}"`);
    await chrome.storage.local.set({ translatorReady: true });
  } catch (e) {
    trSay("couldn't enable: " + (e.message || e.name || e));
  }
});

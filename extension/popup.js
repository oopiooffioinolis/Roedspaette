const send = (msg) => chrome.runtime.sendMessage(msg);
const $ = (id) => document.getElementById(id);

function say(text, cls) { const m = $("msg"); m.textContent = text || ""; m.className = cls || ""; }

function fillSets(sets, active) {
  const sel = $("set");
  sel.innerHTML = "";
  for (const s of sets) {
    const o = document.createElement("option");
    o.textContent = s;
    o.selected = s === active;
    sel.appendChild(o);
  }
  if (!sets.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "(no sets yet — create one below)";
    sel.appendChild(o);
  }
}

async function refresh(remote) {
  const st = await send({ type: "DV_GET_STATE" });
  $("setup").style.display = st.configured ? "none" : "block";
  $("ready").style.display = st.configured ? "grid" : "none";
  $("openRepo").href = st.owner && st.repo ? `https://github.com/${st.owner}/${st.repo}` : "https://github.com";
  if (!st.configured) { $("dot").className = "dot"; return; }

  if (remote) {
    say("Checking GitHub…");
    const r = await send({ type: "DV_REFRESH_SETS" });
    if (r.error) { $("dot").className = "dot bad"; say("Couldn't reach the repo — check Options.", "bad"); fillSets(st.sets, st.activeSet); }
    else { $("dot").className = "dot ok"; say(""); fillSets(r.sets, r.activeSet); }
  } else {
    fillSets(st.sets, st.activeSet);
  }

  const q = $("queue");
  if (st.queue > 0) {
    q.style.display = "block";
    $("queueText").textContent = `${st.queue} capture${st.queue > 1 ? "s" : ""} waiting to upload.`;
  } else q.style.display = "none";

  if (st.lastSaved) {
    const t = new Date(st.lastSaved.at);
    $("last").textContent = `Last saved: “${st.lastSaved.term}” → ${st.lastSaved.set} at ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
  }
  loadChoices();
  send({ type: "DV_GET_AUTO_HL" }).then((a) => paintHl(a && a.auto)).catch(() => {});
}

/* ---------- disambiguation (pick a sense) ---------- */
let choices = [];   // [{set, id, term, translation, candidates:[{lemma,wordClass,gender,definition,hint,inflections}]}]
let chIdx = 0, chSel = 0;

async function loadChoices() {
  const r = await send({ type: "DV_LIST_CHOICES" }).catch(() => null);
  choices = (r && r.choices) || [];
  const bar = $("choosebar");
  if (choices.length) {
    bar.style.display = "flex";
    $("chooseText").textContent = `${choices.length} word${choices.length > 1 ? "s" : ""} need${choices.length > 1 ? "" : "s"} a sense picked.`;
  } else {
    bar.style.display = "none";
    $("chooser").style.display = "none";
  }
}

function renderChooser() {
  if (chIdx >= choices.length) { $("chooser").style.display = "none"; loadChoices(); return; }
  const c = choices[chIdx];
  chSel = 0;
  $("chooser").style.display = "block";
  $("chWord").textContent = `${c.term} — ${c.set.replace(/\.xlsx$/i, "")}`;
  const box = $("chCands");
  box.innerHTML = "";
  c.candidates.forEach((cand, i) => {
    const el = document.createElement("div");
    el.className = "cand" + (i === 0 ? " sel" : "");
    el.innerHTML = `<div class="pos">${esc((cand.wordClass || "—") + (cand.gender ? " · " + cand.gender : ""))}</div>
      <div class="da">${esc(cand.definition || cand.lemma || "")}</div>
      ${cand.hint ? `<div class="en">≈ ${esc(cand.hint)}</div>` : ""}`;
    el.addEventListener("click", () => {
      chSel = i;
      [...box.children].forEach((x, j) => x.classList.toggle("sel", j === i));
      // prefill the translation field with this sense's English hint
      if (choices[chIdx].candidates[i].hint) $("chTr").value = choices[chIdx].candidates[i].hint;
    });
    box.appendChild(el);
  });
  // default translation: existing one, else first sense's hint
  $("chTr").value = c.translation || (c.candidates[0] && c.candidates[0].hint) || "";
  $("chMsg").textContent = `${chIdx + 1} of ${choices.length}`;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }

$("openChooser").addEventListener("click", () => { chIdx = 0; renderChooser(); });
$("chSkip").addEventListener("click", () => { chIdx++; renderChooser(); });
$("chSave").addEventListener("click", async () => {
  const c = choices[chIdx];
  const cand = c.candidates[chSel];
  $("chSave").disabled = true;
  $("chMsg").textContent = "Saving…";
  const r = await send({ type: "DV_RESOLVE_CHOICE", set: c.set, id: c.id, candidate: cand, translation: $("chTr").value.trim() })
    .catch((e) => ({ error: e.message }));
  $("chSave").disabled = false;
  if (r && r.error) { $("chMsg").textContent = r.error; return; }
  // drop this one from the local list and advance
  choices.splice(chIdx, 1);
  if (chIdx >= choices.length) { $("chooser").style.display = "none"; }
  renderChooser();
  loadChoices();
});

$("set").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  await send({ type: "DV_SET_ACTIVE", set: e.target.value });
  say(`Active set is now ${e.target.value}.`, "ok");
});

$("refresh").addEventListener("click", () => refresh(true));

$("create").addEventListener("click", async () => {
  const name = $("newName").value.trim();
  if (!name) { say("Give the set a name first.", "bad"); return; }
  say("Creating set…");
  const r = await send({ type: "DV_NEW_SET", name });
  if (r.error) { say(r.error, "bad"); return; }
  $("newName").value = "";
  fillSets(r.sets, r.name);
  say(`Created ${r.name}.`, "ok");
});

$("retry").addEventListener("click", async () => {
  say("Retrying…");
  const r = await send({ type: "DV_RETRY_QUEUE" });
  if (r.error) say(`Still failing: ${r.error}`, "bad");
  else say("Queue uploaded.", "ok");
  refresh(false);
});

function paintHl(auto) {
  const btn = $("hl");
  if (!btn) return;
  btn.textContent = auto ? "✓ Highlighting — on" : "Highlight known words";
  btn.classList.toggle("primary", !!auto);
}

$("hl").addEventListener("click", async () => {
  const btn = $("hl");
  btn.disabled = true;
  const cur = (await send({ type: "DV_GET_AUTO_HL" }).catch(() => ({ auto: false }))).auto;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!cur) {
    say("Turning on…");
    const granted = await chrome.permissions.request({ origins: ["*://*/*"] }).catch(() => false);
    await send({ type: "DV_SET_AUTO_HL", on: true });
    const r = tab ? await send({ type: "DV_APPLY_HL", tabId: tab.id, on: true }).catch((e) => ({ error: e.message })) : null;
    btn.disabled = false;
    paintHl(true);
    if (r && r.error) say(r.error, "bad");
    else say(granted
      ? `Highlighting on${r && r.count != null ? ` — ${r.count} here` : ""}.`
      : "On for pages I can access. To cover every page automatically, allow access to all sites when Chrome asks.", "ok");
  } else {
    await send({ type: "DV_SET_AUTO_HL", on: false });
    if (tab) await send({ type: "DV_APPLY_HL", tabId: tab.id, on: false }).catch(() => {});
    btn.disabled = false;
    paintHl(false);
    say("Highlighting off.", "ok");
  }
});

$("openpdf").addEventListener("click", async () => {
  const btn = $("openpdf");
  const viewerBase = chrome.runtime.getURL("viewer.html");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";
  const isPdfUrl = /\.pdf(?:[?#]|$)/i.test(url);

  // If you're already viewing a web PDF, open that one straight away (after
  // granting access to the site). Otherwise just open the reader's file picker.
  if (isPdfUrl && /^https?:/i.test(url)) {
    const origin = new URL(url).origin + "/*";
    btn.disabled = true;
    const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
    btn.disabled = false;
    if (granted) { await chrome.tabs.create({ url: viewerBase + "?file=" + encodeURIComponent(url) }); window.close(); return; }
  }
  // Local PDF already open? Pass its name so the picker shows it. Otherwise blank.
  const q = (isPdfUrl && /^file:/i.test(url)) ? "?file=" + encodeURIComponent(url) : "";
  await chrome.tabs.create({ url: viewerBase + q });
  window.close();
});

$("pending").addEventListener("click", async () => {
  const btn = $("pending");
  btn.disabled = true;
  say("Processing phone inbox & pending entries…");
  const r = await send({ type: "DV_PROCESS_ALL" });
  btn.disabled = false;
  if (r.error) { say(r.error, "bad"); refresh(false); return; }
  const inbox = r.inbox || {}, pend = r.pending || {};
  const parts = [];
  if (inbox.error) parts.push(`Inbox: ${inbox.error}`);
  else if (inbox.found) {
    let t = `Phone: filed ${inbox.filed}`;
    if (inbox.skipped) t += `, ${inbox.skipped} dup/empty`;
    if (inbox.errors) t += `, ${inbox.errors} failed`;
    if (inbox.remaining) t += `, ${inbox.remaining} queued`;
    parts.push(t + ".");
  }
  if (pend.error) parts.push(`Pending: ${pend.error}`);
  else if (pend.processed > 0) {
    let t = `Pending: enriched ${pend.updated} of ${pend.processed}`;
    if (pend.remaining > 0) t += `, ${pend.remaining} more — run again`;
    if (pend.needsSetup) t += " (enable translation in Options)";
    parts.push(t + ".");
  }
  if (!parts.length) parts.push("Nothing in the inbox, nothing pending. ✓");
  const bad = !!(inbox.error || pend.error || (inbox.errors > 0));
  say(parts.join(" "), bad ? "bad" : "ok");
  refresh(false);
});

for (const id of ["openOptions1", "openOptions2"]) {
  $(id)?.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
}

refresh(true);

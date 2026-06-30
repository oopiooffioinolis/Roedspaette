# Phase 4 — Capture from your iPhone, add words anywhere

This update closes the last gap in the system: words you **hear** or read **on your phone**. Two new ways in, one shared rule: the phone saves instantly, and your computer does the dictionary work automatically.

**What's new**

- **Extension v0.4** — watches an `inbox/` folder in your repo for iPhone captures, and now runs on auto-pilot: every 15 minutes while Chrome is open (and at every browser start) it files new inbox captures **and** enriches any rows still marked *pending* — ordnet.dk lookup, translation, the lot. You get a desktop notification when something was processed. The popup button is now **"Process inbox & pending"** if you ever want it on demand.
- **Quiz app v2** — a **＋ Add** button on the decks screen. Type a word you just heard; it's saved into your chosen Excel set as *pending*, appears in the deck immediately, and is studyable right away. Works offline too (uploads when you're back online).
- **iOS Shortcut** (you build it once, ~10 minutes) — select Danish text in any iPhone app → Share → done. Tapping its Home-Screen icon instead asks you to *type* a word, so it doubles as quick manual capture.

---

## Part 1 — Update the Chrome extension (2 min)

1. Unzip **dansk-vokab-extension-v0.4.zip** and replace the contents of your extension folder with it (same folder you used before).
2. Go to `chrome://extensions`, find **Dansk Vokab**, press the **↻ Reload** button on its card.
3. The card should now say version **0.4.0**. That's it — the auto-pilot arms itself; nothing to configure.

> If you'd rather keep the old folder, unzip to a new folder, press **Remove** on the old card and **Load unpacked** on the new folder. Your token and settings are stored in Chrome, not in the folder, so they survive either way.

## Part 2 — Update the quiz app (3 min)

Three files changed: `index.html`, `sw.js`, and a new `vocab-sheets.js`.

1. Unzip **dansk-vokab-quiz-app-v2.zip** on your computer.
2. On github.com, open your **app repo** (the public one with GitHub Pages) → **Add file → Upload files**.
3. Drag in `index.html`, `sw.js` and `vocab-sheets.js` (dragging all the files is also fine — the rest are unchanged) → **Commit changes**.
4. Pages redeploys in about a minute.
5. On the iPhone: open the app, close it fully, open it again. PWAs install updates on the *next* launch, so the ＋ Add chip appears the second time you open it.

## Part 3 — Build the iOS Shortcut (once, ~10 min)

Open the **Shortcuts** app on the iPhone:

1. Tap **＋** to create a new shortcut. Rename it **Gem dansk ord** (tap the title).
2. Tap the **ⓘ** (or the title → settings) → turn **ON "Show in Share Sheet"**. Under the input types, keep only **Text** selected.
3. Back in the editor you'll see the first block: *"Receive Text input from Share Sheet."* Tap the blue **"If there's no input"** → choose **Ask For → Text**. *(This is the trick that makes the Home-Screen icon ask you to type a word.)*
4. Add action **Get Text from** → input: **Shortcut Input**.
5. Add action **Base64 Encode** → input: the **Text** from step 4 (Encode mode).
6. Add action **Format Date** → Date: **Current Date** → Date Format: **Custom** → type exactly: `yyyyMMdd-HHmmss`
7. Add action **Get Contents of URL** and fill it in carefully:
   - **URL:** `https://api.github.com/repos/YOUR-USERNAME/dansk-vokab/contents/inbox/` then insert the **Formatted Date** variable, then type `.txt`
     (so it reads `…/inbox/[Formatted Date].txt` — replace YOUR-USERNAME with your GitHub username)
   - Tap **Show More**:
   - **Method:** `PUT`
   - **Headers** — add two:
     - `Authorization` → `Bearer github_pat_…` *(your token, with the word `Bearer` and one space before it)*
     - `Accept` → `application/vnd.github+json`
   - **Request Body:** JSON — add two **Text** fields:
     - `message` → `iPhone capture`
     - `content` → insert the **Base64 Encoded** variable
8. Optional: add **Show Notification** → "Gemt ✓ — behandles på computeren".
9. **Test it:** in Safari, select a Danish word → **Share → Gem dansk ord**. Within seconds a `.txt` file appears in your repo's `inbox/` folder on github.com. The next auto-pilot pass on your computer files it into your active set and you get a desktop notification.
10. For type-in capture: shortcut settings → **Add to Home Screen**. Tapping the icon asks "Dansk ord eller sætning?" and saves what you type.

**About the token:** it lives inside the shortcut on your phone. It can only reach your one private vocab repo, but it's still a key — treat your phone like you treat your computer, and if the phone is ever lost, delete that token on GitHub (Settings → Developer settings) and make a new one.

**Power option:** an inbox file may contain JSON instead of plain text:
`{"term":"pålæg", "note":"heard at lunch", "set":"Arbejde", "url":"https://…"}`
The note lands in the Note column; `set` is honored only if a set with that name already exists (otherwise the capture goes to the active set, so a typo can't create stray files).

## Part 4 — Adding words inside the quiz app

Decks screen → **＋ Add** → type the word or phrase (Word/Phrase is auto-detected as you type, tap to override) → optional note → choose the set → **Save** (or just press return).

- The card appears in the deck **immediately** and can be studied right away — the back will only show the translation once your computer has enriched it.
- The entry uploads as *pending*. After the computer's next auto-pilot pass, press **Refresh** in the app and the dictionary data + translation appear on the card.
- Offline? It's saved on the phone and uploads automatically when you're back online (the sync line at the bottom counts unsynced changes).

## How processing works now

- Chrome runs the inbox-and-pending pass automatically **every 15 minutes while it's open**, and once at browser start. Phone captures therefore enrich themselves within ~15 minutes of your computer being on — no clicking.
- The popup's **Process inbox & pending** button runs the same pass on demand and prints a summary.
- An inbox file that can't be read is renamed `failed-…` inside the inbox folder (kept for you to look at) instead of being retried forever.
- Duplicates are skipped, never double-added — same rule as desktop captures.

## Shakedown checklist

1. Extension card shows **0.4.0** after Reload.
2. App shows the **＋ Add** chip (second launch after updating).
3. In the app, add `prøveord` → it appears in the deck as a new card → on the computer, wait for the notification (or press the popup button) → **Refresh** in the app → the card now has a translation.
4. Share a word from Safari on the iPhone → a file appears in `inbox/` on github.com → it's gone (filed) after the next auto-pilot pass, and the word is in your set.
5. Open the set's Excel file on github.com → both test entries are there with Status `ok` — then delete the test rows if you like (edit on github.com or re-upload from Excel).

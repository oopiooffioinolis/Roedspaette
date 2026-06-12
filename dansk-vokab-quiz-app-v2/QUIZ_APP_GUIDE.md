# Dansk Vokab — Quiz App (Phase 3)

Cogni-style flashcards driven by a memory-curve (SM-2) scheduler, reading the very same Excel files your extension fills — and writing your review progress back into their hidden columns, so every device stays in sync through the repo.

## Setup (10 min, once)

1. **Create a second repo — public this time** — at github.com/new, name it e.g. `dansk-vokab-app`, tick "Add a README". (Public because GitHub Pages is free only on public repos; the app contains no secrets — your token and your words never live in it.)
2. **Upload the app:** unzip `dansk-vokab-quiz-app.zip` → in the repo, *Add file → Upload files* → drag all 9 files in → Commit.
3. **Turn on Pages:** repo *Settings → Pages* → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save. After ~1 minute your app is live at `https://YOURNAME.github.io/dansk-vokab-app/`.
4. **Connect:** open that URL, paste your fine-grained token (the extension's token works — it already has access to the vocab repo), owner, repo (`dansk-vokab`), folder (`sets`). Connect.

## On your iPhone

Open the same URL in **Safari** → Share button → **Add to Home Screen**. It launches fullscreen like a native app, caches itself for offline study, and asks for the token once. That's the whole iOS story — no App Store, no Mac, no developer account.

## How studying works

- The home screen lists every set as a deck with **due / new / total** counts, plus an *Alle sæt* deck combining everything.
- Tap a deck → cards appear Danish-side first. **Tap to flip.** The back shows the translation, word class + en/et + inflections, IPA with a **▶︎ udtale** button (plays the ordnet.dk audio), the Danish definition, the word-by-word gloss for phrases, and the original sentence you captured it from.
- Grade yourself with **Again / Hard / Good / Easy** — each button shows when you'd see the card next (now / 6d / 3mo…). *Again* re-queues the card a few cards later in the same session and resets its schedule; the others grow the interval along the forgetting curve. New cards enter at 10 per session (changeable: 5–40), and the **DA→EN** chip flips the whole deck to English-first if you want recall practice in the other direction.
- Desktop niceties: Space flips, keys 1–4 grade.

## How progress syncs

Every grade is saved on-device immediately, then batched into commits — after every 10 cards, at session end, and when you leave the app — like *"Review progress: 14 cards in Hverdag.xlsx."* Sync re-fetches the file first and applies changes by card ID, so it never collides with words you captured on the laptop five minutes ago. Offline? Study from the cached decks; the yellow dot shows reviews waiting, and they upload the moment you're back online (or via *Sync now*).

## Good to know

- **Refresh** (↻) pulls new captures into the decks; it only re-downloads files that actually changed.
- If iOS ever clears Safari storage after long disuse, you lose only the cached decks and token — re-enter the token; your progress is safe in the Excel files.
- The Pages URL is public, but without a token the app shows nothing — and your data repo stays private.
- Excel remains the source of truth: edit a translation via the extension's reader mode or on GitHub, hit Refresh, and the cards update.

## Next: Phase 4

The iOS share-sheet Shortcut — select Danish text in any app on your phone → Share → it lands in an `inbox/` in the repo, and the extension enriches and files it next time your laptop is open.

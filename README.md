# Rødspætte — vocabulary data

The words and study progress behind Rødspætte. The code (Chrome extension and quiz app)
lives in the `Roedspaette-App` repository; both read and write this repo through the GitHub API.

```
sets/<Name>.json                 one set: its words and phrases, one row per line
sets/index.json                  ["Name", …] for the iPhone Shortcut's set picker
progress/cards.json              spaced-repetition state of every card, by card ID
progress/reviews-YYYY-MM.jsonl   review history, one JSON object per line
inbox/                           captures from the iPhone Shortcut, filed by the extension
```

Excel copies of every set are rebuilt each night and attached to the
[`excel` release](../../releases/tag/excel) (see `.github/workflows/export-excel.yml`).
They are read-only: the apps never read them, so edits there won't come back.

Until November 2026 the sets were Excel files (`sets/*.xlsx`); they are in the git history.

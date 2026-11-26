#!/usr/bin/env python3
"""Build read-only Excel copies of the vocab sets (for browsing; the apps never read them).

    python tools/export_excel.py [out-dir]      (run from the data repo root; default out-dir: exports)

One workbook per set: sheets Words and Phrases with every content column, followed by
each card's schedule in both quiz directions (from progress/cards.json). Needs openpyxl.
"""
import glob, json, os, sys

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font

WORD_FIELDS = ["ID", "DateAdded", "Term", "Lemma", "WordClass", "Gender", "Inflections",
               "IPA", "AudioURL", "Definition", "Translation", "Snippet", "SourceTitle",
               "SourceURL", "DeepLink", "Note", "Status"]
PHRASE_FIELDS = ["ID", "DateAdded", "Phrase", "Gloss", "Translation", "Snippet",
                 "SourceTitle", "SourceURL", "DeepLink", "Note", "Status"]
SRS = [("due", "Due"), ("interval", "Interval"), ("reps", "Reps"), ("lapses", "Lapses"),
       ("stability", "Stability"), ("difficulty", "Difficulty"), ("lastReview", "LastReview")]
WIDTH = {"Term": 18, "Phrase": 30, "Definition": 40, "Translation": 30, "Snippet": 50, "Gloss": 36}


def clean(v):
    # control characters (e.g. from PDF snippets) are not allowed in xlsx
    return ILLEGAL_CHARACTERS_RE.sub("", v) if isinstance(v, str) else v


def sheet(wb, title, rows, fields, progress):
    ws = wb.create_sheet(title)
    extra = []
    for r in rows:
        for k in r:
            if k not in fields and k != "Candidates" and k not in extra:
                extra.append(k)
    srs_cols = [label + suffix for suffix in ("", "_EN") for _, label in SRS]
    header = fields + extra + srs_cols
    ws.append(header)
    for c in ws[1]:
        c.font = Font(bold=True)
    for r in rows:
        p = progress.get(r.get("ID", ""), {})
        srs = [p.get(d, {}).get(k, "") for d in ("da2en", "en2da") for k, _ in SRS]
        ws.append([clean(r.get(f, "")) for f in fields + extra] + srs)
        for c in ws[ws.max_row]:
            if isinstance(c.value, str) and c.value.startswith("="):
                c.data_type = "s"  # text like "= kaffemølle" is not a formula
    for i, h in enumerate(header, 1):
        ws.column_dimensions[ws.cell(1, i).column_letter].width = WIDTH.get(h, 14)
    ws.freeze_panes = "A2"


def main(out):
    os.makedirs(out, exist_ok=True)
    progress = {}
    if os.path.exists("progress/cards.json"):
        with open("progress/cards.json", encoding="utf-8") as f:
            progress = json.load(f).get("cards", {})
    for path in sorted(glob.glob("sets/*.json")):
        if os.path.basename(path).lower() == "index.json":
            continue
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        wb = Workbook()
        wb.remove(wb.active)
        sheet(wb, "Words", doc.get("words", []), WORD_FIELDS, progress)
        sheet(wb, "Phrases", doc.get("phrases", []), PHRASE_FIELDS, progress)
        name = os.path.splitext(os.path.basename(path))[0]
        wb.save(os.path.join(out, name + ".xlsx"))
        print(f"{name}.xlsx: {len(doc.get('words', []))} words, {len(doc.get('phrases', []))} phrases")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "exports")

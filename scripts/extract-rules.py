"""Extract the core rulebook to text and pull the sections the engine depends on.

The engine has been wrong about several 11th-edition rules -- cover, Devastating
Wounds, Feel No Pain -- because secondary sources disagreed with each other. The
rulebook settles them.
"""
import re
import sys
from pathlib import Path

from pypdf import PdfReader

PDF = Path(r"C:\Users\alexa\OneDrive\Desktop\eng_01-06_warhammer40k_new40k_core_rules-was6fbu1ix-hfewhmxyiy.pdf")
OUT = Path(".cache/core-rules.txt")

def extract():
    reader = PdfReader(str(PDF))
    pages = []
    for i, page in enumerate(reader.pages):
        try:
            pages.append(f"\n===== PAGE {i+1} =====\n" + (page.extract_text() or ""))
        except Exception as e:  # a malformed page should not stop the run
            pages.append(f"\n===== PAGE {i+1} ===== (extract failed: {e})\n")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("".join(pages), encoding="utf-8")
    return OUT.read_text(encoding="utf-8")

def find(text, pattern, before=120, after=900, limit=3):
    """Print windows around a pattern so the surrounding rule is visible."""
    out = []
    for m in list(re.finditer(pattern, text, re.I))[:limit]:
        page = text.rfind("===== PAGE", 0, m.start())
        page_no = re.search(r"PAGE (\d+)", text[page:page+30])
        chunk = text[max(0, m.start()-before): m.start()+after]
        out.append(f"--- p{page_no.group(1) if page_no else '?'} ---\n{chunk}")
    return out

if __name__ == "__main__":
    text = extract()
    print(f"extracted {len(text):,} characters\n")
    topic = sys.argv[1] if len(sys.argv) > 1 else None
    patterns = {
        "cover": r"benefit of cover",
        "devastating": r"\[?devastating wounds\]?",
        "fnp": r"feel no pain",
        "modifiers": r"modif(?:y|iers?)[^.]{0,60}(?:cannot|maximum|no more than|capped)",
        "hazardous": r"hazardous",
        "sustained": r"sustained hits",
        "lethal": r"lethal hits",
        "anti": r"\[?anti-",
        "mortal": r"mortal wounds",
        "allocate": r"allocate attack",
    }
    if topic and topic in patterns:
        for chunk in find(text, patterns[topic]):
            print(chunk)
            print()
    else:
        print("topics:", ", ".join(patterns))

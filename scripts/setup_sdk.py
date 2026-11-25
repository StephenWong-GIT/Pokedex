#!/usr/bin/env python3
"""Extract the Mira SDK sources from Mira's SKILL.md into ./sdk/.

The SDK is Mira's code, not ours, so it is NOT committed (see .gitignore).
Put your copy of Mira's SKILL.md at sdk/SKILL.md (or pass a path) and run:
    python3 scripts/setup_sdk.py [path/to/SKILL.md]
"""
from pathlib import Path
import re, sys

root = Path(__file__).resolve().parent.parent
sdk = root / "sdk"
src = Path(sys.argv[1]) if len(sys.argv) > 1 else sdk / "SKILL.md"
if not src.exists():
    sys.exit(f"Mira SKILL.md not found at {src}. Download it from Mira and try again.")
text = src.read_text(encoding="utf-8")
files = re.findall(r"<!-- mira-sdk-file: ([^\n]+) -->\n(`{3,})[^\n]*\n(.*?)\n\2\n<!-- /mira-sdk-file -->", text, re.S)
if not files:
    sys.exit("No SDK sources found in that file; use the complete Mira guide.")
sdk.mkdir(exist_ok=True)
for name, _, content in files:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts:
        sys.exit("Invalid SDK path: " + name)
    out = sdk / path
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding="utf-8")
if src.resolve() != (sdk / "SKILL.md").resolve():
    (sdk / "SKILL.md").write_text(text, encoding="utf-8")
print(f"Extracted {len(files)} SDK files into {sdk}")

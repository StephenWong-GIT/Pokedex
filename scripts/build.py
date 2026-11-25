#!/usr/bin/env python3
"""Build dist/Pokedex.html: compile src/pokedex.rs to WASM, inline the phone
companion (companion/*), embed both in one Mira package, and validate it.

    python3 scripts/build.py            # -> dist/Pokedex.html
"""
from pathlib import Path
import base64, subprocess, sys, tempfile

root = Path(__file__).resolve().parent.parent
sdk = root / "sdk"
if not (sdk / "CompanionExample" / "validate.py").exists():
    sys.exit("SDK missing. Run: python3 scripts/setup_sdk.py")
sys.path.insert(0, str(sdk / "CompanionExample"))
from validate import validate_html  # noqa: E402

TITLE = "Pokedex"  # must match APP_NAME in src/pokedex.rs
out = root / "dist" / f"{TITLE}.html"

with tempfile.TemporaryDirectory(prefix="pokedex-") as tmp:
    wasm = Path(tmp) / "pokedex.wasm"
    # Exact flags required by the Mira SDK guide; do not change.
    subprocess.run([
        "rustc", str(root / "src" / "pokedex.rs"), "--edition=2021",
        "--target=wasm32-unknown-unknown", "--crate-type=cdylib",
        "-C", "opt-level=z", "-C", "panic=abort", "-C", "lto=fat", "-C", "codegen-units=1",
        "-C", "link-arg=--no-entry", "-C", "link-arg=--strip-all",
        "-C", "target-feature=-bulk-memory,+bulk-memory-opt,-reference-types",
        "-C", "link-arg=-zstack-size=8192",
        "-C", "link-arg=--initial-memory=65536", "-C", "link-arg=--max-memory=65536",
        "-o", str(wasm),
    ], check=True)
    encoded = base64.b64encode(wasm.read_bytes()).decode()

comp = root / "companion"
ui = (comp / "index.html").read_text(encoding="utf-8")
scripts = "".join(
    f"<script>\n{(comp / name).read_text(encoding='utf-8')}\n</script>\n"
    for name in ("camera.js", "claude.js", "saved.js", "picture.js", "app.js")
)
html = (
    '<!doctype html><html><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    f'<script type="application/mira-manifest+json">{{"title":"{TITLE}"}}</script>\n'
    "</head><body>\n" + ui + "\n" + scripts +
    f'<script type="application/mira-wasm">{encoded}</script>\n</body></html>\n'
)
validate_html(html)
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"{out}  ({len(base64.b64decode(encoded))} WASM bytes)")

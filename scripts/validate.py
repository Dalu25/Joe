#!/usr/bin/env python3
"""Pre-deploy checks for index.html.

1. Every inline <script> (no src attribute) must pass `node --check`.
2. div, details and section tags must be balanced (open count == close count).

Exits with status 1 if any check fails, so CI can block a deploy.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "index.html"
TAGS = ("div", "details", "section")


def check_inline_scripts(html: str) -> list[str]:
    errors = []
    pattern = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.S | re.I)
    scratch = Path(tempfile.mkdtemp(prefix="validate-"))
    count = 0
    for match in pattern.finditer(html):
        attrs, body = match.group(1), match.group(2)
        if re.search(r"\bsrc\s*=", attrs, re.I) or not body.strip():
            continue
        count += 1
        js_file = scratch / f"inline-{count}.js"
        js_file.write_text(body, encoding="utf-8")
        result = subprocess.run(
            ["node", "--check", str(js_file)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            line_no = html[: match.start(2)].count("\n") + 1
            errors.append(
                f"Inline script #{count} (starts near line {line_no}) has a syntax error:\n"
                f"{result.stderr.strip()}"
            )
    print(f"Checked {count} inline script block(s)")
    return errors


def check_tag_balance(html: str) -> list[str]:
    errors = []
    for tag in TAGS:
        opens = len(re.findall(rf"<{tag}\b", html, re.I))
        closes = len(re.findall(rf"</{tag}\s*>", html, re.I))
        status = "OK" if opens == closes else "MISMATCH"
        print(f"<{tag}>: open={opens} close={closes} {status}")
        if opens != closes:
            errors.append(f"<{tag}> tags are unbalanced: {opens} open, {closes} close")
    return errors


def main() -> int:
    html = TARGET.read_text(encoding="utf-8")
    errors = check_inline_scripts(html) + check_tag_balance(html)
    if errors:
        print("\nVALIDATION FAILED")
        for err in errors:
            print(f"- {err}")
        return 1
    print("\nVALIDATION PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())

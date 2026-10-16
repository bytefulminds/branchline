#!/usr/bin/env python3
"""Build src-tauri/icons/icon.icns from icon.svg.

Needs rsvg-convert (librsvg) and Pillow. Run from anywhere:

    python3 src-tauri/icons/macos/build.py
"""

import io
import pathlib
import shutil
import subprocess
import sys

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = HERE / "icon.svg"
TARGET = HERE.parent / "icon.icns"


def main() -> int:
    if not shutil.which("rsvg-convert"):
        print("rsvg-convert not found (install librsvg)", file=sys.stderr)
        return 1
    png = subprocess.run(
        ["rsvg-convert", "--width", "1024", "--height", "1024", str(SOURCE)],
        check=True,
        capture_output=True,
    ).stdout
    image = Image.open(io.BytesIO(png)).convert("RGBA")
    # Pillow writes every standard ICNS size (16 to 512@2x) from the 1024 source.
    image.save(TARGET, format="ICNS")
    print(f"wrote {TARGET.relative_to(HERE.parents[2])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

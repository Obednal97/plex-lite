#!/usr/bin/env python3
"""Renders the app icons from assets/icon.svg to the PNG sizes webOS uses.

    make-icons.py [out-dir]          default: img/

appinfo.json "icon" is 80x80 and "largeIcon" is 130x130. Uses rsvg-convert if it is installed,
otherwise headless Chrome/Chromium (set CHROME to its path if it isn't found) plus ImageMagick or
macOS sips to scale down.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
SVG = APP / "assets" / "icon.svg"
SIZES = (("icon.png", 80), ("largeIcon.png", 130))
CHROMES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome", "chromium", "chromium-browser",
]


def find_chrome():
    for c in [os.environ.get("CHROME")] + CHROMES:
        if c and (Path(c).exists() or shutil.which(c)):
            return c
    return None


def scale(src, dst, size):
    if shutil.which("magick"):
        subprocess.run(["magick", str(src), "-filter", "Lanczos", "-resize", f"{size}x{size}", "-strip", str(dst)], check=True)
    elif shutil.which("sips"):
        shutil.copy(src, dst)
        subprocess.run(["sips", "-z", str(size), str(size), str(dst)], check=True, stdout=subprocess.DEVNULL)
    else:
        sys.exit("need ImageMagick (magick) or sips to scale the rendered icon")


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else APP / "img"
    out.mkdir(parents=True, exist_ok=True)
    if shutil.which("rsvg-convert"):
        for name, size in SIZES:
            subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(out / name), str(SVG)], check=True)
            print("wrote", out / name)
        return
    chrome = find_chrome()
    if not chrome:
        sys.exit("need rsvg-convert or Chrome/Chromium (set CHROME=/path/to/chrome)")
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "icon.html"
        page.write_text('<!doctype html><html><body style="margin:0;background:transparent">'
                        f'<img src="{SVG.as_uri()}" width="1024" height="1024" style="display:block"></body></html>')
        big = Path(tmp) / "icon-1024.png"
        subprocess.run([chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        "--default-background-color=00000000", "--window-size=1024,1024",
                        f"--screenshot={big}", page.as_uri()],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for name, size in SIZES:
            scale(big, out / name, size)
            print("wrote", out / name)


if __name__ == "__main__":
    main()

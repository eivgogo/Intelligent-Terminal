#!/usr/bin/env python3
"""Generate app icon from a source PNG: auto-crop to opaque content, then
produce a macOS-standard 1024 (content inset + squircle) and a 512 full-bleed.

Requires Pillow. Run: python3 scripts/generate-mac-icon.py <source.png>
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/terminal.iconset/icon_128x128@2x.png")

def load_cropped(path):
    img = Image.open(path).convert("RGBA")
    bbox = img.getbbox()          # opaque content bounds (alpha>0)
    return img.crop(bbox) if bbox else img

cropped = load_cropped(SRC)

# 1) macOS standard 1024: content fills ~content_ratio, squircle radius ~22.37%
S = 1024
content_ratio = 0.86
content = int(S * content_ratio)
pad = (S - content) // 2
radius = int(S * 0.2237)

src = cropped.resize((content, content), Image.LANCZOS)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
img.paste(src, (pad, pad))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)
out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
out.paste(img, (0, 0), mask)
out.save("/tmp/terminal-mac-standard.png")

# 2) Windows/Linux full-bleed 512
W = 512
cropped.resize((W, W), Image.LANCZOS).save("/tmp/terminal-win.png")

print("wrote /tmp/terminal-mac-standard.png and /tmp/terminal-win.png")

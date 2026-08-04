#!/usr/bin/env python3
"""Generate the Intelligent Terminal app icon: dark terminal + ">_" prompt +
cyan intelligent sparkle. Requires Pillow.

Outputs:
  /tmp/it-mac.png   1024x1024 macOS-standard (content ~86%, squircle)
  /tmp/it-win.png   512x512   full-bleed (Windows/Linux)
"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

S_MAC = 1024
S_WIN = 512
CONTENT_RATIO_MAC = 0.78
RAD = 0.2237  # squircle corner radius factor
MENLO = "/System/Library/Fonts/Menlo.ttc"

TOP = (48, 51, 62, 255)     # slate
BOT = (12, 13, 18, 255)     # near-black
PROMPT = (245, 246, 250, 255)
STAR = (190, 244, 255, 255)
STAR_GLOW = (34, 211, 238, 90)
BASE_GLOW = (34, 211, 238, 70)


def make(size, content_ratio):
    content = int(size * content_ratio)
    pad = (size - content) // 2
    cr = int(content * RAD)

    # dark vertical gradient
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / (size - 1)
        fill = tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(4))
        d.line([(0, y), (size, y)], fill=fill)

    # squircle mask over content area
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [pad, pad, size - pad - 1, size - pad - 1], radius=cr, fill=255)
    img = Image.composite(grad, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask)
    dr = ImageDraw.Draw(img)

    # subtle cyan glow near the bottom
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gcx = size // 2
    gy = size - pad - int(content * 0.30)
    gd.ellipse([gcx - int(content * 0.30), gy - int(content * 0.12),
                gcx + int(content * 0.30), gy + int(content * 0.12)], fill=BASE_GLOW)
    glow = glow.filter(ImageFilter.GaussianBlur(int(content * 0.05)))
    img.alpha_composite(glow)

    # ">_" prompt (Menlo Bold, white)
    font = ImageFont.truetype(MENLO, int(content * 0.30), index=1)
    text = ">_"
    bbox = dr.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = size // 2 - tw // 2 - bbox[0]
    ty = size // 2 - th // 2 - bbox[1] + int(content * 0.01)
    dr.text((tx, ty), text, font=font, fill=PROMPT)

    # intelligent sparkle (cyan 4-point star) top-right
    sx = size - pad - int(content * 0.16)
    sy = pad + int(content * 0.15)
    R = int(content * 0.085)
    r = int(content * 0.030)
    spark = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(spark).ellipse([sx - R, sy - R, sx + R, sy + R], fill=STAR_GLOW)
    spark = spark.filter(ImageFilter.GaussianBlur(int(content * 0.02)))
    star = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(star).polygon(
        [(sx, sy - R), (sx + r, sy - r), (sx + R, sy), (sx + r, sy + r),
         (sx, sy + R), (sx - r, sy + r), (sx - R, sy), (sx - r, sy - r)], fill=STAR)
    img.alpha_composite(spark)
    img.alpha_composite(star)
    return img


make(S_MAC, CONTENT_RATIO_MAC).save("/tmp/it-mac.png")
make(S_WIN, 1.0).save("/tmp/it-win.png")
print("wrote /tmp/it-mac.png and /tmp/it-win.png")

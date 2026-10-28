#!/usr/bin/env python3
"""Draw the ZcodeGateway macOS app icon and emit assets/zcode.iconset + .icns.

macOS-style squircle with a violet gradient, a bold chevron-Z, and a small
status glyph. Pure Pillow; run from the repo root with the project venv.
"""
from __future__ import annotations

import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent.parent
ASSETS = HERE / "assets"
S = 1024  # master canvas

# palette (matches the dashboard's dark violet theme)
TOP = (126, 112, 255)     # violet
BOT = (86, 66, 210)       # deeper violet
INK = (16, 14, 34)        # near-black glyph
GLOW = (190, 180, 255)


def squircle_path(draw: ImageDraw.ImageDraw, box: tuple, n: float) -> None:
    """Approximate the macOS superellipse with a rounded rect + smoothing.

    A plain rounded-rect at radius ~22.5% reads as a squircle at icon sizes;
    a true superellipse needs curves that Pillow lacks.
    """
    draw.rounded_rectangle(box, radius=n, fill=255)


def vertical_gradient(size: tuple, top: tuple, bot: tuple) -> Image.Image:
    w, h = size
    g = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        g.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(top, bot)))
    return g.resize((w, h))


def build() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # --- squircle body ---
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    squircle_path(md, (64, 64, S - 64, S - 64), int((S - 128) * 0.225))

    body = vertical_gradient((S, S), TOP, BOT).convert("RGBA")
    # subtle radial highlight top-center
    hl = Image.new("L", (S, S), 0)
    hd = ImageDraw.Draw(hl)
    hd.ellipse((S * 0.05, -S * 0.25, S * 0.95, S * 0.55), fill=70)
    hl = hl.filter(ImageFilter.GaussianBlur(120))
    body = Image.composite(Image.new("RGBA", (S, S), (255, 255, 255, 255)), body, hl)

    img.paste(body, (0, 0), mask)

    # inner hairline (macOS icons have a faint inner edge)
    edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    ed.rounded_rectangle((66, 66, S - 66, S - 66), int((S - 132) * 0.225),
                         outline=(255, 255, 255, 60), width=4)
    img = Image.alpha_composite(img, edge)

    # --- glyph: bold Z built from two bars + diagonal ---
    g = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(g)
    x0, y0, x1, y1 = 268, 292, 756, 732      # glyph bounding box
    bar = 74                                  # stroke thickness
    # soft shadow under the glyph
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.polygon([(x0 + 16, y0 + bar + 18), (x1 + 16, y0 + bar + 18),
                (x0 + 16, y0 + 18)], fill=(20, 10, 60, 130))
    sd.polygon([(x0 - 16 + bar, y1 - bar - 18), (x1 - 16 + bar, y1 - bar - 18),
                (x1 - 16 + bar, y1 - 18)], fill=(20, 10, 60, 130))
    sd.line([(x0 + 16 + bar // 2, y0 + bar + 18), (x1 - 16 - bar // 2, y1 - bar - 18)],
            fill=(20, 10, 60, 130), width=bar + 26)
    sh = sh.filter(ImageFilter.GaussianBlur(22))
    g = Image.alpha_composite(g, sh)
    gd = ImageDraw.Draw(g)          # re-bind: alpha_composite returns a NEW image
    # the Z: top bar, diagonal, bottom bar
    gd.rectangle((x0, y0, x1, y0 + bar), fill=INK)
    gd.rectangle((x0, y1 - bar, x1, y1), fill=INK)
    gd.line([(x0 + bar // 2, y0 + bar), (x1 - bar // 2, y1 - bar)],
            fill=INK, width=bar)
    img = Image.alpha_composite(img, g)

    # --- status dot (the gateway is "live") ---
    d = ImageDraw.Draw(img)
    cx, cy, r = 806, 218, 58
    d.ellipse((cx - r - 14, cy - r - 14, cx + r + 14, cy + r + 14),
              fill=(255, 255, 255, 70))          # halo
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(52, 230, 140))
    d.ellipse((cx - r + 12, cy - r + 10, cx + r - 18, cy + r - 26),
              fill=(160, 255, 205))              # specular

    return img


def main() -> None:
    master = build()
    png_path = ASSETS / "zcode-mac-icon.png"
    master.save(png_path)

    iconset = ASSETS / "zcode.iconset"
    iconset.mkdir(exist_ok=True)
    for f in iconset.glob("*.png"):
        f.unlink()
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    for s in sizes:
        master.resize((s, s), Image.LANCZOS).save(iconset / f"icon_{s}x{s}.png")
        if s <= 512:
            master.resize((s, s), Image.LANCZOS).save(iconset / f"icon_{s}x{s}@2x.png")

    icns = ASSETS / "zcode.icns"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    print(f"OK {png_path} + {icns}")


if __name__ == "__main__":
    main()

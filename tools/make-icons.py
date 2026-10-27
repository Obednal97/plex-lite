#!/usr/bin/env python3
"""Draws the app icons (amber chevron on dark) without any imaging library."""
import struct
import sys
import zlib
from pathlib import Path

BG = (24, 24, 24)
FG = (229, 160, 13)
SS = 4  # supersampling per axis


def inside(x, y, poly):
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def rounded(x, y, r):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


CHEVRON = [(0.30, 0.18), (0.52, 0.18), (0.76, 0.50), (0.52, 0.82), (0.30, 0.82), (0.54, 0.50)]


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            bg = fg = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    if rounded(x, y, 0.18):
                        if inside(x, y, CHEVRON):
                            fg += 1
                        else:
                            bg += 1
            n = SS * SS
            a = (bg + fg) / n
            if bg + fg:
                col = [(BG[i] * bg + FG[i] * fg) / (bg + fg) for i in range(3)]
            else:
                col = [0, 0, 0]
            row += bytes([round(col[0]), round(col[1]), round(col[2]), round(a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "img")
    out.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon.png", 80), ("largeIcon.png", 130)):
        (out / name).write_bytes(render(size))
        print("wrote", out / name)

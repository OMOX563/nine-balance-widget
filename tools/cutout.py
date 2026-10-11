# -*- coding: utf-8 -*-
"""Black background -> transparent: four-edge flood-fill removes only the
background black connected to the edges; black inside the artwork stays.
    Outputs a 384px transparent webp (ready for a Chromium data URI)."""
import os
import sys
from PIL import Image, ImageDraw, ImageFilter

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
OUT = os.path.join(SRC, 'transparent')
os.makedirs(OUT, exist_ok=True)

MAGIC = (255, 0, 255)


def cutout(path_in, path_out, size=384, tol=60):
    im = Image.open(path_in).convert('RGB')
    w, h = im.size
    # flood-fill seeded from all edges+corners: background black -> magic color
    # (tolerance swallows the antialiasing transition band)
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for s in seeds:
        px = im.getpixel(s)
        if sum(px) > 90:          # seed pixel is not black (framing shifted) — skip to be safe
            continue
        ImageDraw.floodfill(im, s, MAGIC, thresh=tol)

    rgba = im.convert('RGBA')
    datas = rgba.getdata()
    new = [(r, g, b, 0) if (r, g, b) == MAGIC else (r, g, b, 255) for (r, g, b, a) in datas]
    rgba.putdata(new)

    # trim 1px off the edge to kill the flood-fill black fringe
    alpha = rgba.getchannel('A').filter(ImageFilter.MinFilter(3))
    rgba.putalpha(alpha)

    rgba.thumbnail((size, size))
    rgba.save(path_out, 'WEBP', quality=78, method=6)
    return os.path.getsize(path_out)


if __name__ == '__main__':
    ids = sys.argv[1:] or ['deepseek', 'minimax', 'glm', 'kimi', 'mimo', 'chatgpt', 'claude', 'gemini', 'grok']
    total = 0
    for pid in ids:
        sz = cutout(os.path.join(SRC, pid + '.jpg'), os.path.join(OUT, pid + '.webp'))
        total += sz
        print(f'{pid}.webp {sz // 1024} KB')
    print(f'TOTAL {total // 1024} KB -> base64 ~{total * 4 // 3 // 1024} KB')

"""生成市场卡片用的 180x180 位图图标（与插件内置 icon.svg 同一设计）。"""
from PIL import Image, ImageDraw
import math

SIZE = 180
SS = 4                      # 超采样倍数，画完再缩回去，边缘更干净
W = SIZE * SS
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角蓝底
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=(29, 111, 208, 255))

cx = cy = W / 2
r = W * 0.265
width = int(W * 0.075)
white = (255, 255, 255, 255)

# 圆环缺口在 250°–300° 之间，箭头补在 290° 处
d.arc([cx - r, cy - r, cx + r, cy + r], start=300, end=250, fill=white, width=width)

# 箭头（沿顺时针切向）
a = math.radians(290)
px, py = cx + r * math.cos(a), cy + r * math.sin(a)
tx, ty = -math.sin(a), math.cos(a)          # 切向
nx, ny = -ty, tx                            # 法向
head = W * 0.085
side = W * 0.062
tri = [
    (px + tx * head, py + ty * head),
    (px + nx * side, py + ny * side),
    (px - nx * side, py - ny * side),
]
d.polygon(tri, fill=white)

img = img.resize((SIZE, SIZE), Image.LANCZOS)
out = r"D:\3Dprintwork\dsh-restart-foot\assets\icon-180.png"
import os
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG", optimize=True)
print("saved", out, os.path.getsize(out), "bytes")
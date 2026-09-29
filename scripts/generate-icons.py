#!/usr/bin/env python3
"""从 logo.svg 生成 PWA / iOS 所需 PNG 图标。

iOS 的 apple-touch-icon 不接受 SVG，且透明背景会被 iOS 填成黑色，
因此所有图标都带不透明底色。maskable 图标额外留出安全区，
避免被 Android 自适应图标裁掉主体。

依赖 rsvg-convert（librsvg）。用法：python3 scripts/generate-icons.py
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "logo.svg"
BACKGROUND = "#101216"

# (输出文件名, 边长, logo 占画布比例)
# maskable 的安全区是以画布中心为圆心、直径 80% 的圆，
# 因此内接正方形的边长上限约为 0.8/√2 ≈ 0.566，这里取 0.54 留余量。
TARGETS = [
    ("icon-192.png", 192, 0.78),
    ("icon-512.png", 512, 0.78),
    ("icon-maskable-512.png", 512, 0.54),
    ("apple-touch-icon.png", 180, 0.80),
    ("favicon-32.png", 32, 0.86),
]


def load_logo_body() -> str:
    """取出 logo.svg 内部绘制内容，去掉外层 <svg> 包裹。"""
    source = LOGO.read_text(encoding="utf-8")
    body = re.sub(r"^.*?<svg[^>]*>", "", source, count=1, flags=re.DOTALL)
    body = re.sub(r"</svg>\s*$", "", body, count=1)
    if not body.strip():
        raise SystemExit(f"未能从 {LOGO} 解析出绘制内容")
    return body


def build_svg(body: str, size: int, ratio: float) -> str:
    """把 logo 居中合成到带底色的正方形画布上。"""
    inner = round(size * ratio)
    offset = (size - inner) / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">\n'
        f'  <rect width="{size}" height="{size}" fill="{BACKGROUND}"/>\n'
        f'  <svg x="{offset}" y="{offset}" width="{inner}" height="{inner}" '
        f'viewBox="0 0 64 64">\n{body}\n  </svg>\n</svg>\n'
    )


def main() -> int:
    if shutil.which("rsvg-convert") is None:
        print("缺少 rsvg-convert，请先安装 librsvg", file=sys.stderr)
        return 1

    body = load_logo_body()
    for name, size, ratio in TARGETS:
        svg_path = ROOT / f".icon-tmp-{size}-{int(ratio * 100)}.svg"
        out_path = ROOT / name
        svg_path.write_text(build_svg(body, size, ratio), encoding="utf-8")
        try:
            subprocess.run(
                ["rsvg-convert", "-w", str(size), "-h", str(size), str(svg_path), "-o", str(out_path)],
                check=True,
            )
        finally:
            svg_path.unlink(missing_ok=True)
        print(f"生成 {name} ({size}x{size})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

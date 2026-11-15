#!/usr/bin/env python3
"""重新生成安装界面图片（apps/desktop/src-tauri/windows/art/，24 位 BMP）。

由 assets/logo.png（黑色线稿）派生，4 倍超采样后缩小，边缘平滑；文字用 Noto Sans SC 与 Inter（均为 OFL）。
用法：python3 scripts/render-installer-art.py [--cjk <NotoSansSC-Medium.otf> --latin <Inter-SemiBold.ttf>]

安装向导（ADR 0014）的图片不需要字体，每次都生成：
  exe（setup-theme.xml，PNG，带透明度；每种按 100%/125%/150%/200% DPI 各一张，thmutil 按目标尺寸挑选）
    setup-icon-40*.png（页眉标志）、setup-icon-72*.png（欢迎页大图标）、setup-check-44*.png（完成页对勾）、
    setup-steps-<1|2|3>*.png（右上角步骤圆点）、setup-line.png（#e1e1e3 分割线 / 边框，拉伸使用）
  MSI（PrimusUI.wxi，24 位 BMP，白底）
    msi-icon-40.bmp、msi-icon-72.bmp、msi-check-44.bmp、msi-steps-<1|2|3>.bmp、msi-line.bmp、msi-white.bmp（整页白底）
只有传入 --cjk 与 --latin 时才重画 WixUI 公共对话框沿用的 wix-banner.bmp / wix-dialog.bmp（带文字）。
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "apps/desktop/src-tauri/windows/art"
S = 4  # 超采样倍数
SIDEBAR_BG = (246, 246, 248)
WHITE = (255, 255, 255)
FG = (29, 29, 31)
MUTED = (110, 110, 115)


def logo(size: int) -> Image.Image:
    src = Image.open(ROOT / "assets/logo.png").convert("RGBA")
    return src.resize((size, size), Image.LANCZOS)


def canvas(w: int, h: int, bg) -> Image.Image:
    return Image.new("RGBA", (w * S, h * S), bg + (255,))


def finish(img: Image.Image, w: int, h: int, name: str) -> None:
    out = img.resize((w, h), Image.LANCZOS).convert("RGB")
    out.save(ART / name, format="BMP")


def sidebar(img: Image.Image, width: int, height: int, fonts) -> None:
    """欢迎 / 完成页左侧栏：浅灰底，标志 + 中文名 + 英文名，居中偏上。"""
    d = ImageDraw.Draw(img)
    mark = logo(76 * S)
    x = (width * S - mark.width) // 2
    y = int(height * S * 0.26)
    img.alpha_composite(mark, (x, y))
    cjk, latin = fonts
    cy = y + mark.height + 18 * S
    for text, font, color, gap in ((("乾元", cjk, FG, 6)), (("Primus", latin, MUTED, 0))):
        box = d.textbbox((0, 0), text, font=font)
        tw = box[2] - box[0]
        d.text(((width * S - tw) // 2 - box[0], cy - box[1]), text, font=font, fill=color)
        cy += (box[3] - box[1]) + gap * S


LINE = (225, 225, 227)  # #e1e1e3 分割线
DOT_OFF = (225, 225, 227)
DOT_ON = (29, 29, 31)  # #1d1d1f
SUCCESS = (36, 138, 61)  # #248a3d
SCALES = ((1.0, ""), (1.25, "@125"), (1.5, "@150"), (2.0, "@200"))


def icon_rgba(size: int) -> Image.Image:
    """标志（黑色线稿，透明底），4 倍超采样后缩小。"""
    return logo(size * S).resize((size, size), Image.LANCZOS)


def check_rgba(size: int) -> Image.Image:
    """完成页的绿色圆底白色对勾（效果图 .ok：44px 圆、#248a3d）。"""
    big = Image.new("RGBA", (size * S, size * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.ellipse((0, 0, size * S - 1, size * S - 1), fill=SUCCESS + (255,))
    u = size * S / 44
    d.line(
        [(13 * u, 22.5 * u), (19.5 * u, 29 * u), (31.5 * u, 16 * u)],
        fill=(255, 255, 255, 255),
        width=max(1, round(3.4 * u)),
        joint="curve",
    )
    return big.resize((size, size), Image.LANCZOS)


def steps_rgba(step: int, scale: float) -> Image.Image:
    """右上角步骤指示（效果图 .dot：6px 圆点，当前步为 16px 胶囊，间距 6px），共 40×6。"""
    w, h = round(40 * scale), round(6 * scale)
    big = Image.new("RGBA", (w * S, h * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    x = 0.0
    k = w * S / 40
    for i in (1, 2, 3):
        dw = 16 if i == step else 6
        d.rounded_rectangle(
            (x * k, 0, (x + dw) * k - 1, h * S - 1),
            radius=h * S / 2,
            fill=(DOT_ON if i == step else DOT_OFF) + (255,),
        )
        x += dw + 6
    return big.resize((w, h), Image.LANCZOS)


def on_white(img: Image.Image) -> Image.Image:
    base = Image.new("RGBA", img.size, WHITE + (255,))
    base.alpha_composite(img)
    return base.convert("RGB")


def wizard_art() -> None:
    for scale, suffix in SCALES:
        icon_rgba(round(40 * scale)).save(ART / f"setup-icon-40{suffix}.png")
        icon_rgba(round(72 * scale)).save(ART / f"setup-icon-72{suffix}.png")
        check_rgba(round(44 * scale)).save(ART / f"setup-check-44{suffix}.png")
        for step in (1, 2, 3):
            steps_rgba(step, scale).save(ART / f"setup-steps-{step}{suffix}.png")
    Image.new("RGB", (1, 1), LINE).save(ART / "setup-line.png")

    on_white(icon_rgba(40)).save(ART / "msi-icon-40.bmp", format="BMP")
    on_white(icon_rgba(72)).save(ART / "msi-icon-72.bmp", format="BMP")
    on_white(check_rgba(44)).save(ART / "msi-check-44.bmp", format="BMP")
    for step in (1, 2, 3):
        on_white(steps_rgba(step, 1.0)).save(ART / f"msi-steps-{step}.bmp", format="BMP")
    Image.new("RGB", (4, 4), LINE).save(ART / "msi-line.bmp", format="BMP")
    Image.new("RGB", (8, 8), WHITE).save(ART / "msi-white.bmp", format="BMP")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--cjk")
    p.add_argument("--latin")
    a = p.parse_args()
    wizard_art()
    if not (a.cjk and a.latin):
        return
    fonts = (ImageFont.truetype(a.cjk, 22 * S), ImageFont.truetype(a.latin, 13 * S))

    # MSI 欢迎 / 完成页背景 493×312：左 164 像素为侧栏，其余白色（WixUI 在右侧绘制文字）
    img = canvas(493, 312, WHITE)
    side = canvas(164, 312, SIDEBAR_BG)
    sidebar(side, 164, 312, fonts)
    img.alpha_composite(side, (0, 0))
    finish(img, 493, 312, "wix-dialog.bmp")

    # MSI 页眉 493×58：白底，标志靠右（WixUI 在左侧绘制标题）
    img = canvas(493, 58, WHITE)
    mark = logo(38 * S)
    img.alpha_composite(mark, ((493 - 14) * S - mark.width, (58 * S - mark.height) // 2))
    finish(img, 493, 58, "wix-banner.bmp")



if __name__ == "__main__":
    main()

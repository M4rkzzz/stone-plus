"""Generate the Stone+ GitHub social preview from repository brand assets.

Requires Pillow and writes docs/media/social-preview.png at 1280x640.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "media" / "social-preview.png"
WIDTH, HEIGHT = 1280, 640


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    windows_fonts = Path("C:/Windows/Fonts")
    candidates = {
        "regular": [windows_fonts / "segoeui.ttf", windows_fonts / "msyh.ttc"],
        "bold": [windows_fonts / "segoeuib.ttf", windows_fonts / "msyhbd.ttc"],
    }[name]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default(size=size)


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius, fill=255)
    return mask


def fit_inside(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    copy = image.copy()
    copy.thumbnail(size, Image.Resampling.LANCZOS)
    return copy


def draw_pill(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str) -> int:
    text_font = font("bold", 15)
    left, top = xy
    bounds = draw.textbbox((0, 0), text, font=text_font)
    width = bounds[2] - bounds[0] + 30
    draw.rounded_rectangle(
        (left, top, left + width, top + 36),
        radius=18,
        fill=(20, 48, 41, 230),
        outline=(52, 112, 93, 180),
        width=1,
    )
    draw.ellipse((left + 12, top + 14, left + 20, top + 22), fill="#69c5a4")
    draw.text((left + 25, top + 8), text, font=text_font, fill="#e8f4ef")
    return width


def main() -> None:
    canvas = Image.new("RGB", (WIDTH, HEIGHT), "#091512")
    pixels = canvas.load()

    # Subtle vertical gradient in Stone+'s deep green palette.
    for y in range(HEIGHT):
        blend = y / (HEIGHT - 1)
        for x in range(WIDTH):
            side_glow = max(0.0, 1.0 - abs(x - 930) / 760)
            pixels[x, y] = (
                int(8 + 3 * blend),
                int(21 + 9 * side_glow + 3 * blend),
                int(18 + 7 * side_glow + 2 * blend),
            )

    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rectangle((0, 0, 11, HEIGHT), fill="#2f9a78")
    draw.rectangle((12, 0, WIDTH - 1, HEIGHT - 1), outline=(89, 156, 134, 75), width=1)
    draw.ellipse((870, -230, 1370, 270), fill=(45, 145, 111, 30))
    draw.ellipse((1000, 390, 1370, 760), fill=(33, 102, 81, 34))

    icon = Image.open(ROOT / "build" / "icon.png").convert("RGBA")
    icon = fit_inside(icon, (62, 62))
    canvas.paste(icon, (70, 54), icon)

    draw.text((150, 56), "Stone+", font=font("bold", 34), fill="#f7fbf9")
    draw.text((151, 98), "LOCAL-FIRST AI GATEWAY", font=font("bold", 13), fill="#65c9a6")

    draw.text((70, 170), "One local gateway.", font=font("bold", 48), fill="#f8fbfa")
    draw.text((70, 226), "All your AI coding clients.", font=font("bold", 40), fill="#f8fbfa")
    draw.text(
        (70, 295),
        "Accounts, routing and diagnostics",
        font=font("regular", 18),
        fill="#bbcec7",
    )
    draw.text((70, 320), "— in one desktop app.", font=font("regular", 18), fill="#bbcec7")
    draw.text((70, 360), "Codex  ·  Claude Code  ·  Gemini CLI", font=font("bold", 19), fill="#f0b34f")

    pill_x = 70
    for label in ("Smart routing", "Account pools", "Diagnostics"):
        pill_x += draw_pill(draw, (pill_x, 404), label) + 10

    draw.text((70, 559), "Open source  ·  Windows  ·  macOS  ·  Linux", font=font("bold", 14), fill="#d7e7e1")
    draw.text((70, 591), "github.com/M4rkzzz/stone-plus", font=font("regular", 14), fill="#75bea5")

    screenshot = Image.open(ROOT / "docs" / "screenshots" / "overview.png").convert("RGB")
    screenshot = fit_inside(screenshot, (676, 470))
    shot_x, shot_y = 570, 96

    shadow = Image.new("RGBA", (screenshot.width + 44, screenshot.height + 44), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (22, 22, screenshot.width + 21, screenshot.height + 21),
        radius=15,
        fill=(0, 0, 0, 165),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas.paste(shadow, (shot_x - 22, shot_y - 14), shadow)

    frame = Image.new("RGBA", (screenshot.width + 8, screenshot.height + 8), (247, 251, 249, 255))
    frame_mask = rounded_mask(frame.size, 12)
    frame.putalpha(frame_mask)
    canvas.paste(frame, (shot_x - 4, shot_y - 4), frame)

    screenshot_mask = rounded_mask(screenshot.size, 9)
    canvas.paste(screenshot, (shot_x, shot_y), screenshot_mask)
    draw.rounded_rectangle(
        (shot_x - 4, shot_y - 4, shot_x + screenshot.width + 3, shot_y + screenshot.height + 3),
        radius=12,
        outline=(136, 192, 173, 130),
        width=1,
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUTPUT, "PNG", optimize=True)
    print(f"Wrote {OUTPUT} ({WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    main()

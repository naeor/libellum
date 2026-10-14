#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Markdown -> PDF converter, the reading companion to `md2docx.py`.

The owner asked for this in as many words:

> **"所有的 markdown 文件最好都有一个 word 阅读版……如果可以的话，
> 最好还有个 PDF，PDF 读起来比 word 省心。"**

Why a second converter rather than a DOCX -> PDF step: **there is no LibreOffice,
no pandoc and no wkhtmltopdf on this machine**, and `build-docs.mjs` already
records that the earlier PDF pipeline existed only on a machine that had
LibreOffice. Inventing a dependency that cannot be installed would mean the PDFs
silently stop being regenerated — which is exactly the failure the DOCX generator
was written to avoid. So this goes straight from Markdown, like `md2docx.py`.

⚠️ **Fonts come from the system and are not vendored into the repository.**
The three faces are chosen for what they actually contain:

| 用途 | 字体 | 为什么是它 |
|---|---|---|
| 正文 / 中文 | `C:\\Windows\\Fonts\\simhei.ttf` (黑体) | 单一 TTF、覆盖全部 CJK 与常用符号 |
| 加粗 | `C:\\Windows\\Fonts\\msyhbd.ttc` (微软雅黑粗体) | 黑体没有粗体字重，借雅黑的 |
| 符号回退 | `C:\\Windows\\Fonts\\seguisym.ttf` (Segoe UI Symbol) | **中文黑体没有 `⚠` `☑` `☐`**，而文档里全是 `⚠️` |

That third row is not decoration: the documents use `⚠️` on nearly every
paragraph. Without the fallback they render as tofu boxes. `fpdf2`'s
`set_fallback_fonts` handles it per-character.

Usage:

    python tools/md2pdf.py <input.md> <output.pdf> [--title "文档标题"]
"""
from __future__ import annotations

import os
import re
import sys

from fpdf import FPDF

# --- fonts ------------------------------------------------------------------

FONT_CANDIDATES = {
    "body": [
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\Deng.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
    ],
    "bold": [
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ],
    "symbol": [
        r"C:\Windows\Fonts\seguisym.ttf",
        r"C:\Windows\Fonts\seguisym.ttc",
    ],
}

# --- layout constants (mm) --------------------------------------------------

PAGE_W, PAGE_H = 210.0, 297.0
MARGIN_L = MARGIN_R = 15.0
MARGIN_T = 16.0
MARGIN_B = 16.0
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R

INK = (0x1F, 0x2D, 0x27)
ACCENT = (0x1F, 0x3A, 0x5F)
MUTED = (0x55, 0x55, 0x55)
RULE = (0xC8, 0xD6, 0xCE)
HEADER_BG = (0xEA, 0xF0, 0xF7)
CODE_BG = (0xF4, 0xF6, 0xF5)

MD_LINK = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)$")
SEP_CELL = re.compile(r"^:?-{2,}:?$")

# Glyph-coverage sets, filled in by `register()`. Declared here (rather than
# beside the registration code) because `sanitize` below consults them and is
# defined earlier in the file.
_BODY_CMAP: set[int] = set()
_BOLD_CMAP: set[int] = set()
_SYM_CMAP: set[int] = set()

# `⚠️` is `⚠` + U+FE0F (variation selector). SimHei has neither, Segoe UI Symbol
# has the base character only, so the selector is dropped and it must not be
# allowed to swallow the space that follows.
STRIP = {"\ufe0f": "", "\u200b": "", "\u00a0": " ", "\ufeff": ""}

# ⚠️ **A handful of characters no installed font has**, and they are not
# decorative — `lĭber` / `līber` is the Latin pun the project's name rests on,
# and a missing glyph there turns the argument into a tofu box. Only the ones
# actually absent are folded to their base letter; `ī` is in SimHei and is left
# alone, so the short/long vowel distinction survives wherever it can.
FOLD = {
    "\u012d": "i",  # ĭ  latin small i with breve
    "\u0103": "a",  # ă
    "\u0115": "e",  # ĕ
    "\u014f": "o",  # ŏ
    "\u016d": "u",  # ŭ
    "\u016b": "u",  # ū (only if a font lacks it)
}


def sanitize(text: str) -> str:
    for old, new in STRIP.items():
        text = text.replace(old, new)
    for old, new in FOLD.items():
        if old in text and ord(old) not in _BODY_CMAP and ord(old) not in _SYM_CMAP:
            text = text.replace(old, new)
    return text


def pick(kind: str) -> str | None:
    for path in FONT_CANDIDATES[kind]:
        if os.path.exists(path):
            return path
    return None


class Doc(FPDF):
    """A4 portrait with a footer carrying the title and the page number."""

    def __init__(self, title: str) -> None:
        super().__init__(orientation="P", unit="mm", format=(PAGE_W, PAGE_H))
        self.doc_title = title
        self.set_margins(MARGIN_L, MARGIN_T, MARGIN_R)
        self.set_auto_page_break(True, margin=MARGIN_B)
        self.set_title(title)

    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("body", "", 7.5)
        self.set_text_color(*MUTED)
        self.cell(0, 5, sanitize(f"{self.doc_title}   ·   第 {self.page_no()} 页"), align="C")


def register(pdf: Doc) -> bool:
    """Register the three faces. Returns False if the CJK face is missing.

    ⚠️ **`set_fallback_fonts` is deliberately NOT used.** It looked like the
    obvious answer for `⚠`, and it broke the documents in a way that took a
    rasterised page to notice: after one symbol was drawn through the fallback,
    **the rest of the line silently stopped rendering** — the heading
    "⚠️ 为什么必须**一起**做" came out as a bare `⚠` with the space for the text
    still reserved, so the page *looked* like a layout bug rather than a font one.

    Instead, `font_for()` decides per character which face has the glyph, and
    `write_inline` switches font for the symbols only. Slower, but it renders.
    """
    body = pick("body")
    if body is None:
        return False
    bold = pick("bold") or body
    pdf.add_font("body", "", body)
    pdf.add_font("bold", "", bold)
    symbol = pick("symbol")
    if symbol is not None:
        pdf.add_font("sym", "", symbol)
        global _BODY_CMAP, _BOLD_CMAP, _SYM_CMAP
        _BODY_CMAP = _cmap(body)
        _BOLD_CMAP = _cmap(bold)
        _SYM_CMAP = _cmap(symbol)
    return True


def _cmap(path: str) -> set[int]:
    """The set of code points a font can actually draw."""
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(path, fontNumber=0, lazy=True)
        codes = set(font.getBestCmap().keys())
        font.close()
        return codes
    except Exception:  # noqa: BLE001
        return set()


def font_for(text: str) -> str:
    """Which registered face to draw `text` with: `""`, `"bold"` or `"sym"`.

    ⚠️ **The order is body → symbol → bold, and that is not arbitrary.**

    * A first version tested only the body face, so it sent `•` to Segoe UI
      Symbol even though **SimHei has it** — which is how the bullets in every
      PDF quietly changed typeface.
    * Testing bold *before* symbol looked equally reasonable and was worse:
      `C:\\Windows\\Fonts\\msyhbd.ttc` **advertises `¥ • ² −` in its cmap and then
      draws nothing for them**, so they came out as blank gaps in the middle of
      money amounts. Its cmap cannot be trusted for these; `seguisym.ttf`
      renders the same characters correctly, so the symbol face wins whenever
      it also has the glyph.

    Net rule: prefer the face the text was asked for, fall back to the symbol
    face where it genuinely has the glyph, and keep bold as the last resort.
    """
    if not text:
        return ""
    chars = [ch for ch in text if not ch.isspace()]
    if not chars:
        return ""
    if all(ord(ch) in _BODY_CMAP for ch in chars):
        return ""
    if _SYM_CMAP and all(ord(ch) in _SYM_CMAP for ch in chars):
        return "sym"
    if all(ord(ch) in _BOLD_CMAP for ch in chars):
        return "bold"
    return "sym"


def split_by_font(tok: str, base: str) -> list[tuple[str, str]]:
    """Split one token into (piece, face) runs that can each be drawn as-is.

    **The direction of the switch matters, and it is face → body, one way only.**
    A character that the *requested* face cannot draw is moved to the face
    `font_for` recommends — but a character that face *can* draw is **never
    pulled back** to `base`.

    ⚠️ A previous version decided per-character with a prefixed
    `font_for(tok) == ""` guard, so a token like `¥` — judged to need the symbol
    face — still had its single character routed to `base` (bold), because that
    branch ignored the face `font_for` had just chosen. `msyhbd.ttc` advertises
    `¥` and draws nothing for it, so the amount lost its currency sign.
    """
    face = font_for(tok)
    if face == "" or face == base:
        return [(tok, base)]

    out: list[tuple[str, str]] = []
    cur = ""
    cur_face: str | None = None
    # Whitespace never decides the face: `str.isspace()` is true for `\\u3000`
    # (ideographic space), which the CJK face does not list, and letting that
    # drag a whole token onto another face is how `¥` disappeared once already.
    for ch in tok:
        if ch.isspace():
            this = cur_face or base
        elif ord(ch) in _BODY_CMAP:
            this = base
        else:
            this = face
        if cur_face is None or this == cur_face:
            cur += ch
            cur_face = this
        else:
            out.append((cur, cur_face))
            cur, cur_face = ch, this
    if cur:
        out.append((cur, cur_face or base))
    return out or [(tok, base)]


# --- inline spans -----------------------------------------------------------


def inline_runs(text: str):
    """Split a line into (text, style) where style is 'plain' | 'bold' | 'mono'.

    ⚠️ **Marks nest, and the earlier version did not.** It split on the outer
    `**…**` and emitted the inside as one bold run — so a span like
    `**规则原文在 \\`版本记录（1.10）.md\\` §1。**` kept its backticks and printed
    them. That is not a rare shape: **the documents contain 1378 of them**,
    because bold-with-a-path-inside is how this project writes a reference.

    So this scans left to right and, inside a bold span, still recognises code
    spans (rendered monospace) and links.
    """
    runs: list[tuple[str, str]] = []
    i = 0
    n = len(text)

    while i < n:
        if text.startswith("**", i):
            end = text.find("**", i + 2)
            if end != -1:
                runs.extend(_split_code(text[i + 2 : end], "bold"))
                i = end + 2
                continue
        if text[i] == "`":
            end = text.find("`", i + 1)
            if end != -1:
                runs.append((text[i + 1 : end], "mono"))
                i = end + 1
                continue
        if text[i] == "[":
            m = re.compile(r"\[([^\]]+)\]\(([^)]+)\)").match(text, i)
            if m:
                runs.append((m.group(1), "plain"))
                runs.append((f"（{m.group(2)}）", "mono"))
                i = m.end()
                continue
        # Plain text: consume up to the next marker so runs stay few.
        nxt = min(
            (p for p in (text.find("**", i), text.find("`", i), text.find("[", i)) if p != -1),
            default=n,
        )
        if nxt == i:
            nxt = i + 1
        runs.append((text[i:nxt], "plain"))
        i = nxt

    return [(t, s) for t, s in runs if t] or [(text, "plain")]


def _split_code(inner: str, style: str) -> list[tuple[str, str]]:
    """Inside a bold span, pull out ``code`` runs as mono and keep the rest bold."""
    out: list[tuple[str, str]] = []
    for part in re.split(r"(`[^`]+`)", inner):
        if not part:
            continue
        if part.startswith("`") and part.endswith("`") and len(part) > 2:
            out.append((part[1:-1], "mono"))
        else:
            out.append((part, style))
    return out


def visible_len(text: str) -> float:
    """Rough width in 'character' units: CJK counts double."""
    n = 0.0
    for ch in text:
        n += 2.0 if ord(ch) > 0x2E80 else 1.0
    return n


def write_inline(
    pdf: Doc,
    text: str,
    size: float,
    color=INK,
    pad_l: float = 0.0,
    x: float | None = None,
    width: float | None = None,
) -> float:
    """Write one paragraph, wrapping by measured width, honouring bold/mono.

    ⚠️ **Returns the y the next line would start at, and does not leave the
    cursor mid-line.** `fpdf2`'s `cell()` advances x but never y (verified), so
    every line's position is computed here rather than inherited.

    `x` / `width` override the page column, which is what table cells need (they
    are laid out independently of the page margins).
    """
    text = sanitize(text)
    x0 = pdf.l_margin + pad_l if x is None else x
    avail = (CONTENT_W - pad_l) if width is None else width
    line_h = size * 0.415

    if not text.strip():
        pdf.set_xy(x0, pdf.get_y() + line_h)
        return pdf.get_y()

    # One "token" is an unbreakable run: a single CJK character, a latin word,
    # or a space run. CJK breaks anywhere; latin must not break mid-word.
    tokens: list[tuple[str, str]] = []
    for chunk, style in inline_runs(text):
        for tok in re.findall(
            r"[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]|[^\s\u2E80-\u9FFF]+|\s+", chunk
        ):
            tokens.append((tok, style))

    y = pdf.get_y()
    cur_x = x0
    rendered = 1
    for tok, style in tokens:
        base = "bold" if style == "bold" else "body"
        fsize = size * 0.94 if style == "mono" else size
        if tok.isspace():
            if cur_x > x0:
                pdf.set_font(base, "", fsize)
                cur_x += pdf.get_string_width(" ")
            continue
        # ⚠️ **A single token can mix scripts**, because the tokenizer treats a
        # run of non-CJK characters as one unit — so `；`+`；` and latin text and
        # CJK punctuation can land together. Grouping by *calculated width* then
        # split the token wherever the required face changes; otherwise one
        # missing glyph drags the whole token onto the symbol face, and the
        # punctuation inside it disappears.
        for piece, face in split_by_font(tok, base):
            pdf.set_font(face, "", fsize)
            pdf.set_text_color(*(MUTED if style == "mono" else color))
            w = pdf.get_string_width(piece)
            if cur_x + w > x0 + avail and cur_x > x0:
                y += line_h
                rendered += 1
                cur_x = x0
            if y + line_h > PAGE_H - MARGIN_B:
                pdf.add_page()
                y = pdf.get_y()
            pdf.set_xy(cur_x, y)
            pdf.cell(w, line_h, piece)
            cur_x += w

    # ⚠️ **Advance by the number of lines actually drawn.** This used to advance
    # by exactly one line height no matter how many lines were rendered, so
    # every single-line block overlapped the next one by a hair and the error
    # accumulated down the page — three consecutive one-line bullets came out
    # printed on top of each other.
    y += line_h * (rendered - 1) + line_h * 1.18
    pdf.set_xy(pdf.l_margin, y)
    return y
    return y


def write_rich(pdf: Doc, text: str, size: float, color=INK, pad_l: float = 0.0) -> float:
    """`write_inline`, with a hard fallback if a single unbreakable token is
    wider than the line (a long URL or a code identifier in a narrow table
    cell) — the line is then cut by measured width instead of overflowing."""
    x0 = pdf.l_margin + pad_l
    avail = CONTENT_W - pad_l
    pdf.set_font("body", "", size)
    longest = max((pdf.get_string_width(t) for t in sanitize(text).split() or [""]), default=0)
    if longest > avail:
        text = break_long_tokens(pdf, sanitize(text), avail, size)
    return write_inline(pdf, text, size, color, pad_l)


def break_long_tokens(pdf: Doc, text: str, avail: float, size: float) -> str:
    """Insert spaces into tokens that cannot fit, so wrapping has somewhere to
    break. Only used as a last resort."""
    out = []
    for tok in text.split(" "):
        pdf.set_font("body", "", size)
        if pdf.get_string_width(tok) <= avail:
            out.append(tok)
            continue
        piece = ""
        for ch in tok:
            if pdf.get_string_width(piece + ch) > avail:
                out.append(piece)
                piece = ch
            else:
                piece += ch
        if piece:
            out.append(piece)
    return " ".join(out)


# --- block elements ---------------------------------------------------------


def rule(pdf: Doc, pad: float = 2.0) -> None:
    pdf.ln(pad)
    y = pdf.get_y()
    pdf.set_draw_color(*RULE)
    pdf.set_line_width(0.25)
    pdf.line(MARGIN_L, y, PAGE_W - MARGIN_R, y)
    pdf.ln(pad + 1.6)


def heading(pdf: Doc, level: int, text: str, first: bool) -> None:
    sizes = {1: 17.0, 2: 13.5, 3: 12.0, 4: 11.0, 5: 10.5, 6: 10.5}
    size = sizes.get(level, 10.5)
    if first and level == 1:
        pdf.ln(4)
        write_inline(pdf, text, 21.0, ACCENT)
        rule(pdf, 2.6)
        return
    # ⚠️ A *second* level-1 heading keeps the level-1 size (`效果：17.0`), rather
    # than being shrunk as though it were a sub-heading. The document title above
    # is styled as a title, not as "heading level 0", so `#` stays `#`.
    pdf.ln(3.4 if level <= 2 else 2.2)
    if pdf.get_y() > PAGE_H - MARGIN_B - 30:
        pdf.add_page()
    write_inline(pdf, text, size, ACCENT)


def quote(pdf: Doc, text: str) -> None:
    """A light panel with a left rule.

    ⚠️ **Rendered through `write_inline`, not `multi_cell`.** `multi_cell` takes
    the raw string, so `**bold**` and `` `code` `` came out as literal asterisks
    and backticks — and the documents put nearly everything important inside a
    quote.
    """
    if not text.strip():
        pdf.ln(1.6)
        return
    size = 9.6
    pad = 5.0
    inner = CONTENT_W - pad * 2 - 3.0

    # Measure first, so the panel can be drawn behind the text.
    pdf.set_font("body", "", size)
    probe = FPDF(orientation="P", unit="mm", format=(PAGE_W, PAGE_H))
    probe.add_font("body", "", pick("body") or "")
    probe.set_margins(pad, 0, 0)
    probe.add_page()
    probe.set_font("body", "", size)
    lines = 0
    cur = ""
    for ch in sanitize(strip_md(text)):
        if probe.get_string_width(cur + ch) > inner:
            lines += 1
            cur = ch
        else:
            cur += ch
    lines += 1
    h = lines * (size * 0.415) * 1.18 + 3.0

    if pdf.get_y() + h > PAGE_H - MARGIN_B:
        pdf.add_page()
    x, y = MARGIN_L + 3.0, pdf.get_y()
    pdf.set_fill_color(0xF7, 0xFA, 0xF8)
    pdf.rect(x, y, CONTENT_W - 3.0, h, style="F")
    pdf.set_draw_color(0x9C, 0xBE, 0xAA)
    pdf.set_line_width(0.8)
    pdf.line(x, y, x, y + h)
    pdf.set_xy(MARGIN_L, y + 1.5)
    end = write_inline(pdf, text, size, MUTED, pad_l=6.0)
    pdf.set_xy(MARGIN_L, max(end, y + h) + 1.2)


def strip_md(text: str) -> str:
    """Drop markdown markers, for width measurement only."""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text.replace("**", "").replace("`", "").replace("~~", "")


def code_block(pdf: Doc, lines: list[str]) -> None:
    pdf.set_font("body", "", 8.2)
    cleaned = [sanitize(ln) if ln.strip() else " " for ln in lines]
    wrapped: list[str] = []
    for ln in cleaned:
        while len(ln) > 108:
            wrapped.append(ln[:108])
            ln = ln[108:]
        wrapped.append(ln)
    h = 3.6 * len(wrapped) + 3.2
    if pdf.get_y() + min(h, 60) > PAGE_H - MARGIN_B:
        pdf.add_page()
    x, y = MARGIN_L, pdf.get_y()
    pdf.set_fill_color(*CODE_BG)
    pdf.rect(x, y, CONTENT_W, h, style="F")
    pdf.set_xy(x + 2.2, y + 1.6)
    pdf.set_text_color(0x33, 0x3D, 0x38)
    for i, ln in enumerate(wrapped):
        if pdf.get_y() > PAGE_H - MARGIN_B - 4:
            pdf.add_page()
            pdf.set_xy(x + 2.2, pdf.get_y())
        pdf.cell(0, 3.6, ln, new_x="LMARGIN", new_y="NEXT")
        if i < len(wrapped) - 1:
            pdf.set_x(x + 2.2)
    pdf.set_xy(MARGIN_L, y + h + 2.0)


def bullet(pdf: Doc, text: str, marker: str) -> None:
    # ⚠️ The marker gets the same face check as body text: `•` is in SimHei but
    # NOT in the bold face, and `☑`/`☐` are in neither — hard-coding "body" here
    # was what left `•` reported as a missing glyph on almost every document.
    pdf.set_font(font_for(marker) or "body", "", 10.2)
    pdf.set_text_color(*INK)
    x = MARGIN_L + 1.5
    pdf.set_xy(x, pdf.get_y())
    pdf.cell(4.6, 4.4, sanitize(marker))
    pdf.set_xy(x + 4.6, pdf.get_y())
    write_inline(pdf, text, 10.2, INK, pad_l=6.1)


def parse_table_row(line: str) -> list[str]:
    """Split one Markdown table row into cells.

    ⚠️ **`\\|` is an escaped pipe, not a cell break.** Splitting on every `|`
    tore a cell like ``显式 `\\| undefined` `` in half and left a stray backslash
    and an unbalanced backtick in both halves — which is exactly what showed up
    in the handover PDF's §3.2 table.
    """
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    cells = re.split(r"(?<!\\)\|", body)
    return [c.strip().replace("\\|", "|") for c in cells]


def add_table(pdf: Doc, rows: list[list[str]]) -> None:
    if not rows:
        return
    ncols = max(len(r) for r in rows)
    rows = [r + [""] * (ncols - len(r)) for r in rows]

    size = 8.0 if ncols <= 4 else (7.2 if ncols <= 6 else 6.4)
    pad = 0.9
    line_h = size * 0.44

    # Column widths weighted by the widest cell, with a floor so a narrow column
    # does not collapse to nothing.
    weights = []
    for c in range(ncols):
        weights.append(max(visible_len(rows[r][c]) for r in range(len(rows))) or 1.0)
    total = sum(weights)
    widths = [max(CONTENT_W * w / total, 9.0) for w in weights]
    scale = CONTENT_W / sum(widths)
    widths = [w * scale for w in widths]

    pdf.set_font("body", "", size)

    def cell_lines(text: str, width: float) -> list[str]:
        """Break a cell into display lines.

        ⚠️ Measured on the **marker-stripped** text, and each line is later
        rendered rich. Measuring the raw string made every cell containing
        `**bold**` or `` `code` `` reserve width for backticks and asterisks it
        would never draw, so lines broke far too early.
        """
        words = re.findall(
            r"[\u2E80-\u9FFF]|[^\s\u2E80-\u9FFF]+|\s+", sanitize(strip_md(text))
        )
        out, cur = [], ""
        for w in words:
            trial = cur + w
            if pdf.get_string_width(trial) > width - pad * 2 and cur:
                out.append(cur)
                cur = w.lstrip()
            else:
                cur = trial
        out.append(cur)
        return out or [""]

    for ri, row in enumerate(rows):
        wrapped = [cell_lines(row[c], widths[c]) for c in range(ncols)]
        row_h = max(len(w) for w in wrapped) * line_h + pad * 2
        if pdf.get_y() + row_h > PAGE_H - MARGIN_B:
            pdf.add_page()
        x, y = MARGIN_L, pdf.get_y()
        if ri == 0:
            pdf.set_fill_color(*HEADER_BG)
            pdf.rect(x, y, CONTENT_W, row_h, style="F")
        pdf.set_draw_color(*RULE)
        pdf.set_line_width(0.18)
        cx = x
        for c in range(ncols):
            pdf.rect(cx, y, widths[c], row_h)
            # Header cells are drawn bold; a cell's own `**` still applies.
            text = row[c] if ri else f"**{strip_md(row[c])}**"
            pdf.set_xy(cx + pad, y + pad)
            write_inline(
                pdf,
                text,
                size,
                ACCENT if ri == 0 else INK,
                x=cx + pad,
                width=widths[c] - pad * 2,
            )
            pdf.set_xy(MARGIN_L, y)
            cx += widths[c]
        pdf.set_xy(MARGIN_L, y + row_h)
    pdf.ln(2.0)


# --- main conversion --------------------------------------------------------


def join_continued(
    lines: list[str], i: int, strip_prefix: str = "", quote: bool = False
) -> tuple[str, int]:
    """Join a block that Markdown wrapped across several source lines.

    ⚠️ **The documents wrap source lines inside `**…**`**, so a bold sentence
    arrives as two paragraphs. Rendered line by line, the marker never closes and
    the asterisks print literally — that is what put `**` on three lines of the
    handover PDF. This keeps pulling lines while a span is still open, and stops
    at a blank line, a new block marker, or a closing fence.

    Returns (joined text, next index).
    """
    if quote:
        buf = []
        while i < len(lines) and lines[i].strip().startswith(">"):
            buf.append(lines[i].strip().lstrip(">").strip())
            if balanced(buf):
                i += 1
                break
            i += 1
        return " ".join(buf), i

    first = lines[i]
    text = first[len(strip_prefix) :].strip() if first.startswith(strip_prefix) else first.strip()
    buf = [text]
    i += 1
    while not balanced(buf) and i < len(lines):
        nxt = lines[i].strip()
        if (
            not nxt
            or nxt.startswith(("#", ">", "|", "```"))
            or re.match(r"^([-*]|\d+\.)\s", nxt)
        ):
            break
        buf.append(nxt)
        i += 1
    return " ".join(buf), i


def balanced(parts: list[str]) -> bool:
    """True when no `**` or backtick span is left open."""
    blob = " ".join(parts)
    return blob.count("**") % 2 == 0 and blob.count("`") % 2 == 0


def convert(md_text: str, out_path: str, title: str) -> None:
    pdf = Doc(title)
    if not register(pdf):
        raise SystemExit("找不到可用的中文字体，PDF 未生成。")
    pdf.add_page()

    lines = md_text.splitlines()
    i = 0
    first_heading = True
    in_code = False
    code_buf: list[str] = []

    while i < len(lines):
        raw = lines[i].rstrip()
        stripped = raw.strip()

        if stripped.startswith("```"):
            if in_code:
                code_block(pdf, code_buf)
                code_buf, in_code = [], False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(raw)
            i += 1
            continue

        if not stripped or stripped.startswith("<!--"):
            i += 1
            continue

        if set(stripped) <= {"-", " "} and len(stripped) >= 3:
            rule(pdf)
            i += 1
            continue

        if stripped.startswith("|"):
            block = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i])
                i += 1
            rows = []
            for k, bl in enumerate(block):
                cells = parse_table_row(bl)
                if k == 1 and all(SEP_CELL.match(c) for c in cells if c):
                    continue
                rows.append(cells)
            add_table(pdf, rows)
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            heading(pdf, len(m.group(1)), m.group(2).strip(), first_heading)
            first_heading = False
            i += 1
            continue

        if stripped.startswith(">"):
            text, i = join_continued(lines, i, quote=True)
            quote(pdf, text)
            continue

        m = re.match(r"^(\s*)[-*]\s+(.*)$", raw)
        if m:
            text, i = join_continued(lines, i, strip_prefix=m.group(1) + "- ")
            if text.startswith("[ ]"):
                bullet(pdf, text[3:].strip(), "☐")
            elif text.lower().startswith("[x]"):
                bullet(pdf, text[3:].strip(), "☑")
            else:
                bullet(pdf, text, "•")
            continue

        m = re.match(r"^\s*(\d+)\.\s+(.*)$", raw)
        if m:
            bullet(pdf, m.group(2).strip(), f"{m.group(1)}.")
            i += 1
            continue

        text, i = join_continued(lines, i)
        write_inline(pdf, text, 10.2, INK)

    pdf.output(out_path)
    print(f"OK -> {out_path}")


def main() -> None:
    args = list(sys.argv[1:])
    title = "Libevra"
    if "--title" in args:
        k = args.index("--title")
        title = args[k + 1]
        del args[k : k + 2]
    if len(args) < 2:
        raise SystemExit(__doc__)
    src, dst = args[0], args[1]
    with open(src, encoding="utf-8") as fh:
        convert(fh.read(), dst, title)


if __name__ == "__main__":
    main()

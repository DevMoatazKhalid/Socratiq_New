"""Repair LaTeX that a JSON decoder turned into control characters.

The Coach reply is a structured (JSON) model output. A model that writes single-backslash LaTeX inside a JSON string produces valid JSON escapes
for a handful of commands, which the decoder silently turns into control characters:

    \\frac  -> FORM FEED + "rac"        \\beta / \\begin -> BACKSPACE + "eta" / "egin"
    \\right -> CARRIAGE RETURN + "ight" \\theta / \\times / \\text -> TAB + "heta" / ...
    \\nabla / \\neq -> LINE FEED + "abla" / "eq"

KaTeX then cannot parse the formula and the student sees broken source instead of typeset maths. This module restores the backslash. It is
deliberately conservative: TAB / CR repairs only fire before a known command name that is not followed by more letters, LINE FEED repairs only
inside a maths span (a newline is ordinary text everywhere else), and fenced / inline code is never touched (a tab in code is a tab).
"""
from __future__ import annotations

import re
from typing import Any

_FF = "\x0c"
_BS = "\x08"
# suffixes = command name without its first letter; each must not be followed by another letter
_T_SUFFIX = r"(?:heta|imes|extbf|extit|extrm|extsf|exttt|extstyle|ext|anh|an|au|o|ilde|op|riangle|frac|binom|herefore|ag|imes)(?![A-Za-z])"
_R_SUFFIX = r"(?:ightarrow|ightleftharpoons|ight|ho|angle|ceil|floor|m|Vert|vert|estriction)(?![A-Za-z])"
# \nabla, \neq ... are unambiguous; the short \ne, \ni, \nu, \not, \neg are only repaired after a space/operator (as in "a \neq b"), never
# at the start of a line, where "e^{i\pi}" or "u = 2" may legitimately begin
_N_LONG = r"(?:abla|eq|otin|ewline|exists|mid|leq|geq|parallel|subseteq|Rightarrow|onumber|otag|leftarrow|rightarrow)(?![A-Za-z])"
_N_SHORT = r"(?:e|ot|eg|u|i)(?![A-Za-z])"

_TAB = re.compile("\t(?=" + _T_SUFFIX + ")")
_CR = re.compile("\r(?=" + _R_SUFFIX + ")")
_LF = re.compile("\n(?=" + _N_LONG + ")|(?<=[ ({=&,+\\-])\n(?=" + _N_SHORT + ")")
_CODE = re.compile(r"(```[\s\S]*?```|`[^`\n]+`)")
# maths spans as the chat renderer recognises them (frontend/src/lib/mathText.ts); \[ and \( may also arrive double-escaped
_SPAN = re.compile(r"(\$\$[\s\S]+?\$\$|\\\\?\[[\s\S]+?\\\\?\]|\\\\?\([\s\S]+?\\\\?\)|\\begin\{[A-Za-z*]+\}[\s\S]+?\\end\{[A-Za-z*]+\}|(?<![\\$])\$(?=\S)[^$\n]+?(?<=\S)\$)")


def _repair_prose(text: str) -> str:
    if _FF in text:
        text = text.replace(_FF, "\\f")
    if _BS in text:
        text = text.replace(_BS, "\\b")
    if "\t" in text:
        text = _TAB.sub(r"\\t", text)
    if "\r" in text:
        text = _CR.sub(r"\\r", text)
    if "\n" in text:
        text = _SPAN.sub(lambda m: _LF.sub(r"\\n", m.group(0)), text)
    return text


def repair_latex_escapes(text: Any) -> Any:
    """Return `text` with JSON-mangled LaTeX restored. Non-strings are returned unchanged; text without control characters is returned as is."""
    if not isinstance(text, str) or not text:
        return text
    if not any(c in text for c in (_FF, _BS, "\t", "\r", "\n")):
        return text
    parts = _CODE.split(text)
    # split with one capture group: even indexes are prose, odd indexes are code (kept byte for byte)
    return "".join(p if i % 2 else _repair_prose(p) for i, p in enumerate(parts))


def repair_latex_in(value: Any, _depth: int = 0) -> Any:
    """Apply `repair_latex_escapes` to every string inside a JSON-like structure (board actions, visual plans)."""
    if _depth > 8:
        return value
    if isinstance(value, str):
        return repair_latex_escapes(value)
    if isinstance(value, list):
        return [repair_latex_in(v, _depth + 1) for v in value]
    if isinstance(value, dict):
        return {k: repair_latex_in(v, _depth + 1) for k, v in value.items()}
    return value


def _equation_field(latex: str) -> str:
    """A board equation is LaTeX with no delimiters: LINE FEED can only be a mangled command there when a command name follows it."""
    return _LF.sub(r"\\n", repair_latex_escapes(latex))


def repair_board_actions(actions: Any) -> Any:
    """Board actions carry bare LaTeX in `latex` fields (no $ delimiters), so the newline repair applies to the whole field."""
    fixed = repair_latex_in(actions)
    if isinstance(fixed, list):
        for a in fixed:
            if isinstance(a, dict) and isinstance(a.get("latex"), str):
                a["latex"] = _equation_field(a["latex"])
    return fixed

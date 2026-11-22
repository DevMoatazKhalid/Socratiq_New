"""LaTeX written with single backslashes inside a JSON model output must reach the student as LaTeX, not as control characters."""
import json

from ai.agents.coach.schemas import GeneratedResponse, ValidationResult
from ai.guardrails.latex_repair import repair_board_actions, repair_latex_escapes

# The model wrote \frac and \right with ONE backslash inside the JSON string: valid JSON, but \f and \r are escapes for form feed / CR.
MANGLED = json.loads(
    '{"response": "Order and degree:\\n\\\\[\\n\\\\left(\\frac{d^{2}y}{dx^{2}}\\right)^{4}=y+\\\\left(\\frac{dy}{dx}\\right)^{6}\\n\\\\]"}'
)["response"]
EXPECTED = "Order and degree:\n\\[\n\\left(\\frac{d^{2}y}{dx^{2}}\\right)^{4}=y+\\left(\\frac{dy}{dx}\\right)^{6}\n\\]"


def test_the_reported_equation_is_restored():
    assert "\x0c" in MANGLED and "\r" in MANGLED
    assert repair_latex_escapes(MANGLED) == EXPECTED


def test_every_structured_reply_is_repaired_at_the_schema():
    assert GeneratedResponse(response=MANGLED).response == EXPECTED
    assert ValidationResult(passes=False, revised_response=MANGLED).revised_response == EXPECTED


def test_tab_backspace_and_newline_commands_inside_maths():
    dec = json.loads(
        '{"r": "Angle $\\theta \\times 2$, $\\beta$, $$\\begin{aligned} a &\\neq b \\\\\\\\ \\nabla f \\\\end{aligned}$$ and \\\\(\\nu\\\\)"}'
    )["r"]
    assert repair_latex_escapes(dec) == (
        "Angle $\\theta \\times 2$, $\\beta$, $$\\begin{aligned} a &\\neq b \\\\ \\nabla f \\end{aligned}$$ and \\(\\nu\\)"
    )


def test_ordinary_text_and_code_are_never_changed():
    s = "Line one\nnot math\r\nequation next\n```py\n\tto = 1\n\ttheta = 2\n```\n`a\tb`"
    assert repair_latex_escapes(s) == s
    assert repair_latex_escapes("plain") == "plain"
    assert repair_latex_escapes(None) is None


def test_board_equations_have_no_delimiters_but_are_repaired_too():
    acts = repair_board_actions([{"action": "add_equation", "latex": "x \neq y + \frac{1}{2}"}, {"action": "add_text", "text": "next\nnotes"}])
    assert acts[0]["latex"] == "x \\neq y + \\frac{1}{2}"
    assert acts[1]["text"] == "next\nnotes"
    assert GeneratedResponse(response="ok", board_actions=[{"action": "add_equation", "latex": "\frac{a}{b}"}]).board_actions[0]["latex"] == "\\frac{a}{b}"


def test_a_display_formula_that_starts_with_e_or_u_is_left_alone():
    s = "$$\ne^{i\\pi} + 1 = 0\n$$ and $$\nu = 2\n$$"
    assert repair_latex_escapes(s) == s

from app.runtime.citations import next_turn, render

SOURCES = [
    {
        "ref": "turn0search0",
        "turn": 0,
        "title": "Quote Investigator",
        "url": "https://qi.example/insanity",
    },
    {
        "ref": "turn0search1",
        "turn": 0,
        "title": "Wikipedia",
        "url": "https://wiki.example/Insanity",
    },
    {"ref": "turn1fetch0", "turn": 1, "title": "Page", "url": "https://page.example/"},
]


def test_citations_become_numbered_links_with_a_source_list():
    text = (
        "Often attributed to Einstein. citeturn0search1turn0search0\n"
        "Again citeturn0search0turn9search9 here."
    )
    out = render(text, SOURCES)
    assert (
        "Einstein. [[1]](https://wiki.example/Insanity) [[2]](https://qi.example/insanity)" in out
    )
    assert "Again [[2]](https://qi.example/insanity) here." in out  # unknown ref dropped
    assert out.endswith(
        "**Sources**\n\n1. [Wikipedia](https://wiki.example/Insanity)\n"
        "2. [Quote Investigator](https://qi.example/insanity)\n"
    )
    assert "" not in out and "turn0" not in out


def test_other_markup_and_text_without_sources():
    assert render('Hi entity["people","Albert Einstein","physicist"]!') == (
        "Hi Albert Einstein!"
    )
    assert render("Doubtful. citeturn0search3") == "Doubtful. "
    assert render("cut off citetur") == "cut off "
    plain = "No markup here . Even odd spacing ."
    assert render(plain, SOURCES) == plain


def test_next_turn():
    assert next_turn([]) == 0
    assert next_turn(SOURCES) == 2

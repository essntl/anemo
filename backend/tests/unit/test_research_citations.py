from app.features.research.citations import CitedSource, cite, source_list

SOURCES = [
    CitedSource(1, "Climate report", "https://ipcc.example/ar6"),
    CitedSource(
        2, "", "https://news.example/a b(1)", kind="pdf", note="p. 12, key table", key=True
    ),
    CitedSource(3, "A [bracketed] title", "https://blog.example/x", kind="youtube"),
]


def test_markers_become_links():
    assert cite("Warming is 1.1 °C [S1].", SOURCES) == (
        "Warming is 1.1 °C ([Climate report](https://ipcc.example/ar6))."
    )


def test_several_and_adjacent_markers_merge_into_one_parenthesis():
    expected = (
        "Both agree ([Climate report](https://ipcc.example/ar6); "
        "[A (bracketed) title](https://blog.example/x))."
    )
    assert cite("Both agree [S1, S3].", SOURCES) == expected
    assert cite("Both agree [S1][S3].", SOURCES) == expected


def test_a_source_without_title_uses_its_site_and_urls_are_escaped():
    assert cite("See [S2].", SOURCES) == "See ([news.example](https://news.example/a%20b%281%29))."


def test_unknown_markers_are_dropped_and_real_links_left_alone():
    assert cite("Made up [S9]. Real [x](https://y.example) [S1]", SOURCES) == (
        "Made up. Real [x](https://y.example) ([Climate report](https://ipcc.example/ar6))"
    )


def test_the_source_list_is_written_by_code():
    assert source_list(SOURCES) == (
        "## Sources\n\n"
        "1. [Climate report](https://ipcc.example/ar6)\n"
        "2. [news.example](https://news.example/a%20b%281%29) (key source, PDF)"
        " — p. 12, key table\n"
        "3. [A (bracketed) title](https://blog.example/x) (video)\n"
    )


def test_the_source_count_reads_right() -> None:
    from app.runtime.research_writeup import count_label

    assert count_label(1) == "1 source"
    assert count_label(2) == "2 sources"

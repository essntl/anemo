"""What the phone reads out: an answer without Markdown, shortened at a sentence end."""

from app.features.voice import speech


def test_markdown_is_taken_out():
    text, left_out = speech.plain(
        "## Friday\n\n"
        "I moved the **meeting** to [Friday](https://example.com/cal) at 10 [1].\n\n"
        "- Email *Tim* about it\n"
        "1. Check `snake_case_name`\n"
        "> A quote\n\n"
        "---\n"
        "See https://example.com for more.\n"
        "![a chart](https://example.com/c.png)\n"
    )
    assert text == (
        "Friday. I moved the meeting to Friday at 10. Email Tim about it. "
        "Check snake_case_name. A quote. See for more."
    )
    assert left_out is False


def test_code_is_left_out_and_tables_are_read_by_cell():
    text, left_out = speech.plain(
        "Here it is:\n\n```python\nprint('hi')\n```\n\n| Day | Plan |\n|---|---|\n| Mon | Gym |\n"
    )
    assert text == "Here it is: Day, Plan. Mon, Gym."
    assert left_out is True


def test_a_short_answer_is_read_in_full():
    spoken = speech.shorten("Done. I added **milk** to your list.", 600)
    assert spoken == speech.Spoken("Done. I added milk to your list.", False)


def test_a_long_answer_is_cut_at_a_sentence_end_near_the_limit():
    answer = " ".join(f"Sentence number {i} is here." for i in range(60))
    spoken = speech.shorten(answer, 600)
    assert spoken.more is True
    assert spoken.text.endswith("is here. The rest is in the chat.")
    said = spoken.text.removesuffix(" " + speech.REST_IN_CHAT)
    assert 300 <= len(said) <= 600
    assert answer.startswith(said)


def test_without_a_sentence_end_near_the_limit_it_cuts_at_a_word():
    spoken = speech.shorten("word " * 200, 100)
    assert spoken.more is True
    said = spoken.text.removesuffix(" " + speech.REST_IN_CHAT)
    assert said.endswith("word…") and len(said) <= 101


def test_an_answer_that_was_all_code_says_where_it_is():
    spoken = speech.shorten("```\nls -la\n```", 600)
    assert spoken == speech.Spoken(speech.NOTHING_TO_SAY, True)
    assert speech.shorten("", 600) == speech.Spoken(speech.NOTHING_TO_SAY, False)


def test_code_left_out_of_a_short_answer_points_to_the_chat():
    spoken = speech.shorten("Run this:\n\n```\nmake test\n```", 600)
    assert spoken == speech.Spoken("Run this: The rest is in the chat.", True)


def test_runs_that_did_not_complete_get_one_sentence():
    assert speech.for_run("failed", "half an answer", 600) == speech.Spoken(speech.FAILED, False)
    assert speech.for_run("cancelled", "", 600) == speech.Spoken(speech.CANCELLED, False)
    assert speech.for_run("completed", "Yes.", 600) == speech.Spoken("Yes.", False)

"""The file names images get on the computer (docs/specs/code-sessions.md §13)."""

from app.features.code_sessions import images


def test_a_file_name_keeps_only_safe_characters_and_the_real_type():
    assert images.file_name(1, "Screenshot 2026-11-24.png", "image/png") == (
        "1-Screenshot-2026-11-24.png"
    )
    # The extension is the image's real type, not the one in the name.
    assert images.file_name(2, "photo.PNG", "image/jpeg") == "2-photo.jpg"
    # No path, no leading dot, nothing a shell or Windows would read as special.
    assert images.file_name(3, "..\\..\\evil;rm -rf $HOME.webp", "image/webp") == (
        "3-evil-rm-rf-HOME.webp"
    )
    assert images.file_name(4, "../../.hidden.gif", "image/gif") == "4-hidden.gif"
    assert images.file_name(5, "Знімок екрана.png", "image/png") == "5-image.png"
    assert images.file_name(6, "", "image/png") == "6-image.png"
    long = images.file_name(7, "a" * 300 + ".png", "image/png")
    assert long == "7-" + "a" * images.MAX_STEM + ".png"
    for name in ("1-Screenshot-2026-11-24.png", long, "3-evil-rm-rf-HOME.webp"):
        assert images.NAME.match(name)


def test_stored_refs_are_read_defensively():
    assert images.refs([{"id": "a", "name": "1-x.png"}, {"name": "no id"}, "odd", {"id": 3}]) == [
        {"id": "a", "name": "1-x.png"}
    ]
    assert images.refs(None) == []

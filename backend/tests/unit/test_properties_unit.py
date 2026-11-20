"""Properties without a database: front matter, near-duplicates and the filter SQL."""

import pytest
from sqlalchemy.dialects import postgresql

from app.core.errors import AppError
from app.features.documents.models import Document
from app.features.properties import frontmatter
from app.features.properties.filters import property_conditions
from app.features.properties.service import is_near, normalise


def test_front_matter_is_read_and_broken_yaml_is_reported_not_raised():
    text = (
        "---\ntype: brief\nclient: ludmyla-doula\ntags: [website, legal]\ndue: 2026-12-01\n"
        "---\n# T\n"
    )
    fm = frontmatter.parse(text)
    assert fm.error is None and fm.present
    assert fm.meta == {
        "type": "brief",
        "client": "ludmyla-doula",
        "tags": ["website", "legal"],
        "due": "2026-12-01",
    }
    assert fm.body == "# T\n"
    assert frontmatter.parse("# No front matter\n") == frontmatter.FrontMatter(
        body="# No front matter\n"
    )

    broken = frontmatter.parse("---\ntags: [a, b\n---\n# Body stays\n")
    assert broken.error and "not valid YAML" in broken.error and broken.meta == {}
    assert broken.body == "# Body stays\n"
    assert frontmatter.parse("---\n- a\n- b\n---\nx").error  # a list, not keys


def test_updating_front_matter_keeps_other_keys_and_the_body_exactly():
    body = "# Title\n\nText with --- dashes\n\n---\n\nmore\n"
    added = frontmatter.update(body, {"type": "brief", "tags": ["a", "b"], "due": "2026-01-02"})
    assert added == "---\ntype: brief\ntags: [a, b]\ndue: 2026-01-02\n---\n" + body
    assert frontmatter.parse(added).meta["due"] == "2026-01-02"

    kept = frontmatter.update("---\ntitle: Mine\ntype: note\n---\n" + body, {"type": "plan"})
    assert kept == "---\ntitle: Mine\ntype: plan\n---\n" + body
    removed = frontmatter.update(kept, {"type": None, "title": None})
    assert removed == body  # an empty block goes away
    assert frontmatter.update("﻿# BOM\n", {"type": "x"}) == "﻿---\ntype: x\n---\n# BOM\n"

    with pytest.raises(AppError) as exc:
        frontmatter.update("---\n: : bad\n  - [\n---\nbody", {"type": "x"})
    assert exc.value.code == "front_matter_invalid"


def test_near_duplicates():
    assert normalise("Ludmyla Doula") == "ludmyla-doula"
    assert normalise("  Юридичне  питання ") == "юридичне-питання"
    assert normalise("a__b--c") == "a-b-c"
    assert is_near("ludmyla", "ludmyla-doula")  # the first words of an existing value
    assert is_near("lgeal", "legal") and is_near("websites", "website")  # spelling
    assert not is_near("legal", "legal")  # equal is not "near"
    assert not is_near("web", "web-design")  # short values are only compared exactly
    assert not is_near("design", "legal") and not is_near("tax", "fax")


def _sql(condition) -> str:  # type: ignore[no-untyped-def]
    return str(condition.compile(dialect=postgresql.dialect()))


def test_property_filter_sql():
    eq, in_, has, missing, present = property_conditions(
        Document.properties,
        {
            "client": "ludmyla-doula",
            "status": {"in": ["draft", "active"]},
            "tags": {"has": "legal"},
            "type": {"missing": True},
            "due": {"missing": False},
        },
    )
    assert _sql(eq).count("@>") == 2  # the value, or a list that has it
    assert _sql(in_).count("@>") == 4
    assert _sql(has).count("@>") == 2
    assert _sql(missing).startswith("NOT") and "?" in _sql(missing)
    assert "?" in _sql(present) and not _sql(present).startswith("NOT")
    for bad in ({"x": {"like": "a"}}, {"x": {"in": [], "has": 1}}, {"x": {"missing": "yes"}}):
        with pytest.raises(AppError):
            property_conditions(Document.properties, bad)


def test_front_matter_refuses_aliases_deep_nesting_and_huge_blocks():
    for text, why in [
        ("---\na: &a [*a]\n---\nbody", "aliases"),
        ("---\nbase: &b {x: 1}\nother:\n  <<: *b\n---\nbody", "aliases"),
        ("---\na: " + "[" * 20 + "]" * 20 + "\n---\nbody", "nested too deeply"),
        ("---\nbig: " + "x" * 70_000 + "\n---\nbody", "too large"),
    ]:
        fm = frontmatter.parse(text)
        assert fm.meta == {} and fm.error and why in fm.error and fm.body == "body"
    # An anchor without an alias is fine; values JSON can't hold come back as text.
    fm = frontmatter.parse("---\na: &x 1\nb: .inf\nc: !!binary aGk=\n---\nbody")
    assert fm.error is None and fm.meta == {"a": 1, "b": "inf", "c": "b'hi'"}

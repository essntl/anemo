"""Links to documents in Markdown: with a part of the document after them (#text=…,
#heading), and by file path as an answer may write them."""

import uuid

from app.features.links.parse import doc_ids_in
from app.features.shares.service import relink

DOC = uuid.UUID("01a191c2-cafb-7b90-823b-866fa882106c")


def test_a_link_to_a_passage_still_counts_as_a_link_to_the_document():
    text = (
        f"See [the scams](/documents/{DOC}#text=fake%20payment) and [plan](/documents/{DOC})"
        f" and [section](/documents/{DOC}#scams-to-watch-for)."
    )
    assert doc_ids_in(text) == {DOC}


def test_a_copy_points_passage_links_to_the_shared_document_and_drops_file_links():
    text = (
        f"[the scams](/documents/{DOC}#text=fake%20payment), "
        "[the plan](/documents/tech-services/side-hustle-plan.md), "
        f"[other](/documents/{uuid.uuid4()})"
    )
    assert relink(text, {DOC: 2}) == "[the scams](?doc=2), the plan, other"

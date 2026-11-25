from app.core.activity import activity_group, current_group


def test_no_group_outside() -> None:
    assert current_group() is None


def test_group_is_set_inside_and_cleared_after() -> None:
    with activity_group("Moved 3 tasks") as group:
        assert current_group() == group
        assert group.label == "Moved 3 tasks"
    assert current_group() is None


def test_nested_groups_join_the_outer_one() -> None:
    with activity_group("outer") as outer, activity_group("inner") as inner:
        assert inner == outer
        assert current_group() == outer
    assert current_group() is None


def test_long_labels_are_cut() -> None:
    with activity_group("x" * 500) as group:
        assert len(group.label) == 200

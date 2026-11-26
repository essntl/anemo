"""The git reads' own rules (features/code_sessions/git.py, schemas.py): which repository
may be named, GitHub names from remote URLs, and pull requests on their branches."""

from typing import Any

import pytest
from pydantic import ValidationError

from app.features.code_sessions import git
from app.features.code_sessions.schemas import github_repo

A = "a" * 40
B = "b" * 40


def branch(name: str, *, remote: bool = False, commit: str = A) -> dict[str, Any]:
    return {
        "name": name,
        "commit": commit,
        "remote": remote,
        "upstream": None,
        "ahead": 0,
        "behind": 0,
        "current": False,
    }


def graph(branches: list[dict[str, Any]], prs: Any, remotes: list[str]) -> git.GitGraph:
    return git.GitGraph.model_validate(
        {
            "head": {"branch": "main", "commit": A, "detached": False},
            "branches": branches,
            "tags": [],
            "commits": [],
            "status": None,
            "remotes": [{"name": r, "url": f"https://github.com/o/{r}"} for r in remotes],
            "truncated": False,
            "pull_requests": prs,
        }
    )


def pr(number: int, head_ref: str, url: str | None = None) -> dict[str, Any]:
    return {
        "number": number,
        "title": f"PR {number}",
        "head_ref": head_ref,
        "url": url or f"https://github.com/o/r/pull/{number}",
    }


@pytest.mark.parametrize(
    ("url", "repo"),
    [
        ("https://github.com/essntl/anemo.git", "essntl/anemo"),
        ("https://github.com/essntl/anemo", "essntl/anemo"),
        ("https://user:token@github.com/essntl/anemo.git", "essntl/anemo"),
        ("git@github.com:essntl/anemo.git", "essntl/anemo"),
        ("ssh://git@github.com/essntl/my.site.git", "essntl/my.site"),
        ("https://GitHub.com/Essntl/Anemo/", "Essntl/Anemo"),
        ("https://gitlab.com/essntl/anemo.git", None),
        ("https://github.com.evil.example/essntl/anemo", None),
        ("https://github.com/essntl/anemo/tree/main", None),
        ("https://github.com/essntl/..", None),
        ("C:\\dev\\anemo", None),
        ("", None),
        (None, None),
    ],
)
def test_github_names_come_only_from_github_urls(url: str | None, repo: str | None):
    assert github_repo(url) == repo


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {"project": "anemo", "repo": "o/anemo"},
        {"repo": "o"},
        {"repo": "o/a/b"},
        {"repo": "o/.."},
        {"repo": "o/."},
        {"repo": "o/anemo.git"},
        {"repo": "-o/anemo"},
        {"repo": "https://github.com/o/anemo"},
        {"repo": "o/" + "a" * 101},
        {"project": "../x"},
    ],
)
def test_a_repository_is_one_plain_name(fields: dict[str, Any]):
    with pytest.raises(ValidationError):
        git.GitWhere.model_validate(fields)


def test_where_says_what_goes_to_the_computer():
    assert git.GitWhere(project="anemo").fields() == {"project": "anemo"}
    assert git.GitWhere(repo="o/my.repo_1").fields() == {"repo": "o/my.repo_1"}


def test_pull_requests_go_on_local_and_remote_branches_of_the_same_name():
    found = graph(
        [
            branch("feat"),
            branch("origin/feat", remote=True),
            branch("fork/feat", remote=True),  # not a remote of this repository: left alone
            branch("main"),
        ],
        [pr(1, "feat"), pr(2, "other")],
        remotes=["origin"],
    )

    git.attach_pull_requests(found)

    numbers = [b.pull_request.number if b.pull_request else None for b in found.branches]
    assert numbers == [1, 1, None, None]


def test_without_pull_requests_nothing_is_attached():
    for prs in (None, []):
        found = graph([branch("feat")], prs, remotes=[])
        git.attach_pull_requests(found)
        assert found.branches[0].pull_request is None


def test_a_pull_request_that_doesn_t_link_to_github_is_dropped():
    found = graph(
        [branch("a"), branch("b")],
        [pr(1, "a", "https://evil.example/pull/1"), pr(2, "b"), "junk", pr(3, "c", "javascript:x")],
        remotes=[],
    )
    git.attach_pull_requests(found)
    assert [p.number for p in found.pull_requests or []] == [2]
    assert found.branches[0].pull_request is None


def test_an_answer_naming_no_real_repository_has_none():
    found = git.GitGraph.model_validate(
        {
            "head": {"branch": None, "commit": None, "detached": False},
            "branches": [],
            "tags": [],
            "commits": [],
            "status": None,
            "remotes": [],
            "truncated": False,
            "repo": "https://evil.example/x",
            "source": "remote",
        }
    )
    assert found.repo is None
    with pytest.raises(ValidationError):
        git.GitGraph.model_validate({**found.model_dump(), "source": "elsewhere"})

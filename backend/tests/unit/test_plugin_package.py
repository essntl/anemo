"""Plugin packages (docs/specs/CONTRACTS-plugins.md §1): path rules, limits, file types,
pictures checked by content, the top folder of a zip, and the package hash."""

import io
import json
import stat
import zipfile
from typing import Any

import pytest
from PIL import Image

from app.features.plugins import package
from app.features.plugins.package import PackageError, read_zip, validate_files


def manifest(**changes: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "manifestVersion": 1,
        "id": "artem.word-count",
        "version": "1.0.0",
        "name": "Word count",
        "description": "Counts words.",
        "author": {"name": "Artem"},
        "permissions": ["documents:read"],
        "contributes": {
            "ui": [
                {
                    "id": "panel",
                    "slot": "object.panel",
                    "objects": ["document"],
                    "title": "Words",
                    "entry": "ui/panel.html",
                }
            ]
        },
    }
    data.update(changes)
    return data


def files(**extra: bytes) -> dict[str, bytes]:
    out = {
        "anemo-plugin.json": json.dumps(manifest()).encode(),
        "ui/panel.html": b"<script src='panel.js'></script>",
        "ui/panel.js": b"console.log('hi')",
    }
    out.update({k.replace("__", "/"): v for k, v in extra.items()})
    return out


def zipped(entries: dict[str, bytes], *, symlink: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "/etc/passwd")
    return buffer.getvalue()


def png(fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(buffer, fmt)
    return buffer.getvalue()


def errors_of(found: dict[str, bytes]) -> list[str]:
    return [f"{e.path}: {e.message}" for e in validate_files(found).errors]


def test_a_good_package_validates() -> None:
    report = validate_files(files())
    assert report.ok, report.errors
    assert report.manifest is not None and report.manifest.id == "artem.word-count"


@pytest.mark.parametrize(
    "path",
    [
        "../evil.js",
        "ui/../../evil.js",
        "/abs.js",
        "ui\\win.js",
        ".hidden.js",
        "ui/.env.js",
        "node_modules/x.js",
        "a//b.js",
        "ui/./x.js",
        "x" * 201 + ".js",
    ],
)
def test_bad_paths_are_refused(path: str) -> None:
    assert package.path_problem(path) is not None


@pytest.mark.parametrize("name", ["evil.svg", "run.exe", "lib.wasm", "script.py", "README"])
def test_file_types_outside_the_list_are_refused(name: str) -> None:
    assert any(name in e for e in errors_of(files(**{name: b"x"})))


def test_svg_named_png_is_refused_by_its_content() -> None:
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    problems = errors_of(files(**{"icon.png": svg}))
    assert any("SVG" in p for p in problems)


def test_pictures_are_checked_by_content() -> None:
    assert errors_of(files(**{"a.png": png()})) == []
    assert errors_of(files(**{"a.webp": png("WEBP")})) == []
    assert any("WebP" in p or "WEBP" in p for p in errors_of(files(**{"a.webp": png()})))
    assert any(
        "PNG, WebP, GIF or JPEG" in p for p in errors_of(files(**{"a.png": b"not a picture"}))
    )


def test_gif_and_jpeg_pictures_are_allowed_and_checked_by_content() -> None:
    assert errors_of(files(**{"sprites__idle.gif": png("GIF")})) == []
    assert errors_of(files(**{"a.jpg": png("JPEG"), "b.jpeg": png("JPEG")})) == []
    # The content must be what the name says.
    assert any(
        "content is PNG, not what its name says (GIF)" in p
        for p in errors_of(files(**{"a.gif": png()}))
    )
    assert any(
        "content is GIF, not what its name says (JPEG)" in p
        for p in errors_of(files(**{"a.jpg": png("GIF")}))
    )
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    assert any("SVG" in p for p in errors_of(files(**{"a.gif": svg})))
    assert any("isn't allowed" in p for p in errors_of(files(**{"a.svg": svg})))


def test_the_icon_stays_png_or_webp() -> None:
    data = manifest(icon="icon.gif")
    found = {**files(**{"icon.gif": png("GIF")}), "anemo-plugin.json": json.dumps(data).encode()}
    assert any("The icon must be a .png or .webp file" in p for p in errors_of(found))


def test_image_kind() -> None:
    assert package.image_kind(png("GIF")) == "GIF"
    assert package.image_kind(png("JPEG")) == "JPEG"
    assert package.image_kind(b"<svg/>") is None
    assert package.image_kind(b"GIF89a broken") is None


def test_text_must_be_utf8_and_fonts_woff2() -> None:
    assert any("UTF-8" in p for p in errors_of(files(**{"notes.md": b"\xff\xfe\x00bad"})))
    assert any("WOFF2" in p for p in errors_of(files(**{"f.woff2": b"wOFFxxxx"})))
    assert errors_of(files(**{"f.woff2": b"wOF2xxxx"})) == []


def test_size_and_count_limits() -> None:
    big = b"a" * (package.MAX_FILE + 1)
    assert any("1 MB" in p for p in errors_of(files(**{"big.txt": big})))
    many = files(**{f"f{i}.txt": b"x" for i in range(package.MAX_FILES)})
    assert any("at most 500 files" in p for p in errors_of(many))
    heavy = files(**{f"h{i}.txt": b"a" * 900_000 for i in range(6)})
    assert any("5 MB" in p for p in errors_of(heavy))


def test_the_manifest_is_required() -> None:
    found = files()
    del found["anemo-plugin.json"]
    assert any("anemo-plugin.json" in p for p in errors_of(found))


def test_zip_with_one_top_folder_is_unwrapped() -> None:
    wrapped = {f"word-count/{k}": v for k, v in files().items()}
    assert set(read_zip(zipped(wrapped))) == set(files())
    assert set(read_zip(zipped(files()))) == set(files())


def test_zip_slip_is_refused() -> None:
    found = read_zip(zipped({**files(), "../../evil.js": b"x"}))
    assert any("evil.js" in e.path for e in validate_files(found).errors)


def test_zip_symlinks_are_refused() -> None:
    with pytest.raises(PackageError) as exc:
        read_zip(zipped(files(), symlink="ui/link.js"))
    assert "Symbolic links" in exc.value.errors[0].message


def test_not_a_zip() -> None:
    with pytest.raises(PackageError):
        read_zip(b"this is not a zip")


def test_zip_lying_about_its_size_is_capped() -> None:
    entries = files(**{"big.txt": b"a" * (package.MAX_FILE + 10)})
    with pytest.raises(PackageError) as exc:
        read_zip(zipped(entries))
    assert "1 MB" in exc.value.errors[0].message


def test_package_hash_is_stable_and_follows_the_contract() -> None:
    a = files()
    b = dict(reversed(list(a.items())))
    assert package.package_hash(a) == package.package_hash(b)
    lines = "".join(f"{p}\t{package.sha256(d)}\n" for p, d in sorted(a.items()))
    assert package.package_hash(a) == package.sha256(lines.encode())
    changed = {**a, "ui/panel.js": b"console.log('changed')"}
    assert package.package_hash(changed) != package.package_hash(a)
    assert package.file_hashes(a)["ui/panel.js"] == {
        "sha256": package.sha256(a["ui/panel.js"]),
        "size": len(a["ui/panel.js"]),
    }


def test_git_urls_are_https_without_credentials() -> None:
    assert package.check_git_url("https://github.com/a/b.git") == "https://github.com/a/b.git"
    for bad in (
        "http://github.com/a/b",
        "ssh://git@github.com/a/b",
        "file:///etc",
        "https://user:pw@github.com/a/b",
        "git@github.com:a/b.git",
    ):
        with pytest.raises(package.GitError):
            package.check_git_url(bad)


def test_bundled_examples_are_valid() -> None:
    from app.features.plugins import bundled

    assert "anemo.hello" in bundled.ids()
    for plugin_id in bundled.ids():
        report = validate_files(bundled.files_of(plugin_id))
        assert report.ok, (plugin_id, report.errors)

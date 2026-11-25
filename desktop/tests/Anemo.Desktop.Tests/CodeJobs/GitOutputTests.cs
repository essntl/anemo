using Anemo.Desktop.Core.CodeJobs;

namespace Anemo.Desktop.Tests.CodeJobs;

/// <summary>The parsers of the read-only git commands (device-contracts.md §7.5), on fixed git output.</summary>
public sealed class GitOutputTests
{
    private const string A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string C = "cccccccccccccccccccccccccccccccccccccccc";
    private const string M = "dddddddddddddddddddddddddddddddddddddddd";
    private const string T = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    private static string Log(params string[][] commits) =>
        string.Concat(commits.Select(fields => string.Join('\0', fields) + '\0'));

    private static string Ref(string name, string commit, string peeled = "", string upstream = "", string track = "", string head = " ") =>
        string.Join('\0', name, commit, peeled, upstream, track, head);

    [Fact]
    public void A_log_with_a_merge_keeps_both_parents_in_order()
    {
        var output = Log(
            [M, $"{B} {C}", "Artem", "a@example.com", "2026-11-24T10:00:00+01:00", "Merge branch 'feature'"],
            [C, A, "Artem", "a@example.com", "2026-11-23T10:00:00+01:00", "Feature"],
            [B, A, "Artem", "a@example.com", "2026-11-22T10:00:00+01:00", "Main work"],
            [A, "", "Artem", "a@example.com", "2026-11-21T10:00:00+01:00", "First commit"]);

        var commits = GitOutput.ParseLog(output);

        Assert.Equal([M, C, B, A], commits.Select(c => c.Hash));
        Assert.Equal([B, C], commits[0].Parents);
        Assert.Empty(commits[3].Parents);
        Assert.Equal("Merge branch 'feature'", commits[0].Subject);
        Assert.Equal("2026-11-24T10:00:00+01:00", commits[0].Date);
    }

    [Fact]
    public void Subjects_and_names_with_tabs_spaces_quotes_and_unicode_stay_whole()
    {
        var output = Log([A, "", "Олена Ковальчук", "o@example.com", "2026-11-21T10:00:00Z", "Fix:\t“quotes”, commas,  and 🌿 emoji — done"]);

        var commit = Assert.Single(GitOutput.ParseLog(output));

        Assert.Equal("Олена Ковальчук", commit.AuthorName);
        Assert.Equal("Fix:\t“quotes”, commas,  and 🌿 emoji — done", commit.Subject);
    }

    [Fact]
    public void A_log_cut_short_drops_the_last_record_and_an_empty_log_is_empty()
    {
        var whole = Log([B, A, "x", "x@example.com", "2026-11-22T10:00:00Z", "Two"]);

        Assert.Single(GitOutput.ParseLog(whole + A + "\0\0x\0x@exa"));
        Assert.Empty(GitOutput.ParseLog(""));
        Assert.Empty(GitOutput.ParseLog("\n"));
    }

    [Fact]
    public void Refs_give_branches_with_their_upstream_and_tags_with_the_commit_they_name()
    {
        var output = string.Join('\n',
            Ref("refs/heads/main", A, upstream: "refs/remotes/origin/main", track: "ahead 2, behind 1", head: "*"),
            Ref("refs/heads/feat/ünïcode-ветка", B, upstream: "refs/remotes/origin/feat/x", track: "behind 3"),
            Ref("refs/heads/no upstream", C),
            Ref("refs/heads/gone", C, upstream: "refs/remotes/origin/gone", track: "gone"),
            Ref("refs/remotes/origin/HEAD", A),
            Ref("refs/remotes/origin/main", B),
            Ref("refs/tags/v1.0", T, peeled: A),
            Ref("refs/tags/light", B),
            Ref("refs/stash", C),
            "garbage line") + "\n";

        var (branches, tags) = GitOutput.ParseRefs(output);

        Assert.Equal(
            [
                new GitBranch("main", A, false, "origin/main", 2, 1, true),
                new GitBranch("feat/ünïcode-ветка", B, false, "origin/feat/x", 0, 3, false),
                new GitBranch("no upstream", C, false, null, 0, 0, false),
                new GitBranch("gone", C, false, "origin/gone", 0, 0, false),
                new GitBranch("origin/main", B, true, null, 0, 0, false),
            ],
            branches);
        Assert.Equal([new GitTag("v1.0", A), new GitTag("light", B)], tags);
    }

    [Fact]
    public void An_empty_repository_has_no_refs()
    {
        var (branches, tags) = GitOutput.ParseRefs("");

        Assert.Empty(branches);
        Assert.Empty(tags);
    }

    [Fact]
    public void Status_counts_staged_unstaged_untracked_and_conflicted_entries()
    {
        var output = string.Join('\0',
            "1 M. N... 100644 100644 100644 1111 2222 staged file.txt",
            "1 .M N... 100644 100644 100644 1111 2222 unstaged.txt",
            "1 MM N... 100644 100644 100644 1111 2222 both.txt",
            "2 R. N... 100644 100644 100644 1111 2222 R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 1111 2222 3333 conflict.txt",
            "? untracked ünï.txt",
            "? another") + "\0";

        var status = GitOutput.ParseStatus(output);

        Assert.Equal(new GitStatus(Staged: 3, Unstaged: 2, Untracked: 2, Conflicted: 1), status);
        Assert.True(status.Dirty);
        Assert.False(GitOutput.ParseStatus("").Dirty);
    }

    [Fact]
    public void Remotes_list_each_fetch_url_once_without_credentials()
    {
        var output = "origin\thttps://user:ghp_secret@github.com/essntl/anemo.git (fetch)\n"
            + "origin\thttps://user:ghp_secret@github.com/essntl/anemo.git (push)\n"
            + "backup\tgit@example.com:me/anemo.git (fetch)\n"
            + "backup\tgit@example.com:me/anemo.git (push)\n";

        Assert.Equal(
            [new GitRemote("origin", "https://github.com/essntl/anemo.git"), new GitRemote("backup", "git@example.com:me/anemo.git")],
            GitOutput.ParseRemotes(output));
        Assert.Empty(GitOutput.ParseRemotes(""));
    }

    [Theory]
    [InlineData("https://github.com/o/r.git", "https://github.com/o/r.git")]
    [InlineData("https://tok@github.com/o/r.git", "https://github.com/o/r.git")]
    [InlineData("https://u:p@ss@example.com:8443/r", "https://example.com:8443/r")]
    [InlineData("ssh://git@example.com/r.git", "ssh://git@example.com/r.git")]
    [InlineData("git@github.com:o/r.git", "git@github.com:o/r.git")]
    [InlineData("/srv/repos/r.git", "/srv/repos/r.git")]
    public void Credentials_are_taken_out_of_urls(string url, string expected) =>
        Assert.Equal(expected, GitOutput.WithoutCredentials(url));

    [Fact]
    public void A_commit_reads_with_its_body_and_dates()
    {
        var output = string.Join('\0', M, $"{B} {C}", "Artem", "a@example.com", "2026-11-24T10:00:00+01:00", "2026-11-24T11:00:00+01:00", "Merge it", "Line one\n\nLine three\n") + "\0";

        var (commit, committed, body) = GitOutput.ParseCommit(output)!.Value;

        Assert.Equal(M, commit.Hash);
        Assert.Equal([B, C], commit.Parents);
        Assert.Equal("Merge it", commit.Subject);
        Assert.Equal("2026-11-24T11:00:00+01:00", committed);
        Assert.Equal("Line one\n\nLine three", body);
        Assert.Null(GitOutput.ParseCommit(""));
        Assert.Null(GitOutput.ParseCommit("fatal: bad object"));
    }

    [Fact]
    public void Files_join_line_counts_with_their_status_renames_and_binaries_included()
    {
        var numstat = "\n3\t1\tsrc/app.ts\0" + "-\t-\tlogo.png\0" + "0\t0\t\0old name.md\0new name.md\0" + "0\t12\tgone.txt\0";
        var nameStatus = "M\0src/app.ts\0A\0logo.png\0R100\0old name.md\0new name.md\0D\0gone.txt\0";

        Assert.Equal(
            [
                new GitFileChange("src/app.ts", "M", 3, 1),
                new GitFileChange("logo.png", "A", null, null),
                new GitFileChange("new name.md", "R", 0, 0),
                new GitFileChange("gone.txt", "D", 0, 12),
            ],
            GitOutput.ParseFiles(numstat, nameStatus));
        Assert.Empty(GitOutput.ParseFiles("", ""));
    }

    [Theory]
    [InlineData("abc1234", true)]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)]
    [InlineData("abc123", false)]
    [InlineData("ABC1234", false)]
    [InlineData("--output=x", false)]
    [InlineData("HEAD", false)]
    [InlineData("abc1234\n", false)]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", false)]
    public void Only_hex_hashes_are_commit_refs(string value, bool valid) =>
        Assert.Equal(valid, GitOutput.IsCommitRef(value));
}

using Anemo.Desktop.Core.Updates;

namespace Anemo.Desktop.Tests.Updates;

/// <summary>Reading <c>codesign -dv</c> and deciding whether a downloaded Mac app may replace the running one.</summary>
public sealed class MacSignatureTests
{
    private const string DeveloperId = """
        Executable=/Applications/Anemo Desktop.app/Contents/MacOS/Anemo Desktop
        Identifier=app.anemo.desktop
        Format=app bundle with Mach-O thin (arm64)
        CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded
        Signature size=9046
        Authority=Developer ID Application: Someone (ABCDE12345)
        Authority=Developer ID Certification Authority
        Authority=Apple Root CA
        Timestamp=25 Nov 2026 at 12:00:00
        TeamIdentifier=ABCDE12345
        """;

    private const string AdHoc = """
        Executable=/Applications/Anemo Desktop.app/Contents/MacOS/Anemo Desktop
        Identifier=app.anemo.desktop
        Format=app bundle with Mach-O thin (arm64)
        CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=28+7 location=embedded
        Signature=adhoc
        TeamIdentifier=not set
        """;

    [Fact]
    public void Developer_id_and_ad_hoc_signatures_are_told_apart()
    {
        Assert.Equal(new MacSignature("app.anemo.desktop", false, "ABCDE12345"), MacSignature.Parse(DeveloperId));
        Assert.Equal(new MacSignature("app.anemo.desktop", true, null), MacSignature.Parse(AdHoc));
        Assert.Null(MacSignature.Parse("/tmp/x.app: code object is not signed at all"));
        Assert.Null(MacSignature.Parse(""));
    }

    [Fact]
    public void A_developer_id_app_takes_only_the_same_team()
    {
        var running = MacSignature.Parse(DeveloperId);

        Assert.Null(MacSignature.Refusal(running, MacSignature.Parse(DeveloperId)));
        Assert.Contains("another developer", MacSignature.Refusal(running, MacSignature.Parse(AdHoc)));
        Assert.Contains("another developer", MacSignature.Refusal(running, MacSignature.Parse(DeveloperId.Replace("ABCDE12345", "ZZZZZ99999"))));
    }

    [Fact]
    public void A_developer_id_app_asks_codesign_for_an_apple_issued_certificate_of_its_team()
    {
        Assert.Equal(
            "anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\"",
            MacSignature.Requirement(MacSignature.Parse(DeveloperId)!));
        Assert.Null(MacSignature.Requirement(MacSignature.Parse(AdHoc)!)); // ad hoc: nobody to anchor to
    }

    [Fact]
    public void A_team_id_that_is_not_ten_letters_and_digits_is_not_read()
    {
        // It would go into the code requirement: `ABCDE12345" or anchor trusted` must not widen it.
        Assert.Null(MacSignature.Parse(DeveloperId.Replace("TeamIdentifier=ABCDE12345", "TeamIdentifier=ABCDE12345\" or anchor trusted")));
        Assert.Null(MacSignature.Parse(DeveloperId.Replace("TeamIdentifier=ABCDE12345", "TeamIdentifier=abcde12345")));
        Assert.Throws<ArgumentException>(() => MacSignature.Requirement(new MacSignature("app.anemo.desktop", false, "X\" or anchor trusted")));
    }

    [Fact]
    public void An_ad_hoc_app_takes_any_signed_anemo_desktop_but_never_another_app()
    {
        var running = MacSignature.Parse(AdHoc);

        Assert.Null(MacSignature.Refusal(running, MacSignature.Parse(AdHoc)));
        Assert.Null(MacSignature.Refusal(running, MacSignature.Parse(DeveloperId))); // moving up to a signed build
        Assert.Contains("another bundle identifier", MacSignature.Refusal(running, MacSignature.Parse(AdHoc.Replace("Identifier=app.anemo.desktop", "Identifier=com.example.other"))));
        Assert.Contains("isn't signed", MacSignature.Refusal(running, null));
    }
}

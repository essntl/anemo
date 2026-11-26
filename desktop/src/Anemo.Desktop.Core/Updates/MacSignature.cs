namespace Anemo.Desktop.Core.Updates;

/// <summary>
/// What <c>codesign -dv</c> says about an app bundle (it writes to stderr): its identifier,
/// whether it is signed ad hoc, and the Team ID of a Developer ID signature.
/// </summary>
public sealed record MacSignature(string? Identifier, bool AdHoc, string? TeamId)
{
    public static MacSignature? Parse(string codesignOutput)
    {
        string? identifier = null, team = null;
        var adHoc = false;
        var signed = false;
        foreach (var raw in codesignOutput.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("Identifier=", StringComparison.Ordinal))
            {
                identifier = line["Identifier=".Length..];
            }
            else if (line == "Signature=adhoc")
            {
                adHoc = signed = true;
            }
            else if (line.StartsWith("TeamIdentifier=", StringComparison.Ordinal))
            {
                var value = line["TeamIdentifier=".Length..];
                if (value != "not set" && value.Length > 0)
                {
                    if (!IsTeamId(value))
                    {
                        return null; // not a signature this reads; it goes into a code requirement below
                    }

                    team = value;
                }
            }
            else if (line.StartsWith("Authority=", StringComparison.Ordinal) || line.StartsWith("Signature size=", StringComparison.Ordinal))
            {
                signed = true;
            }
        }

        return signed && identifier is not null ? new MacSignature(identifier, adHoc && team is null, team) : null;
    }

    /// <summary>
    /// The code requirement (for <c>codesign --verify -R=…</c>) the downloaded app must meet when
    /// the running app has a Developer ID, or null for an ad hoc running app. <c>codesign -dv</c>
    /// only reports the Team ID a signature claims, and <c>--verify</c> alone only checks a bundle
    /// against its own requirement, so anyone can make a bundle that claims any Team ID. This
    /// requirement makes codesign check the certificate chain: issued by Apple, for this team.
    /// </summary>
    public static string? Requirement(MacSignature running) => running.TeamId switch
    {
        null => null,
        var team when IsTeamId(team) => $"anchor apple generic and certificate leaf[subject.OU] = \"{team}\"",
        _ => throw new ArgumentException("not a Team ID", nameof(running)), // Parse never makes one
    };

    /// <summary>Apple's Team IDs are ten capital letters and digits; nothing else goes into a requirement.</summary>
    private static bool IsTeamId(string value) =>
        value.Length == 10 && value.All(c => c is >= 'A' and <= 'Z' or >= '0' and <= '9');

    /// <summary>
    /// Why the downloaded app must not replace the running one, or null when it may: it must be
    /// signed with the same identifier, and when the running app has a Developer ID (a Team ID),
    /// with the same Team ID. An ad hoc running app accepts any signed app that passed
    /// <c>codesign --verify</c>: an ad hoc signature proves the bundle is intact, not who made it.
    /// A running app whose own signature couldn't be read accepts nothing.
    /// </summary>
    public static string? Refusal(MacSignature? running, MacSignature? candidate)
    {
        if (running is null)
        {
            return "This app's own signature couldn't be read, so no update is installed.";
        }

        if (candidate is null)
        {
            return "The downloaded app isn't signed, so it isn't installed.";
        }

        if (running.Identifier is { } id && candidate.Identifier != id)
        {
            return "The downloaded app isn't Anemo Desktop (another bundle identifier), so it isn't installed.";
        }

        if (running.TeamId is { } team && candidate.TeamId != team)
        {
            return "The downloaded app is signed by another developer than this one, so it isn't installed.";
        }

        return null;
    }
}

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
                team = value == "not set" || value.Length == 0 ? null : value;
            }
            else if (line.StartsWith("Authority=", StringComparison.Ordinal) || line.StartsWith("Signature size=", StringComparison.Ordinal))
            {
                signed = true;
            }
        }

        return signed && identifier is not null ? new MacSignature(identifier, adHoc && team is null, team) : null;
    }

    /// <summary>
    /// Why the downloaded app must not replace the running one, or null when it may: it must be
    /// signed with the same identifier, and when the running app has a Developer ID (a Team ID),
    /// with the same Team ID. An ad hoc running app accepts any signed app that passed
    /// <c>codesign --verify</c>: an ad hoc signature proves the bundle is intact, not who made it.
    /// </summary>
    public static string? Refusal(MacSignature? running, MacSignature? candidate)
    {
        if (candidate is null)
        {
            return "The downloaded app isn't signed, so it isn't installed.";
        }

        if (running?.Identifier is { } id && candidate.Identifier != id)
        {
            return "The downloaded app isn't Anemo Desktop (another bundle identifier), so it isn't installed.";
        }

        if (running?.TeamId is { } team && candidate.TeamId != team)
        {
            return "The downloaded app is signed by another developer than this one, so it isn't installed.";
        }

        return null;
    }
}

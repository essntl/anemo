using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Commands;

/// <summary>Finds the Start menu program the agent named.</summary>
internal static class AppMatcher
{
    /// <summary>
    /// The exact name (ignoring case) first, then the only name that starts with it, then
    /// the only name that contains it. Several or none fail with a sentence.
    /// </summary>
    public static StartMenuApp Find(IReadOnlyList<StartMenuApp> apps, string wanted)
    {
        var name = wanted.Trim();
        var exact = apps.FirstOrDefault(a => string.Equals(a.Name, name, StringComparison.OrdinalIgnoreCase));
        if (exact is not null)
        {
            return exact;
        }

        foreach (var matches in new[]
                 {
                     apps.Where(a => a.Name.StartsWith(name, StringComparison.OrdinalIgnoreCase)),
                     apps.Where(a => a.Name.Contains(name, StringComparison.OrdinalIgnoreCase)),
                 })
        {
            var distinct = matches.DistinctBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ToList();
            if (distinct.Count == 1)
            {
                return distinct[0];
            }

            if (distinct.Count > 1)
            {
                var some = string.Join(", ", distinct.Take(5).Select(a => a.Name));
                var more = distinct.Count > 5 ? ", …" : "";
                throw CommandException.Failed($"“{name}” matches several programs: {some}{more}. Give the full name.");
            }
        }

        throw CommandException.Failed($"There is no program called “{name}” in the Start menu.");
    }
}

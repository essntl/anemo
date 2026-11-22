namespace Anemo.Desktop.Core.Connection;

/// <summary>
/// Waits between reconnects: 1, 2, 4 … seconds up to a minute, with ±20 % jitter so many
/// clients don't come back at the same moment. Reset after a connection that lasted.
/// </summary>
public sealed class Backoff
{
    private readonly TimeSpan _first;
    private readonly TimeSpan _max;
    private readonly Random _random;
    private int _attempt;

    public Backoff(TimeSpan first, TimeSpan max, Random? random = null)
    {
        _first = first;
        _max = max;
        _random = random ?? Random.Shared;
    }

    public static Backoff Default() => new(TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(1));

    public int Attempt => _attempt;

    /// <summary>The wait before the next attempt.</summary>
    public TimeSpan Next()
    {
        var factor = Math.Pow(2, Math.Min(_attempt, 16));
        _attempt++;
        var ms = Math.Min(_first.TotalMilliseconds * factor, _max.TotalMilliseconds);
        var jitter = 0.8 + (_random.NextDouble() * 0.4);
        return TimeSpan.FromMilliseconds(Math.Min(ms * jitter, _max.TotalMilliseconds));
    }

    public void Reset() => _attempt = 0;
}

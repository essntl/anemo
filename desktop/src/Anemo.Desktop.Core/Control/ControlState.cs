namespace Anemo.Desktop.Core.Control;

/// <summary>
/// Whether the agent may act on this computer: "Allow control" and a pause (the stop
/// hotkey and "Pause control for 1 hour" both pause for an hour). Looking is not affected.
/// </summary>
public sealed class ControlState
{
    public static readonly TimeSpan PauseLength = TimeSpan.FromHours(1);

    private readonly TimeProvider _time;
    private readonly object _lock = new();
    private bool _allow;
    private DateTimeOffset? _pausedUntil;

    public ControlState(TimeProvider time, bool allow, DateTimeOffset? pausedUntil)
    {
        _time = time;
        _allow = allow;
        _pausedUntil = pausedUntil;
    }

    /// <summary>Allow, pause or resume changed (save the settings, send an offer).</summary>
    public event Action? Changed;

    /// <summary>The user stopped control: cancel what runs and tell Anemo.</summary>
    public event Action? StopRequested;

    public bool AllowControl
    {
        get
        {
            lock (_lock)
            {
                return _allow;
            }
        }
    }

    /// <summary>When the pause ends, or null when control isn't paused.</summary>
    public DateTimeOffset? PausedUntil
    {
        get
        {
            lock (_lock)
            {
                return _pausedUntil is { } until && until > _time.GetUtcNow() ? until : null;
            }
        }
    }

    /// <summary>The agent may act now.</summary>
    public bool Effective => AllowControl && PausedUntil is null;

    /// <summary>The sentence for a refused action, or null when acting is allowed.</summary>
    public string? RefusalReason()
    {
        if (!AllowControl)
        {
            return "Control of this computer is switched off in Anemo Desktop (Allow control).";
        }

        return PausedUntil is { } until
            ? $"The user paused control of this computer until {until.ToLocalTime():HH:mm}."
            : null;
    }

    /// <summary>"Allow control" in the menu. Switching it off stops what runs.</summary>
    public void SetAllow(bool allow)
    {
        lock (_lock)
        {
            if (_allow == allow)
            {
                return;
            }

            _allow = allow;
        }

        Changed?.Invoke();
        if (!allow)
        {
            StopRequested?.Invoke();
        }
    }

    /// <summary>The stop hotkey, the indicator's Stop button and "Pause control for 1 hour".</summary>
    public void Stop()
    {
        lock (_lock)
        {
            _pausedUntil = _time.GetUtcNow() + PauseLength;
        }

        Changed?.Invoke();
        StopRequested?.Invoke();
    }

    /// <summary>Ends a pause early.</summary>
    public void Resume()
    {
        lock (_lock)
        {
            if (_pausedUntil is null)
            {
                return;
            }

            _pausedUntil = null;
        }

        Changed?.Invoke();
    }
}

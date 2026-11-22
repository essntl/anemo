namespace Anemo.Desktop.Core.Connection;

public enum ConnectionPhase
{
    /// <summary>No address or token yet.</summary>
    NotConfigured,

    Connecting,

    Connected,

    /// <summary>Lost; trying again after a wait.</summary>
    Waiting,

    /// <summary>Anemo refused this client (4400, 4401, 4403, 4409); it waits for new settings.</summary>
    Refused,
}

/// <summary>Where the connection is, with a sentence for the tray when there is something to say.</summary>
public sealed record ConnectionStatus(ConnectionPhase Phase, string? Message = null)
{
    public bool IsConnected => Phase == ConnectionPhase.Connected;
}

/// <summary>The close codes of device-contracts.md §2 and what the user is told.</summary>
public static class CloseCodes
{
    public const int BadFirstMessage = 4400;
    public const int BadToken = 4401;
    public const int OriginSent = 4403;
    public const int Replaced = 4409;

    /// <summary>The sentence for a code after which the client doesn't reconnect by itself, else null.</summary>
    public static string? FinalMessage(int? code) => code switch
    {
        BadFirstMessage =>
            "Anemo didn't accept this client's greeting. Check that the token belongs to a computer, not a phone.",
        BadToken => "Anemo refused the token, or the device was removed. Paste a new token in Settings.",
        OriginSent => "Anemo refused the connection because it looked like a web page.",
        Replaced => "Another copy of Anemo Desktop connected with this token, so this one stopped.",
        _ => null,
    };
}

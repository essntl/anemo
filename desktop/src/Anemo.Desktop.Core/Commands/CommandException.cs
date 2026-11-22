namespace Anemo.Desktop.Core.Commands;

/// <summary>The codes of a failed <c>device.result</c> (device-contracts.md §2).</summary>
public static class ResultCodes
{
    public const string Stopped = "stopped";
    public const string Refused = "refused";
    public const string Unavailable = "unavailable";
    public const string Failed = "failed";
}

/// <summary>A command that can't be done; the message is the one sentence the agent sees.</summary>
public sealed class CommandException : Exception
{
    private CommandException(string code, string message) : base(message) => Code = code;

    public string Code { get; }

    public static CommandException Failed(string message) => new(ResultCodes.Failed, message);

    public static CommandException Refused(string message) => new(ResultCodes.Refused, message);

    public static CommandException Unavailable(string message) => new(ResultCodes.Unavailable, message);
}

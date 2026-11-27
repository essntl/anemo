namespace Anemo.Desktop.Core.Commands;

/// <summary>The codes of a failed <c>device.result</c> (device-contracts.md §2).</summary>
public static class ResultCodes
{
    public const string Stopped = "stopped";
    public const string Refused = "refused";
    public const string Unavailable = "unavailable";
    public const string Failed = "failed";

    /// <summary>What the command names isn't there (a project, a commit; 1.5.0).</summary>
    public const string NotFound = "not_found";

    /// <summary>git or gh refused for want of a sign-in (a clone or fetch of a remote repository; 1.6.0).</summary>
    public const string Unauthenticated = "unauthenticated";

    /// <summary>
    /// A <c>shell</c> the server decided with a newer permission profile than this device's copy
    /// (spec 25 §6.1, 1.10.0): the server syncs the profile and tries once more.
    /// </summary>
    public const string ProfileStale = "profile_stale";

    /// <summary>A file is already where a write would put one, and it wasn't asked to replace it (1.7.0, §8).</summary>
    public const string Exists = "exists";
}

/// <summary>A command that can't be done; the message is the one sentence the agent sees.</summary>
public sealed class CommandException : Exception
{
    private CommandException(string code, string message) : base(message) => Code = code;

    public string Code { get; }

    public static CommandException Failed(string message) => new(ResultCodes.Failed, message);

    public static CommandException Refused(string message) => new(ResultCodes.Refused, message);

    public static CommandException Unavailable(string message) => new(ResultCodes.Unavailable, message);

    public static CommandException NotFound(string message) => new(ResultCodes.NotFound, message);

    public static CommandException Unauthenticated(string message) => new(ResultCodes.Unauthenticated, message);

    public static CommandException Exists(string message) => new(ResultCodes.Exists, message);

    public static CommandException Stale(string message) => new(ResultCodes.ProfileStale, message);
}

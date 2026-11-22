using System.Text.Json;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Storage;

/// <summary>The settings couldn't be saved; the message is a sentence for the user.</summary>
public sealed class SettingsSaveException : Exception
{
    public SettingsSaveException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>Reads and writes the settings file; the token goes through the protector.</summary>
public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly string _path;
    private readonly ITokenProtector _protector;
    private readonly object _lock = new();

    public SettingsStore(string path, ITokenProtector protector)
    {
        _path = path;
        _protector = protector;
    }

    public string Path => _path;

    /// <summary>
    /// What went wrong reading the file at the last <see cref="Load"/>, as a sentence, or
    /// null when it was fine (or there was none yet).
    /// </summary>
    public string? LoadProblem { get; private set; }

    /// <summary>
    /// The saved settings; defaults when there is no file. When the file exists but can't
    /// be read or understood, control starts switched off (fail closed) and
    /// <see cref="LoadProblem"/> says so.
    /// </summary>
    public DesktopSettings Load()
    {
        lock (_lock)
        {
            LoadProblem = null;
            try
            {
                return JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(_path), Options)
                    ?? throw new JsonException("empty");
            }
            catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
            {
                return new DesktopSettings(); // the first start
            }
            catch (JsonException)
            {
                KeepBrokenFile();
                LoadProblem = "The settings file was damaged, so Anemo Desktop started with control switched off. Check Settings.";
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                LoadProblem = "The settings file couldn't be read, so Anemo Desktop started with control switched off.";
            }

            return new DesktopSettings { AllowControl = false };
        }
    }

    /// <summary>Writes the whole file (to a temporary file first, then moved into place).</summary>
    /// <exception cref="SettingsSaveException">The folder or file can't be written.</exception>
    public void Save(DesktopSettings settings)
    {
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path)!);
                var temp = _path + ".tmp";
                File.WriteAllText(temp, JsonSerializer.Serialize(settings, Options));
                File.Move(temp, _path, overwrite: true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                throw new SettingsSaveException($"The settings couldn't be saved to {_path}.", e);
            }
        }
    }

    /// <summary>The settings with the token protected for the current user.</summary>
    /// <exception cref="SettingsSaveException">Windows couldn't protect the token.</exception>
    public DesktopSettings WithToken(DesktopSettings settings, string? token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return settings with { ProtectedToken = null };
        }

        try
        {
            return settings with { ProtectedToken = _protector.Protect(token.Trim()) };
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            throw new SettingsSaveException("Windows couldn't protect the token for your user account, so it wasn't saved.", e);
        }
    }

    /// <summary>The token in clear, or null when none is saved or it can't be read back.</summary>
    public string? Token(DesktopSettings settings) =>
        settings.ProtectedToken is { Length: > 0 } p ? _protector.Unprotect(p) : null;

    private void KeepBrokenFile()
    {
        try
        {
            File.Copy(_path, _path + ".broken", overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // It is only kept for the user to look at.
        }
    }
}

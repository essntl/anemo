using System.Text.Json;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.Storage;

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

    /// <summary>The saved settings; defaults when there is no file or it can't be read.</summary>
    public DesktopSettings Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_path))
            {
                return new DesktopSettings();
            }

            try
            {
                return JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(_path), Options)
                    ?? new DesktopSettings();
            }
            catch (JsonException)
            {
                // Keep the broken file for the user to look at, start again from defaults.
                File.Copy(_path, _path + ".broken", overwrite: true);
                return new DesktopSettings();
            }
        }
    }

    /// <summary>Writes the whole file (to a temporary file first, then moved into place).</summary>
    public void Save(DesktopSettings settings)
    {
        lock (_lock)
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path)!);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(settings, Options));
            File.Move(temp, _path, overwrite: true);
        }
    }

    /// <summary>The settings with the token protected for the current user.</summary>
    public DesktopSettings WithToken(DesktopSettings settings, string? token) =>
        settings with
        {
            ProtectedToken = string.IsNullOrWhiteSpace(token) ? null : _protector.Protect(token.Trim()),
        };

    /// <summary>The token in clear, or null when none is saved or it can't be read back.</summary>
    public string? Token(DesktopSettings settings) =>
        settings.ProtectedToken is { Length: > 0 } p ? _protector.Unprotect(p) : null;
}

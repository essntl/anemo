using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Platform;

namespace Anemo.Desktop.Core.SharedScreen;

/// <summary>What "Share this screen" sends: a screenshot and the text of the window in front.</summary>
public sealed record SharedScreenContent(string ScreenshotBase64, string? Title, string? App, string Text);

/// <summary>How a share went, as a sentence for the tray.</summary>
public sealed record ShareResult(bool Ok, string Message);

/// <summary>
/// "Share this screen with Anemo" (device-contracts.md §5): <c>PUT /api/devices/shared-screen</c>
/// with the device token as a Bearer header. Only on the user's action.
/// </summary>
public sealed class SharedScreenClient
{
    private readonly HttpClient _http;

    public SharedScreenClient(HttpClient http) => _http = http;

    /// <summary>The screen and the front window's text, read now.</summary>
    public static SharedScreenContent Capture(IDesktop desktop, CancellationToken ct)
    {
        if (desktop.IsSecureDesktop())
        {
            throw CommandException.Unavailable(CommandProcessor.SecureDesktopMessage);
        }

        var capture = desktop.CaptureScreen();
        var window = desktop.FrontWindow();
        var text = window is null ? "" : StateBuilder.Describe(desktop.ReadTree(window.Handle, ct)).Text;
        return new SharedScreenContent(Convert.ToBase64String(capture.Png), window?.Title, window?.App, text);
    }

    public async Task<ShareResult> ShareAsync(ConnectionSettings settings, SharedScreenContent content, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["screenshot"] = content.ScreenshotBase64,
            ["window"] = new JsonObject { ["title"] = content.Title ?? "", ["app"] = content.App ?? "" },
            ["text"] = content.Text.Length > StateBuilder.MaxText ? content.Text[..StateBuilder.MaxText] : content.Text,
        };
        using var request = new HttpRequestMessage(HttpMethod.Put, settings.Address.SharedScreenUri)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.Token);

        try
        {
            using var response = await _http.SendAsync(request, ct);
            return response.StatusCode switch
            {
                HttpStatusCode.OK => new ShareResult(true, "Shared this screen with Anemo."),
                HttpStatusCode.Unauthorized => new ShareResult(false, "Anemo refused the token; paste a new one in Settings."),
                HttpStatusCode.RequestEntityTooLarge or HttpStatusCode.UnprocessableEntity =>
                    new ShareResult(false, "Anemo didn't accept the screen (too large?)."),
                _ => new ShareResult(false, $"Anemo answered {(int)response.StatusCode}; the screen wasn't shared."),
            };
        }
        catch (HttpRequestException)
        {
            return new ShareResult(false, "Couldn't reach Anemo; the screen wasn't shared.");
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return new ShareResult(false, "Anemo didn't answer in time; the screen wasn't shared.");
        }
    }
}

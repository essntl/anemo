using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Anemo.Desktop.Tests.Fakes;

/// <summary>What the fake server saw of one HTTP request (for the "token never in a URL" checks).</summary>
public sealed record SeenRequest(string Method, string Path, string Query, string? Origin, string? Authorization);

/// <summary>
/// A stand-in for Anemo that speaks docs/device-contracts.md: the device WebSocket (§2:
/// hello within 10 s, welcome, ping/pong, offers, commands and results, device.stopped,
/// notice, the close codes 4400/4401/4403/4409) and the shared-screen routes (§5).
/// Listens on 127.0.0.1 on a free port.
/// </summary>
public sealed class FakeAnemoServer : IAsyncDisposable
{
    public const string Token = "anemo_TestToken_abc123";

    /// <summary>The real server's limits (backend/app/features/devices/ws.py).</summary>
    public const int MaxMessage = 4096;
    public const int MaxResult = 12 * 1024 * 1024;

    private readonly WebApplication _app;
    private readonly Channel<FakeClient> _clients = Channel.CreateUnbounded<FakeClient>();
    private int _connections;

    private FakeAnemoServer(WebApplication app) => _app = app;

    public Uri BaseUri { get; private set; } = null!;

    /// <summary>The device's kind on the server; a different kind in hello closes with 4400.</summary>
    public string Kind { get; set; } = "computer";

    public string Trust { get; set; } = "watched";

    /// <summary>Answer pings with pongs (off: the client must notice the silence).</summary>
    public bool AnswerPings { get; set; } = true;

    /// <summary>Send no welcome after hello.</summary>
    public bool Mute { get; set; }

    /// <summary>The oldest client version supported; older clients get one notice.</summary>
    public Version MinVersion { get; set; } = new(1, 0, 0);

    public string Cursor { get; set; } = "cursor-1";

    public ConcurrentQueue<SeenRequest> Requests { get; } = new();

    /// <summary>The last body PUT to the shared-screen route.</summary>
    public JsonObject? SharedScreen { get; private set; }

    public int Connections => Volatile.Read(ref _connections);

    public static async Task<FakeAnemoServer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        var app = builder.Build();
        var server = new FakeAnemoServer(app);
        app.UseWebSockets();
        app.Use(async (ctx, next) =>
        {
            server.Requests.Enqueue(new SeenRequest(
                ctx.Request.Method,
                ctx.Request.Path,
                ctx.Request.QueryString.Value ?? "",
                ctx.Request.Headers.Origin.FirstOrDefault(),
                ctx.Request.Headers.Authorization.FirstOrDefault()));
            await next();
        });
        app.Map("/api/devices/ws", server.HandleWebSocketAsync);
        app.MapPut("/api/devices/shared-screen", (Delegate)server.PutSharedScreenAsync);
        app.MapGet("/api/devices/shared-screen", (Delegate)server.GetSharedScreen);
        app.MapDelete("/api/devices/shared-screen", (Delegate)server.DeleteSharedScreen);
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        server.BaseUri = new Uri(address);
        return server;
    }

    /// <summary>The next client that got through hello (or was closed during it).</summary>
    public async Task<FakeClient> NextClientAsync(TimeSpan? timeout = null)
    {
        using var cts = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(10));
        return await _clients.Reader.ReadAsync(cts.Token);
    }

    /// <summary>True when no further client connected within the time.</summary>
    public async Task<bool> NoClientWithinAsync(TimeSpan time)
    {
        using var cts = new CancellationTokenSource(time);
        try
        {
            await _clients.Reader.WaitToReadAsync(cts.Token);
            return false;
        }
        catch (OperationCanceledException)
        {
            return true;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }

    private async Task HandleWebSocketAsync(HttpContext ctx)
    {
        if (!ctx.WebSockets.IsWebSocketRequest)
        {
            ctx.Response.StatusCode = 400;
            return;
        }

        Interlocked.Increment(ref _connections);
        var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        var client = new FakeClient(this, ws);
        if (ctx.Request.Headers.Origin.Count > 0)
        {
            await client.CloseAsync(4403);
            _clients.Writer.TryWrite(client);
            return;
        }

        using var helloCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var hello = await client.ReceiveRawAsync(helloCts.Token);
        client.Hello = hello;
        // As the real server: a bad hello first, then the token, then the kind.
        if (hello is null || client.LastLength > MaxMessage || (string?)hello["type"] != "hello")
        {
            await client.CloseAsync(4400);
        }
        else if ((string?)hello["token"] != Token)
        {
            await client.CloseAsync(4401);
        }
        else if ((string?)hello["kind"] != Kind)
        {
            await client.CloseAsync(4400);
        }
        else if (!Mute)
        {
            await client.SendAsync(new JsonObject
            {
                ["type"] = "welcome",
                ["device"] = new JsonObject { ["id"] = "dev-1", ["name"] = "Desk PC", ["kind"] = Kind, ["trust"] = Trust },
                ["missed"] = false,
                ["cursor"] = Cursor,
            });
            if (Version.TryParse((string?)hello["version"], out var v) && v < MinVersion)
            {
                await client.SendAsync(new JsonObject { ["type"] = "notice", ["text"] = "Please update Anemo Desktop." });
            }
        }

        _clients.Writer.TryWrite(client);
        await client.PumpAsync();
    }

    private async Task<IResult> PutSharedScreenAsync(HttpContext ctx)
    {
        if (ctx.Request.Headers.Authorization.FirstOrDefault() != $"Bearer {Token}")
        {
            return Results.StatusCode(401);
        }

        var body = await JsonNode.ParseAsync(ctx.Request.Body) as JsonObject;
        if (body?["screenshot"] is null || body["window"] is not JsonObject || ((string?)body["text"])?.Length > 40_000)
        {
            return Results.StatusCode(422);
        }

        SharedScreen = body;
        return Results.Json(new { shared_at = "2026-11-22T10:00:00Z", device = "Desk PC" });
    }

    private IResult GetSharedScreen(HttpContext ctx) =>
        SharedScreen is null
            ? Results.Json(new { screen = (object?)null })
            : Results.Json(new { screen = new { device = "Desk PC", window = SharedScreen["window"]?.ToJsonString(), shared_at = "2026-11-22T10:00:00Z" } });

    private IResult DeleteSharedScreen(HttpContext ctx)
    {
        SharedScreen = null;
        return Results.StatusCode(204);
    }

    /// <summary>One client's WebSocket, as the server sees it.</summary>
    public sealed class FakeClient
    {
        private readonly FakeAnemoServer _server;
        private readonly WebSocket _ws;
        private readonly Channel<JsonObject> _received = Channel.CreateUnbounded<JsonObject>();
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private readonly TaskCompletionSource<int?> _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public FakeClient(FakeAnemoServer server, WebSocket ws)
        {
            _server = server;
            _ws = ws;
        }

        public JsonObject? Hello { get; set; }

        /// <summary>The length of the last text message received, in characters.</summary>
        public int LastLength { get; private set; }

        /// <summary>Results for these ids only reach the test; others are ignored, as on the real server.</summary>
        public ConcurrentDictionary<string, bool> SentIds { get; } = new();

        /// <summary>Messages the server dropped (too large, or a result for an id it didn't send).</summary>
        public ConcurrentQueue<string> Dropped { get; } = new();

        /// <summary>The close code the client sent, once it closed.</summary>
        public Task<int?> Closed => _closed.Task;

        /// <summary>The next message of the given type; others (pings, offers…) are skipped.</summary>
        public async Task<JsonObject> NextAsync(string type, TimeSpan? timeout = null)
        {
            using var cts = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(10));
            while (true)
            {
                var msg = await _received.Reader.ReadAsync(cts.Token);
                if ((string?)msg["type"] == type)
                {
                    return msg;
                }
            }
        }

        /// <summary>The next message whatever its type, pings excluded.</summary>
        public async Task<JsonObject> NextAsync(TimeSpan? timeout = null)
        {
            using var cts = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(10));
            while (true)
            {
                var msg = await _received.Reader.ReadAsync(cts.Token);
                if ((string?)msg["type"] != "ping")
                {
                    return msg;
                }
            }
        }

        public async Task SendAsync(JsonObject msg)
        {
            await _sendLock.WaitAsync();
            try
            {
                await _ws.SendAsync(Encoding.UTF8.GetBytes(msg.ToJsonString()), WebSocketMessageType.Text, true, default);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public Task CommandAsync(string id, string action, JsonObject? fields = null)
        {
            SentIds[id] = true;
            var msg = new JsonObject { ["type"] = "device.command", ["id"] = id, ["action"] = action };
            foreach (var (key, value) in fields ?? new JsonObject())
            {
                msg[key] = value?.DeepClone();
            }

            return SendAsync(msg);
        }

        public async Task CloseAsync(int code)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await _ws.CloseAsync((WebSocketCloseStatus)code, "closed by the fake server", cts.Token);
            }
            catch (Exception e) when (e is WebSocketException or OperationCanceledException)
            {
                // The client went first.
            }
        }

        public void Abort() => _ws.Abort();

        internal async Task<JsonObject?> ReceiveRawAsync(CancellationToken ct)
        {
            var buffer = new byte[64 * 1024];
            using var message = new MemoryStream();
            while (true)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await _ws.ReceiveAsync(buffer, ct);
                }
                catch (Exception e) when (e is WebSocketException or OperationCanceledException)
                {
                    return null;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    _closed.TrySetResult((int?)result.CloseStatus);
                    return null;
                }

                message.Write(buffer, 0, result.Count);
                if (result.EndOfMessage)
                {
                    var text = Encoding.UTF8.GetString(message.ToArray());
                    LastLength = text.Length;
                    return JsonNode.Parse(text) as JsonObject;
                }
            }
        }

        internal async Task PumpAsync()
        {
            while (_ws.State == WebSocketState.Open)
            {
                var msg = await ReceiveRawAsync(CancellationToken.None);
                if (msg is null)
                {
                    break;
                }

                var type = (string?)msg["type"];
                if (type == "device.result")
                {
                    var id = (string?)msg["id"];
                    if (LastLength > MaxResult || id is null || !SentIds.TryRemove(id, out _))
                    {
                        Dropped.Enqueue(msg.ToJsonString());
                        continue;
                    }
                }
                else if (LastLength > MaxMessage)
                {
                    Dropped.Enqueue(type ?? "?");
                    continue;
                }

                if (type == "ping" && _server.AnswerPings)
                {
                    await SendAsync(new JsonObject { ["type"] = "pong" });
                }

                _received.Writer.TryWrite(msg);
            }

            _closed.TrySetResult((int?)_ws.CloseStatus);
            _received.Writer.TryComplete();
        }
    }
}

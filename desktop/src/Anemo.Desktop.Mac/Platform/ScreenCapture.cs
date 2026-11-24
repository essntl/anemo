using Anemo.Desktop.Core.Commands;
using Anemo.Desktop.Core.Platform;
using Anemo.Desktop.Mac.Native;

namespace Anemo.Desktop.Mac.Platform;

/// <summary>
/// Screenshots with ScreenCaptureKit (macOS 14+: <c>SCScreenshotManager</c>), which needs the
/// Screen Recording permission. A screenshot is planned in points (Core's
/// <see cref="DisplayLayout"/>): each display is rendered by macOS at its size in the
/// screenshot, from its full-resolution image, and drawn into one bitmap where the displays
/// are arranged as in System Settings → Displays.
/// </summary>
internal static class ScreenCapture
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public const string NoPermissionMessage =
        "Anemo Desktop isn't allowed to record the screen on this Mac. Ask the user to allow it: Anemo Desktop's menu → Permissions…, or System Settings → Privacy & Security → Screen & System Audio Recording.";

    /// <summary>The displays as Core plans with them: bounds in points, pixels per point.</summary>
    public static IReadOnlyList<DisplayInfo> Displays() =>
        CG.ActiveDisplays().Select(id => new DisplayInfo(id, CG.DisplayBounds(id).ToScreenRect(), CG.PixelsPerPoint(id))).ToList();

    /// <summary>Every display, stitched.</summary>
    public static Core.Platform.ScreenCapture CaptureScreen()
    {
        RequirePermission();
        var displays = Displays();
        var plan = DisplayLayout.Plan(DisplayLayout.Union(displays));
        return ObjC.InPool(() =>
        {
            var content = ShareableContent();
            try
            {
                var images = new List<(PixelRect Place, nint Image)>();
                try
                {
                    foreach (var display in displays)
                    {
                        if (DisplayLayout.Place(plan, display.Bounds) is not { } place || FindDisplay(content, display.Id) is not { } scDisplay)
                        {
                            continue;
                        }

                        var filter = ObjC.Call(ObjC.Call(ObjC.Class("SCContentFilter"), "alloc"), "initWithDisplay:excludingWindows:",
                            scDisplay, ObjC.Call(ObjC.Class("NSArray"), "array"));
                        images.Add((place, Capture(filter, place.Width, place.Height)));
                        ObjC.Call(filter, "release");
                    }

                    return Stitch(plan, images);
                }
                finally
                {
                    foreach (var (_, image) in images)
                    {
                        CG.ReleaseImage(image);
                    }
                }
            }
            finally
            {
                ObjC.Call(content, "release");
            }
        });
    }

    /// <summary>One window (its own pixels, also when covered), planned from its frame in points.</summary>
    public static Core.Platform.ScreenCapture CaptureWindow(uint windowId, ScreenRect frame)
    {
        RequirePermission();
        var plan = DisplayLayout.Plan(frame);
        return ObjC.InPool(() =>
        {
            var content = ShareableContent();
            try
            {
                var windows = ObjC.Call(content, "windows");
                nint window = 0;
                for (long i = 0; i < ObjC.Count(windows); i++)
                {
                    var w = ObjC.At(windows, i);
                    if (ObjC.SendReturnUInt(w, ObjC.Selector("windowID")) == windowId)
                    {
                        window = w;
                        break;
                    }
                }

                if (window == 0)
                {
                    throw new ElementGoneException();
                }

                var filter = ObjC.Call(ObjC.Call(ObjC.Class("SCContentFilter"), "alloc"), "initWithDesktopIndependentWindow:", window);
                var image = Capture(filter, plan.Width, plan.Height);
                ObjC.Call(filter, "release");
                try
                {
                    return new Core.Platform.ScreenCapture(CG.Png(image), plan.Width, plan.Height, plan.Scale, plan.OriginX, plan.OriginY);
                }
                finally
                {
                    CG.ReleaseImage(image);
                }
            }
            finally
            {
                ObjC.Call(content, "release");
            }
        });
    }

    private static void RequirePermission()
    {
        if (!CG.PreflightScreenCapture())
        {
            throw CommandException.Unavailable(NoPermissionMessage);
        }
    }

    /// <summary><c>[SCShareableContent getShareableContentWithCompletionHandler:]</c>, waited for; retained (release it).</summary>
    private static nint ShareableContent()
    {
        var done = new ManualResetEventSlim();
        nint content = 0;
        string? error = null;
        var block = Blocks.TwoArgs((result, err) =>
        {
            if (result != 0)
            {
                content = ObjC.Call(result, "retain");
            }

            error = ErrorText(err);
            done.Set();
        });
        ObjC.SendVoid(ObjC.Class("SCShareableContent"), ObjC.Selector("getShareableContentWithCompletionHandler:"), block);
        if (!done.Wait(Timeout) || content == 0)
        {
            throw CommandException.Unavailable($"macOS didn't list the screen's content ({error ?? "no answer"}).");
        }

        return content;
    }

    private static nint? FindDisplay(nint content, uint displayId)
    {
        var displays = ObjC.Call(content, "displays");
        for (long i = 0; i < ObjC.Count(displays); i++)
        {
            var d = ObjC.At(displays, i);
            if (ObjC.SendReturnUInt(d, ObjC.Selector("displayID")) == displayId)
            {
                return d;
            }
        }

        return null;
    }

    /// <summary>One screenshot of the filter at this size in pixels: a CGImage (release it).</summary>
    private static nint Capture(nint filter, int width, int height)
    {
        var config = ObjC.Call(ObjC.Call(ObjC.Class("SCStreamConfiguration"), "alloc"), "init");
        ObjC.SendVoidLong(config, ObjC.Selector("setWidth:"), width);
        ObjC.SendVoidLong(config, ObjC.Selector("setHeight:"), height);
        var done = new ManualResetEventSlim();
        nint image = 0;
        string? error = null;
        var block = Blocks.TwoArgs((cgImage, err) =>
        {
            if (cgImage != 0)
            {
                image = CF.Retain(cgImage);
            }

            error = ErrorText(err);
            done.Set();
        });
        ObjC.SendVoid(ObjC.Class("SCScreenshotManager"), ObjC.Selector("captureImageWithFilter:configuration:completionHandler:"), filter, config, block);
        var answered = done.Wait(Timeout);
        ObjC.Call(config, "release");
        if (!answered || image == 0)
        {
            throw CommandException.Unavailable($"macOS didn't take the screenshot ({error ?? "no answer"}).");
        }

        return image;
    }

    /// <summary>The displays' images drawn into one PNG, each at its place (black between displays).</summary>
    private static Core.Platform.ScreenCapture Stitch(CapturePlan plan, List<(PixelRect Place, nint Image)> images)
    {
        var space = CG.DeviceRgb();
        var context = CG.BitmapContext(0, (nuint)plan.Width, (nuint)plan.Height, 8, 0, space, CG.PremultipliedFirstLittle);
        try
        {
            CG.SetFill(context, 0, 0, 0, 1);
            CG.FillRect(context, new CGRect(0, 0, plan.Width, plan.Height));
            foreach (var (place, image) in images)
            {
                var flipped = DisplayLayout.FlipY(plan, place); // bitmap contexts count y from the bottom
                CG.DrawImage(context, new CGRect(flipped.X, flipped.Y, flipped.Width, flipped.Height), image);
            }

            var stitched = CG.ImageOf(context);
            try
            {
                return new Core.Platform.ScreenCapture(CG.Png(stitched), plan.Width, plan.Height, plan.Scale, plan.OriginX, plan.OriginY);
            }
            finally
            {
                CG.ReleaseImage(stitched);
            }
        }
        finally
        {
            CG.ReleaseContext(context);
            CG.ReleaseColorSpace(space);
        }
    }

    private static string? ErrorText(nint nsError) =>
        nsError == 0 ? null : ObjC.FromNSString(ObjC.Call(nsError, "localizedDescription"));
}

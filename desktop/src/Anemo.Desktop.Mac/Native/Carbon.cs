using System.Runtime.InteropServices;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// The two Carbon calls the app needs: system-wide hot keys (<c>RegisterEventHotKey</c>, which
/// needs no permission, unlike watching every key) and <c>IsSecureEventInputEnabled</c> (a
/// password field somewhere has the keyboard: macOS hides keys from other apps then).
/// </summary>
internal static unsafe partial class Carbon
{
    private const string Lib = "/System/Library/Frameworks/Carbon.framework/Carbon";

    // Carbon modifier bits (Events.h).
    public const uint CmdKey = 0x0100;
    public const uint ShiftKey = 0x0200;
    public const uint OptionKey = 0x0800;
    public const uint ControlKey = 0x1000;

    private const uint EventClassKeyboard = 0x6B657962; // 'keyb'
    private const uint EventHotKeyPressed = 5;
    private const uint ParamDirectObject = 0x2D2D2D2D; // '----'
    private const uint TypeEventHotKeyId = 0x686B6964; // 'hkid'
    private const uint Signature = 0x414E454D; // 'ANEM'

    [StructLayout(LayoutKind.Sequential)]
    private struct EventHotKeyId
    {
        public uint Signature;
        public uint Id;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EventTypeSpec
    {
        public uint EventClass;
        public uint EventKind;
    }

    [LibraryImport(Lib, EntryPoint = "IsSecureEventInputEnabled")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static partial bool SecureInputEnabled();

    [LibraryImport(Lib, EntryPoint = "GetApplicationEventTarget")]
    private static partial nint GetApplicationEventTarget();

    [LibraryImport(Lib, EntryPoint = "RegisterEventHotKey")]
    private static partial int RegisterEventHotKey(uint keyCode, uint modifiers, EventHotKeyId id, nint target, uint options, out nint hotKey);

    [LibraryImport(Lib, EntryPoint = "UnregisterEventHotKey")]
    private static partial int UnregisterEventHotKey(nint hotKey);

    [LibraryImport(Lib, EntryPoint = "InstallEventHandler")]
    private static partial int InstallEventHandler(nint target, delegate* unmanaged<nint, nint, nint, int> handler, nuint count, EventTypeSpec* types, nint userData, out nint handlerRef);

    [LibraryImport(Lib, EntryPoint = "GetEventParameter")]
    private static partial int GetEventParameter(nint evt, uint name, uint type, nint actualType, nuint size, nint actualSize, EventHotKeyId* data);

    private static readonly Dictionary<uint, Action> Handlers = new();
    private static bool _installed;

    /// <summary>
    /// Registers a hot key; <paramref name="pressed"/> runs on the main thread when it is
    /// pressed anywhere. Returns the registration (for <see cref="Unregister"/>) or 0 when
    /// another app holds that combination.
    /// </summary>
    public static nint Register(uint id, ushort keyCode, uint modifiers, Action pressed)
    {
        if (!_installed)
        {
            var spec = new EventTypeSpec { EventClass = EventClassKeyboard, EventKind = EventHotKeyPressed };
            InstallEventHandler(GetApplicationEventTarget(), &OnHotKey, 1, &spec, 0, out _);
            _installed = true;
        }

        lock (Handlers)
        {
            Handlers[id] = pressed;
        }

        return RegisterEventHotKey(keyCode, modifiers, new EventHotKeyId { Signature = Signature, Id = id }, GetApplicationEventTarget(), 0, out var hotKey) == 0
            ? hotKey
            : 0;
    }

    public static void Unregister(nint hotKey)
    {
        if (hotKey != 0)
        {
            UnregisterEventHotKey(hotKey);
        }
    }

    [UnmanagedCallersOnly]
    private static int OnHotKey(nint callRef, nint evt, nint userData)
    {
        EventHotKeyId id;
        if (GetEventParameter(evt, ParamDirectObject, TypeEventHotKeyId, 0, (nuint)sizeof(EventHotKeyId), 0, &id) == 0
            && id.Signature == Signature)
        {
            Action? handler;
            lock (Handlers)
            {
                Handlers.TryGetValue(id.Id, out handler);
            }

            try
            {
                handler?.Invoke();
            }
            catch (Exception)
            {
                // Never let an exception cross into Carbon.
            }
        }

        return 0;
    }
}

using System.Runtime.InteropServices;
using System.Text;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// One generic password in the user's login Keychain (Security framework, SecItem API),
/// readable only after the Mac was unlocked once since it started, and never synced to other
/// devices (<c>kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly</c>).
/// </summary>
internal static partial class Keychain
{
    private const string Lib = "/System/Library/Frameworks/Security.framework/Security";

    public const int Ok = 0; // errSecSuccess
    public const int NotFound = -25300; // errSecItemNotFound
    public const int Duplicate = -25299; // errSecDuplicateItem

    [LibraryImport(Lib, EntryPoint = "SecItemAdd")]
    private static partial int SecItemAdd(nint attributes, nint result);

    [LibraryImport(Lib, EntryPoint = "SecItemCopyMatching")]
    private static partial int SecItemCopyMatching(nint query, out nint result);

    [LibraryImport(Lib, EntryPoint = "SecItemUpdate")]
    private static partial int SecItemUpdate(nint query, nint attributes);

    [LibraryImport(Lib, EntryPoint = "SecItemDelete")]
    private static partial int SecItemDelete(nint query);

    private static readonly nint Handle = NativeLibrary.Load(Lib);

    private static nint K(string name) => CF.Constant(Handle, name);

    /// <summary>Stores the secret (replacing an older one). Returns the OSStatus (0 = stored).</summary>
    public static int Save(string service, string account, string secret)
    {
        var svc = CF.String(service);
        var acct = CF.String(account);
        var data = CF.Data(Encoding.UTF8.GetBytes(secret));
        var query = CF.Dictionary((K("kSecClass"), K("kSecClassGenericPassword")), (K("kSecAttrService"), svc), (K("kSecAttrAccount"), acct));
        var update = CF.Dictionary((K("kSecValueData"), data));
        var add = CF.Dictionary(
            (K("kSecClass"), K("kSecClassGenericPassword")),
            (K("kSecAttrService"), svc),
            (K("kSecAttrAccount"), acct),
            (K("kSecValueData"), data),
            (K("kSecAttrAccessible"), K("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly")));
        try
        {
            var status = SecItemUpdate(query, update);
            return status == NotFound ? SecItemAdd(add, 0) : status;
        }
        finally
        {
            CF.Release(add);
            CF.Release(update);
            CF.Release(query);
            CF.Release(data);
            CF.Release(acct);
            CF.Release(svc);
        }
    }

    /// <summary>The secret, or null when there is none or it can't be read (locked, refused).</summary>
    public static string? Read(string service, string account)
    {
        var svc = CF.String(service);
        var acct = CF.String(account);
        var query = CF.Dictionary(
            (K("kSecClass"), K("kSecClassGenericPassword")),
            (K("kSecAttrService"), svc),
            (K("kSecAttrAccount"), acct),
            (K("kSecReturnData"), CF.True),
            (K("kSecMatchLimit"), K("kSecMatchLimitOne")));
        try
        {
            if (SecItemCopyMatching(query, out var data) != Ok || data == 0)
            {
                return null;
            }

            try
            {
                return Encoding.UTF8.GetString(CF.Bytes(data));
            }
            finally
            {
                CF.Release(data);
            }
        }
        finally
        {
            CF.Release(query);
            CF.Release(acct);
            CF.Release(svc);
        }
    }

    public static int Delete(string service, string account)
    {
        var svc = CF.String(service);
        var acct = CF.String(account);
        var query = CF.Dictionary((K("kSecClass"), K("kSecClassGenericPassword")), (K("kSecAttrService"), svc), (K("kSecAttrAccount"), acct));
        try
        {
            return SecItemDelete(query);
        }
        finally
        {
            CF.Release(query);
            CF.Release(acct);
            CF.Release(svc);
        }
    }
}

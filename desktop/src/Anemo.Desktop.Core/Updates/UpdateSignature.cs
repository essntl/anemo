using System.Security.Cryptography;
using System.Text;

namespace Anemo.Desktop.Core.Updates;

/// <summary>
/// The release's own signature over its checksum file (docs/specs/23-desktop-auto-update.md,
/// "Signing"): ECDSA P-256 with SHA-256, made by release.yml with the
/// <c>DESKTOP_UPDATE_SIGNING_KEY</c> secret (<c>openssl dgst -sha256 -sign</c>, DER), checked
/// here with the public key compiled into the client. Built into .NET on Windows and macOS, so
/// no package is needed.
/// </summary>
public static class UpdateSignature
{
    /// <summary>The signature is beside the checksum file: <c>SHA256SUMS-desktop.txt.sig</c>.</summary>
    public const string Suffix = ".sig";

    /// <summary>A DER ECDSA P-256 signature is about 72 bytes.</summary>
    public const int MaxBytes = 1024;

    /// <summary>
    /// What is signed: one line naming the tag, then the checksum file as it is. The tag in it
    /// means a signed checksum file of one release can't be passed off as another release's.
    /// release.yml builds the same bytes with <c>printf 'anemo-desktop-update %s\n' "$tag"</c>.
    /// </summary>
    public static byte[] Message(string tag, byte[] checksums)
    {
        var head = Encoding.UTF8.GetBytes($"anemo-desktop-update {tag}\n");
        var message = new byte[head.Length + checksums.Length];
        head.CopyTo(message, 0);
        checksums.CopyTo(message, head.Length);
        return message;
    }

    /// <summary>True when <paramref name="signature"/> is the key's signature of the message.</summary>
    /// <param name="publicKey">The key as base64 of its SubjectPublicKeyInfo (DER), as release.yml's notes say how to make it.</param>
    public static bool Verify(string publicKey, string tag, byte[] checksums, byte[] signature)
    {
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKey), out _);
            return key.VerifyData(Message(tag, checksums), signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        }
        catch (Exception e) when (e is FormatException or CryptographicException)
        {
            return false;
        }
    }

    /// <summary>Whether the compiled-in key is usable at all (checked once, so a bad build says so instead of refusing every update quietly).</summary>
    public static bool IsKey(string publicKey)
    {
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKey), out _);
            return key.KeySize == 256;
        }
        catch (Exception e) when (e is FormatException or CryptographicException)
        {
            return false;
        }
    }
}

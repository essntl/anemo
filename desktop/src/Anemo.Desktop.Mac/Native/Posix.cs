using System.Runtime.InteropServices;

namespace Anemo.Desktop.Mac.Native;

/// <summary>
/// The C library calls that start and end a Claude Code job (docs/specs/09-desktop-macos.md D6):
/// <c>posix_spawn</c> with file actions (stdin/stdout/stderr on the job's files, the project
/// folder) and attributes (a new session, so the job leads its own process group and outlives
/// the app; default signal handling; no other inherited file), <c>kill</c> of the group.
/// </summary>
internal static unsafe partial class Posix
{
    private const string Lib = "/usr/lib/libSystem.B.dylib";

    // macOS values (sys/fcntl.h, spawn.h, sys/signal.h).
    public const int ReadOnly = 0x0000; // O_RDONLY
    public const int WriteOnly = 0x0001; // O_WRONLY
    public const int Create = 0x0200; // O_CREAT
    public const int Truncate = 0x0400; // O_TRUNC
    public const int CloseOnExec = 0x1000000; // O_CLOEXEC

    private const short SpawnSetSigDef = 0x0004; // POSIX_SPAWN_SETSIGDEF
    private const short SpawnSetSigMask = 0x0008; // POSIX_SPAWN_SETSIGMASK
    private const short SpawnSetSid = 0x0400; // POSIX_SPAWN_SETSID (macOS 10.15+)
    private const short SpawnCloexecDefault = 0x4000; // POSIX_SPAWN_CLOEXEC_DEFAULT (Apple)

    public const int SigKill = 9;
    public const int SigTerm = 15;
    public const int NoSuchProcess = 3; // ESRCH
    public const int NotPermitted = 1; // EPERM

    [LibraryImport(Lib, EntryPoint = "posix_spawnattr_init")]
    private static partial int SpawnAttrInit(nint* attr);

    [LibraryImport(Lib, EntryPoint = "posix_spawnattr_destroy")]
    private static partial int SpawnAttrDestroy(nint* attr);

    [LibraryImport(Lib, EntryPoint = "posix_spawnattr_setflags")]
    private static partial int SpawnAttrSetFlags(nint* attr, short flags);

    [LibraryImport(Lib, EntryPoint = "posix_spawnattr_setsigdefault")]
    private static partial int SpawnAttrSetSigDefault(nint* attr, uint* signals);

    [LibraryImport(Lib, EntryPoint = "posix_spawnattr_setsigmask")]
    private static partial int SpawnAttrSetSigMask(nint* attr, uint* signals);

    [LibraryImport(Lib, EntryPoint = "posix_spawn_file_actions_init")]
    private static partial int FileActionsInit(nint* actions);

    [LibraryImport(Lib, EntryPoint = "posix_spawn_file_actions_destroy")]
    private static partial int FileActionsDestroy(nint* actions);

    [LibraryImport(Lib, EntryPoint = "posix_spawn_file_actions_addopen", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int FileActionsAddOpen(nint* actions, int fd, string path, int flags, ushort mode);

    [LibraryImport(Lib, EntryPoint = "posix_spawn_file_actions_addchdir_np", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int FileActionsAddChdir(nint* actions, string path);

    [LibraryImport(Lib, EntryPoint = "posix_spawn", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int PosixSpawn(out int pid, string path, nint* actions, nint* attr, nint argv, nint envp);

    [LibraryImport(Lib, EntryPoint = "waitpid")]
    private static partial int WaitPid(int pid, out int status, int options);

    [LibraryImport(Lib, EntryPoint = "kill", SetLastError = true)]
    private static partial int Kill(int pid, int signal);

    [LibraryImport(Lib, EntryPoint = "getpgid", SetLastError = true)]
    public static partial int GetPgid(int pid);

    /// <summary>What a job's process is started with.</summary>
    public sealed record Spawn(
        string Program,
        IReadOnlyList<string> Arguments,
        string WorkingDirectory,
        string StdinPath,
        string StdoutPath,
        string StderrPath,
        IReadOnlyDictionary<string, string> Environment);

    /// <summary>
    /// Starts the program detached (its own session and process group) and returns its pid.
    /// A thread waits for it to end, so it never stays behind as a zombie (a zombie still
    /// answers <c>kill(pid, 0)</c> and would look like a running job).
    /// </summary>
    /// <exception cref="InvalidOperationException">With the errno when it couldn't start.</exception>
    public static int SpawnDetached(Spawn spawn)
    {
        nint attr = 0;
        nint actions = 0;
        Check(SpawnAttrInit(&attr), "posix_spawnattr_init");
        Check(FileActionsInit(&actions), "posix_spawn_file_actions_init");
        var argv = Strings([spawn.Program, .. spawn.Arguments]);
        var envp = Strings(spawn.Environment.Select(kv => kv.Key + "=" + kv.Value).ToList());
        try
        {
            Check(SpawnAttrSetFlags(&attr, SpawnSetSid | SpawnSetSigDef | SpawnSetSigMask | SpawnCloexecDefault), "setflags");
            uint all = 0xFFFFFFFF;
            uint none = 0;
            Check(SpawnAttrSetSigDefault(&attr, &all), "setsigdefault"); // the runtime ignores SIGPIPE; the job mustn't
            Check(SpawnAttrSetSigMask(&attr, &none), "setsigmask");
            Check(FileActionsAddOpen(&actions, 0, spawn.StdinPath, ReadOnly, 0), "stdin");
            Check(FileActionsAddOpen(&actions, 1, spawn.StdoutPath, WriteOnly | Create | Truncate, 0x1A4), "stdout"); // 0644
            Check(FileActionsAddOpen(&actions, 2, spawn.StderrPath, WriteOnly | Create | Truncate, 0x1A4), "stderr");
            Check(FileActionsAddChdir(&actions, spawn.WorkingDirectory), "chdir");
            Check(PosixSpawn(out var pid, spawn.Program, &actions, &attr, argv, envp), "posix_spawn");
            var reaper = new Thread(() => WaitPid(pid, out _, 0)) { IsBackground = true, Name = $"job {pid}" };
            reaper.Start();
            return pid;
        }
        finally
        {
            FileActionsDestroy(&actions);
            SpawnAttrDestroy(&attr);
            FreeStrings(argv);
            FreeStrings(envp);
        }
    }

    /// <summary>
    /// Sends <paramref name="signal"/> to the process group <paramref name="pgid"/>. True when
    /// it was sent or there is nobody left; false when macOS refused (another user's).
    /// </summary>
    public static bool SignalGroup(int pgid, int signal) => SignalResult(Kill(-pgid, signal));

    public static bool Signal(int pid, int signal) => SignalResult(Kill(pid, signal));

    /// <summary>Whether any process of the group is still there.</summary>
    public static bool GroupAlive(int pgid) => Kill(-pgid, 0) == 0 || Marshal.GetLastPInvokeError() == NotPermitted;

    private static bool SignalResult(int result) => result == 0 || Marshal.GetLastPInvokeError() == NoSuchProcess;

    private static void Check(int result, string what)
    {
        if (result != 0)
        {
            throw new InvalidOperationException($"{what} failed (errno {result}).");
        }
    }

    /// <summary>A NULL-terminated array of UTF-8 C strings (argv, envp).</summary>
    private static nint Strings(IReadOnlyList<string> values)
    {
        var array = Marshal.AllocHGlobal(IntPtr.Size * (values.Count + 1));
        for (var i = 0; i < values.Count; i++)
        {
            Marshal.WriteIntPtr(array, i * IntPtr.Size, Marshal.StringToCoTaskMemUTF8(values[i]));
        }

        Marshal.WriteIntPtr(array, values.Count * IntPtr.Size, 0);
        return array;
    }

    private static void FreeStrings(nint array)
    {
        for (var i = 0; ; i++)
        {
            var item = Marshal.ReadIntPtr(array, i * IntPtr.Size);
            if (item == 0)
            {
                break;
            }

            Marshal.FreeCoTaskMem(item);
        }

        Marshal.FreeHGlobal(array);
    }
}

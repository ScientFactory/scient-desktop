param(
  [string]$ExecutablePath = '',
  [string]$WorkingDirectory = '',
  [string]$AssemblyPath = '',
  [string]$CompileAssemblyPath = '',
  [string]$PreResumeMarkerPath = '',
  [string]$PreResumeGatePath = ''
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ScientPackagedStartupJobLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint FILE_TYPE_PIPE = 0x0003;
    private const int STD_INPUT_HANDLE = -10;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(IntPtr file);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PeekNamedPipe(
        IntPtr namedPipe,
        IntPtr buffer,
        uint bufferSize,
        IntPtr bytesRead,
        IntPtr totalBytesAvailable,
        IntPtr bytesLeftThisMessage
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static void EnsureVerifierControlConnected(IntPtr verifierControl)
    {
        // The verifier gives this launcher the read end of a fresh private pipe
        // at CreateProcess time and exclusively retains the write end. Unlike a
        // numeric PID, the inherited kernel object cannot be rebound to a later
        // process if the verifier exits before this launcher starts running.
        if (!PeekNamedPipe(
            verifierControl,
            IntPtr.Zero,
            0,
            IntPtr.Zero,
            IntPtr.Zero,
            IntPtr.Zero
        )) throw new InvalidOperationException("Packaged startup verifier control pipe closed.");
    }

    private static void AwaitPreResumeGate(
        string markerPath,
        string gatePath,
        uint childProcessId,
        IntPtr verifierControl
    )
    {
        EnsureVerifierControlConnected(verifierControl);
        bool hasMarker = !String.IsNullOrWhiteSpace(markerPath);
        bool hasGate = !String.IsNullOrWhiteSpace(gatePath);
        if (!hasMarker && !hasGate) return;
        if (!hasMarker || !hasGate)
            throw new ArgumentException("Pre-resume marker and gate paths must be supplied together.");

        File.WriteAllText(markerPath, childProcessId.ToString(CultureInfo.InvariantCulture));
        while (!File.Exists(gatePath))
        {
            EnsureVerifierControlConnected(verifierControl);
            System.Threading.Thread.Sleep(20);
        }
        EnsureVerifierControlConnected(verifierControl);
    }

    public static int Run(
        string executablePath,
        string workingDirectory,
        string preResumeMarkerPath,
        string preResumeGatePath
    )
    {
        if (executablePath.IndexOf('"') >= 0)
            throw new ArgumentException("Executable path contains an invalid quote.", "executablePath");

        IntPtr job = IntPtr.Zero;
        IntPtr information = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        IntPtr verifierControl = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        try
        {
            verifierControl = GetStdHandle(STD_INPUT_HANDLE);
            if (verifierControl == IntPtr.Zero || verifierControl == new IntPtr(-1))
                ThrowLastError("GetStdHandle for verifier control failed");
            if (GetFileType(verifierControl) != FILE_TYPE_PIPE)
                throw new InvalidOperationException("Verifier control must be a private inherited pipe.");
            EnsureVerifierControlConnected(verifierControl);

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastError("CreateJobObject failed");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int informationSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            information = Marshal.AllocHGlobal(informationSize);
            Marshal.StructureToPtr(limits, information, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                information,
                (uint)informationSize
            )) ThrowLastError("SetInformationJobObject failed");

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            if (
                Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER ||
                attributeListSize == IntPtr.Zero
            ) ThrowLastError("InitializeProcThreadAttributeList sizing failed");
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize))
                ThrowLastError("InitializeProcThreadAttributeList failed");

            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobList,
                new IntPtr(IntPtr.Size),
                IntPtr.Zero,
                IntPtr.Zero
            )) ThrowLastError("UpdateProcThreadAttribute for Job Object failed");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributeList;
            StringBuilder commandLine = new StringBuilder("\"" + executablePath + "\"");
            if (!CreateProcess(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out child
            )) ThrowLastError("CreateProcess failed");
            // PROC_THREAD_ATTRIBUTE_JOB_LIST makes Job membership atomic with
            // process creation, before this launcher can be interrupted and
            // before any native payload instruction is allowed to execute.
            AwaitPreResumeGate(
                preResumeMarkerPath,
                preResumeGatePath,
                child.dwProcessId,
                verifierControl
            );
            if (ResumeThread(child.hThread) == UInt32.MaxValue)
                ThrowLastError("ResumeThread failed");

            while (true)
            {
                uint payloadWait = WaitForSingleObject(child.hProcess, 20);
                if (payloadWait == WAIT_OBJECT_0) break;
                if (payloadWait == WAIT_FAILED) ThrowLastError("Payload liveness wait failed");
                if (payloadWait != WAIT_TIMEOUT)
                    throw new InvalidOperationException("Unexpected payload liveness wait result.");
                EnsureVerifierControlConnected(verifierControl);
            }
            uint exitCode;
            if (!GetExitCodeProcess(child.hProcess, out exitCode))
                ThrowLastError("GetExitCodeProcess failed");
            return unchecked((int)exitCode);
        }
        finally
        {
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (attributeList != IntPtr.Zero) DeleteProcThreadAttributeList(attributeList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
            // Closing the final job handle atomically terminates every process
            // that Electron created inside the kill-on-close job.
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

if (![string]::IsNullOrWhiteSpace($CompileAssemblyPath)) {
  Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $CompileAssemblyPath -OutputType Library
  exit 0
}

if (
  [string]::IsNullOrWhiteSpace($AssemblyPath) -or
  [string]::IsNullOrWhiteSpace($ExecutablePath) -or
  [string]::IsNullOrWhiteSpace($WorkingDirectory)
) {
  throw 'AssemblyPath, ExecutablePath, and WorkingDirectory are required for launch.'
}

# Load only the assembly compiled during the separately classified preparation
# phase. Runtime launch must not create compiler descendants before Job authority.
Add-Type -Path $AssemblyPath

# CreateProcess inherits this launcher's process environment. Binding the
# verifier authority to this retained direct parent gives Windows the same
# non-inheritable-by-accident contract as the POSIX sentinel.
[Environment]::SetEnvironmentVariable(
  'SCIENT_PACKAGED_STARTUP_SENTINEL_PID',
  [string]$PID,
  'Process'
)
exit [ScientPackagedStartupJobLauncher]::Run(
  $ExecutablePath,
  $WorkingDirectory,
  $PreResumeMarkerPath,
  $PreResumeGatePath
)

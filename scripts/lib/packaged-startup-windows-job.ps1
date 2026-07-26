param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ScientPackagedStartupJobLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;

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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

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
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public static int Run(string executablePath, string workingDirectory)
    {
        if (executablePath.IndexOf('"') >= 0)
            throw new ArgumentException("Executable path contains an invalid quote.", "executablePath");

        IntPtr job = IntPtr.Zero;
        IntPtr information = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool childCreated = false;
        bool childAssigned = false;
        try
        {
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

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            StringBuilder commandLine = new StringBuilder("\"" + executablePath + "\"");
            if (!CreateProcess(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out child
            )) ThrowLastError("CreateProcess failed");
            childCreated = true;

            if (!AssignProcessToJobObject(job, child.hProcess))
                ThrowLastError("AssignProcessToJobObject failed");
            childAssigned = true;
            if (ResumeThread(child.hThread) == UInt32.MaxValue)
                ThrowLastError("ResumeThread failed");

            WaitForSingleObject(child.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(child.hProcess, out exitCode))
                ThrowLastError("GetExitCodeProcess failed");
            return unchecked((int)exitCode);
        }
        finally
        {
            if (childCreated && !childAssigned && child.hProcess != IntPtr.Zero)
            {
                TerminateProcess(child.hProcess, 1);
                WaitForSingleObject(child.hProcess, INFINITE);
            }
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
            // Closing the final job handle atomically terminates every process
            // that Electron created inside the kill-on-close job.
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
exit [ScientPackagedStartupJobLauncher]::Run($ExecutablePath, $WorkingDirectory)

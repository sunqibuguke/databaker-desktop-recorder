@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DataBaker capture hardware collector
echo.
echo  DataBaker 采集硬件信息收集
echo  在出问题的 Windows 工位上双击运行。
echo  会在本文件旁边和桌面各写一份 UTF-8 报告（txt + json）。
echo  不录音、不改系统设置；会短暂尝试独占开流并立刻释放。
echo.
set "PROBE_SELF=%~f0"
set "PROBE_DIR=%~dp0"
set "PROBE_PS=%TEMP%\collect-capture-hardware-%RANDOM%%RANDOM%.ps1"
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -Command "$p=$env:PROBE_SELF; $out=$env:PROBE_PS; if(-not $p){ throw 'PROBE_SELF is empty' }; $ls=@(Get-Content -LiteralPath $p -Encoding UTF8); $n=-1; for($i=0;$i -lt $ls.Count;$i++){ if($ls[$i].Trim() -eq '# <PS>'){ $n=$i+1; break } }; if($n -lt 0){ throw 'embedded script marker not found' }; $utf8=New-Object System.Text.UTF8Encoding $true; [System.IO.File]::WriteAllLines($out, @($ls[$n..($ls.Count-1)]), $utf8)"
if errorlevel 1 (
  echo Failed to extract the embedded PowerShell script.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%PROBE_PS%"
set "ERR=%ERRORLEVEL%"
del /q "%PROBE_PS%" >nul 2>nul
echo.
pause
exit /b %ERR%

# <PS>
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = [Console]::OutputEncoding
} catch {}

if (-not ('WasapiCaptureInventory.Native' -as [type])) {
try {
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace WasapiCaptureInventory
{
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant
    {
        public ushort vt;
        public ushort reserved1;
        public ushort reserved2;
        public ushort reserved3;
        public IntPtr data1;
        public IntPtr data2;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct WaveFormatEx
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct WaveFormatExtensible
    {
        public WaveFormatEx Format;
        public ushort wValidBitsPerSample;
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    public class ExclusiveHit
    {
        public uint Rate { get; set; }
        public ushort Channels { get; set; }
        public string Format { get; set; }
        public string Mask { get; set; }
        public bool InEngineGrid { get; set; }
    }

    public class InitAttempt
    {
        public uint Rate { get; set; }
        public ushort Channels { get; set; }
        public string Format { get; set; }
        public string Mask { get; set; }
        public string SupportedHr { get; set; }
        public string InitializeHr { get; set; }
        public string Note { get; set; }
    }

    public class DeviceProbe
    {
        public string Name { get; set; }
        public string Id { get; set; }
        public bool IsDefaultConsole { get; set; }
        public bool IsDefaultMultimedia { get; set; }
        public bool IsDefaultCommunications { get; set; }
        public int State { get; set; }
        public string MixSummary { get; set; }
        public uint MixRate { get; set; }
        public ushort MixChannels { get; set; }
        public ushort MixContainerBits { get; set; }
        public ushort MixValidBits { get; set; }
        public string MixTag { get; set; }
        public string ExclusiveAllowed { get; set; }
        public string ExclusivePriority { get; set; }
        public string FormFactor { get; set; }
        public string DeviceDesc { get; set; }
        public string InterfaceName { get; set; }
        public string ActivateHr { get; set; }
        public ExclusiveHit[] Hits { get; set; }
        public string[] SampleAttempts { get; set; }
        public InitAttempt[] InitAttempts { get; set; }
        public string HresultSummary { get; set; }
        public string DominantExclusiveHr { get; set; }
        public bool HasEngineGridHit { get; set; }
        public bool HasExtraHitOnly { get; set; }
        public bool Init48kI16Ok { get; set; }
        public bool Init48kI24Ok { get; set; }
        public bool Init48kF32Ok { get; set; }
        public bool Init44100I24Ok { get; set; }
    }

    public static class Native
    {
        public const int ECapture = 1;
        public const int DeviceStateActive = 1;
        public const int RoleConsole = 0;
        public const int RoleMultimedia = 1;
        public const int RoleCommunications = 2;
        public const int ClsCtxAll = 23;
        public const int ShareShared = 0;
        public const int ShareExclusive = 1;
        public const ushort WaveFormatPcm = 1;
        public const ushort WaveFormatIeeeFloat = 3;
        public const ushort WaveFormatExtensible = 0xFFFE;
        public const int VtEmpty = 0;
        public const int VtUi4 = 19;
        public const int VtBool = 11;
        public const int VtLpwstr = 31;
        public const uint AudclntBufferNotAligned = 0x88890019;

        public static readonly Guid AudioClientIid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        public static readonly Guid SubtypePcm = new Guid("00000001-0000-0010-8000-00AA00389B71");
        public static readonly Guid SubtypeIeeeFloat = new Guid("00000003-0000-0010-8000-00AA00389B71");
        public static readonly PropertyKey PkeyFriendlyName = Key("a45c254e-df1c-4efd-8020-67d146a850e0", 14);
        public static readonly PropertyKey PkeyDeviceDesc = Key("a45c254e-df1c-4efd-8020-67d146a850e0", 2);
        public static readonly PropertyKey PkeyInterfaceName = Key("026e516e-b814-414b-83cd-856d6fef4822", 2);
        public static readonly PropertyKey PkeyExclusiveAllow = Key("b3f8fa53-0004-438e-9003-51a46e139bfc", 3);
        public static readonly PropertyKey PkeyExclusivePriority = Key("b3f8fa53-0004-438e-9003-51a46e139bfc", 4);
        public static readonly PropertyKey PkeyFormFactor = Key("1da5d803-d492-4edd-8c23-e0c0ffee7f0e", 0);

        public static readonly uint[] ProbeRates = new uint[] {
            8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000
        };
        public static readonly ushort[] ProbeChannels = new ushort[] { 1, 2, 4, 6, 8 };

        [DllImport("ole32.dll")]
        private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr ppv);

        [DllImport("ole32.dll")]
        private static extern void CoTaskMemFree(IntPtr pv);

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant pvar);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int EnumAudioEndpointsFn(IntPtr self, int dataFlow, int stateMask, out IntPtr devices);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetDefaultAudioEndpointFn(IntPtr self, int dataFlow, int role, out IntPtr device);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetCountFn(IntPtr self, out uint count);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ItemFn(IntPtr self, uint index, out IntPtr device);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int ActivateFn(IntPtr self, ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int OpenPropertyStoreFn(IntPtr self, int access, out IntPtr store);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetIdFn(IntPtr self, out IntPtr id);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetStateFn(IntPtr self, out int state);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetValueFn(IntPtr self, ref PropertyKey key, out PropVariant value);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int IsFormatSupportedFn(IntPtr self, int shareMode, IntPtr format, IntPtr closestMatch);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetMixFormatFn(IntPtr self, out IntPtr format);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int InitializeFn(IntPtr self, int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetDevicePeriodFn(IntPtr self, out long defaultPeriod, out long minPeriod);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetBufferSizeFn(IntPtr self, out uint frames);

        private static Delegate VCall(IntPtr obj, int slot, Type delegateType)
        {
            IntPtr vtbl = Marshal.ReadIntPtr(obj);
            IntPtr fn = Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size);
            return Marshal.GetDelegateForFunctionPointer(fn, delegateType);
        }

        public static DeviceProbe[] Run()
        {
            Guid clsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
            Guid enumeratorIid = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
            IntPtr enumerator;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref enumeratorIid, out enumerator);
            if (hr != 0 || enumerator == IntPtr.Zero)
            {
                throw new InvalidOperationException("CoCreateInstance MMDeviceEnumerator failed: " + HrName(hr));
            }

            try
            {
                string consoleId = DefaultId(enumerator, RoleConsole);
                string multimediaId = DefaultId(enumerator, RoleMultimedia);
                string communicationsId = DefaultId(enumerator, RoleCommunications);

                IntPtr collection;
                EnumAudioEndpointsFn enumFn = (EnumAudioEndpointsFn)VCall(enumerator, 3, typeof(EnumAudioEndpointsFn));
                hr = enumFn(enumerator, ECapture, DeviceStateActive, out collection);
                if (hr != 0 || collection == IntPtr.Zero)
                {
                    throw new InvalidOperationException("EnumAudioEndpoints failed: " + HrName(hr));
                }

                try
                {
                    uint count;
                    GetCountFn getCount = (GetCountFn)VCall(collection, 3, typeof(GetCountFn));
                    hr = getCount(collection, out count);
                    if (hr != 0)
                    {
                        throw new InvalidOperationException("IMMDeviceCollection.GetCount failed: " + HrName(hr));
                    }

                    ItemFn itemFn = (ItemFn)VCall(collection, 4, typeof(ItemFn));
                    List<DeviceProbe> results = new List<DeviceProbe>();
                    for (uint i = 0; i < count; i++)
                    {
                        IntPtr device;
                        if (itemFn(collection, i, out device) != 0 || device == IntPtr.Zero)
                        {
                            continue;
                        }
                        try { results.Add(ProbeDevice(device, consoleId, multimediaId, communicationsId)); }
                        finally { Marshal.Release(device); }
                    }
                    return results.ToArray();
                }
                finally
                {
                    Marshal.Release(collection);
                }
            }
            finally
            {
                Marshal.Release(enumerator);
            }
        }

        private static string DefaultId(IntPtr enumerator, int role)
        {
            IntPtr device;
            GetDefaultAudioEndpointFn getDefault = (GetDefaultAudioEndpointFn)VCall(enumerator, 4, typeof(GetDefaultAudioEndpointFn));
            if (getDefault(enumerator, ECapture, role, out device) != 0 || device == IntPtr.Zero)
            {
                return null;
            }
            try { return DeviceId(device); }
            finally { Marshal.Release(device); }
        }

        private static DeviceProbe ProbeDevice(IntPtr device, string consoleId, string multimediaId, string communicationsId)
        {
            DeviceProbe result = new DeviceProbe();
            result.Hits = new ExclusiveHit[0];
            result.SampleAttempts = new string[0];
            result.InitAttempts = new InitAttempt[0];
            result.ExclusiveAllowed = "default-allow";
            result.ExclusivePriority = "default";
            result.ActivateHr = "";
            result.MixSummary = "";
            result.MixTag = "";
            result.DominantExclusiveHr = "";
            result.HresultSummary = "";
            result.FormFactor = "";
            result.DeviceDesc = "";
            result.InterfaceName = "";

            string id = DeviceId(device);
            result.Id = id ?? "";
            result.IsDefaultConsole = IdsEqual(consoleId, id);
            result.IsDefaultMultimedia = IdsEqual(multimediaId, id);
            result.IsDefaultCommunications = IdsEqual(communicationsId, id);

            GetStateFn getState = (GetStateFn)VCall(device, 6, typeof(GetStateFn));
            int state;
            getState(device, out state);
            result.State = state;
            result.Name = ReadFriendlyName(device, result.Id);
            result.DeviceDesc = ReadStringProp(device, PkeyDeviceDesc) ?? "";
            result.InterfaceName = ReadStringProp(device, PkeyInterfaceName) ?? "";
            result.FormFactor = FormFactorName(ReadUIntProp(device, PkeyFormFactor));

            string allow;
            string priority;
            ReadExclusivePolicy(device, result.Id, out allow, out priority);
            result.ExclusiveAllowed = allow;
            result.ExclusivePriority = priority;

            Guid iid = AudioClientIid;
            IntPtr client;
            ActivateFn activate = (ActivateFn)VCall(device, 3, typeof(ActivateFn));
            int activateHr = activate(device, ref iid, ClsCtxAll, IntPtr.Zero, out client);
            if (activateHr != 0 || client == IntPtr.Zero)
            {
                result.ActivateHr = HrName(activateHr);
                return result;
            }

            try
            {
                IntPtr mixPtr;
                GetMixFormatFn getMix = (GetMixFormatFn)VCall(client, 8, typeof(GetMixFormatFn));
                int mixHr = getMix(client, out mixPtr);
                if (mixHr != 0 || mixPtr == IntPtr.Zero)
                {
                    result.ActivateHr = "GetMixFormat " + HrName(mixHr);
                    return result;
                }

                try
                {
                    WaveFormatEx mix = (WaveFormatEx)Marshal.PtrToStructure(mixPtr, typeof(WaveFormatEx));
                    result.MixRate = mix.nSamplesPerSec;
                    result.MixChannels = mix.nChannels;
                    result.MixContainerBits = mix.wBitsPerSample;
                    result.MixValidBits = mix.wBitsPerSample;
                    result.MixTag = WaveTag(mix.wFormatTag);
                    if (mix.wFormatTag == WaveFormatExtensible)
                    {
                        WaveFormatExtensible ext = (WaveFormatExtensible)Marshal.PtrToStructure(mixPtr, typeof(WaveFormatExtensible));
                        result.MixValidBits = ext.wValidBitsPerSample;
                        result.MixTag = "EXTENSIBLE" + SubtypeName(ext.SubFormat);
                    }
                    result.MixSummary = DescribeWave(mixPtr);
                    result = ProbeFormats(client, device, result);
                }
                finally
                {
                    CoTaskMemFree(mixPtr);
                }
            }
            finally
            {
                Marshal.Release(client);
            }
            return result;
        }

        private static DeviceProbe ProbeFormats(IntPtr client, IntPtr device, DeviceProbe result)
        {
            List<ExclusiveHit> hits = new List<ExclusiveHit>();
            List<string> samples = new List<string>();
            Dictionary<string, int> counts = new Dictionary<string, int>();
            Candidate[] flavors = BuildFlavors();

            List<uint> rates = new List<uint>(ProbeRates);
            if (result.MixRate != 0 && !rates.Contains(result.MixRate)) rates.Add(result.MixRate);
            List<ushort> channels = new List<ushort>(ProbeChannels);
            if (result.MixChannels != 0 && !channels.Contains(result.MixChannels)) channels.Add(result.MixChannels);

            for (int r = 0; r < rates.Count; r++)
            {
                for (int c = 0; c < channels.Count; c++)
                {
                    for (int f = 0; f < flavors.Length; f++)
                    {
                        Candidate flavor = flavors[f];
                        uint[] masks = flavor.Extensible ? ExclusiveMasks(channels[c]) : new uint[] { flavor.DefaultMask };
                        for (int m = 0; m < masks.Length; m++)
                        {
                            int hr = CheckFormat(client, ShareExclusive, rates[r], channels[c], flavor, masks[m]);
                            string hrName = HrName(hr);
                            if (!counts.ContainsKey(hrName)) counts[hrName] = 0;
                            counts[hrName] = counts[hrName] + 1;

                            bool representative = rates[r] == result.MixRate && channels[c] == result.MixChannels && m == 0;
                            if (representative)
                            {
                                samples.Add(string.Format("{0} {1}ch {2} -> {3}", rates[r], channels[c], flavor.Name, hrName));
                            }
                            if (hr == 0)
                            {
                                ExclusiveHit hit = new ExclusiveHit();
                                hit.Rate = rates[r];
                                hit.Channels = channels[c];
                                hit.Format = flavor.Name;
                                hit.Mask = MaskName(masks[m], flavor.Extensible);
                                hit.InEngineGrid = flavor.InEngineGrid;
                                hits.Add(hit);
                            }
                        }
                    }
                }
            }

            result.Hits = hits.ToArray();
            result.SampleAttempts = samples.ToArray();
            result.HresultSummary = JoinCounts(counts);
            result.DominantExclusiveHr = Dominant(counts);
            bool engineHit = false;
            bool extraHit = false;
            for (int i = 0; i < hits.Count; i++)
            {
                if (hits[i].InEngineGrid) engineHit = true;
                else extraHit = true;
            }
            result.HasEngineGridHit = engineHit;
            result.HasExtraHitOnly = extraHit && !engineHit;
            result.InitAttempts = RunInitializeGrid(device, client, result, flavors).ToArray();
            for (int i = 0; i < result.InitAttempts.Length; i++)
            {
                InitAttempt attempt = result.InitAttempts[i];
                if (attempt.InitializeHr != "S_OK") continue;
                if (attempt.Rate == 48000 && attempt.Format.StartsWith("i16")) result.Init48kI16Ok = true;
                if (attempt.Rate == 48000 && attempt.Format.IndexOf("i24", StringComparison.Ordinal) >= 0) result.Init48kI24Ok = true;
                if (attempt.Rate == 48000 && attempt.Format.StartsWith("f32")) result.Init48kF32Ok = true;
                if (attempt.Rate == 44100 && attempt.Format.IndexOf("i24", StringComparison.Ordinal) >= 0) result.Init44100I24Ok = true;
            }
            return result;
        }

        private static List<InitAttempt> RunInitializeGrid(IntPtr device, IntPtr queryClient, DeviceProbe result, Candidate[] flavors)
        {
            List<InitSpec> specs = new List<InitSpec>();
            AddInit(specs, 48000, 1, "i16-pcm");
            AddInit(specs, 48000, 2, "i16-pcm");
            AddInit(specs, 48000, 1, "i16-ext");
            AddInit(specs, 48000, 2, "i16-ext");
            AddInit(specs, 48000, 1, "i24-in-32-ext");
            AddInit(specs, 48000, 2, "i24-in-32-ext");
            AddInit(specs, 48000, 2, "packed24-pcm");
            AddInit(specs, 48000, 2, "i32-ext");
            AddInit(specs, 48000, 2, "f32-ext");
            AddInit(specs, 44100, 2, "i16-pcm");
            AddInit(specs, 44100, 2, "i24-in-32-ext");
            AddInit(specs, 96000, 2, "i24-in-32-ext");
            if (result.MixRate != 0)
            {
                AddInit(specs, result.MixRate, result.MixChannels, "i16-pcm");
                AddInit(specs, result.MixRate, result.MixChannels, "i24-in-32-ext");
                AddInit(specs, result.MixRate, result.MixChannels, "f32-ext");
            }

            Dictionary<string, bool> seen = new Dictionary<string, bool>(StringComparer.Ordinal);
            List<InitAttempt> attempts = new List<InitAttempt>();
            for (int i = 0; i < specs.Count; i++)
            {
                InitSpec spec = specs[i];
                Candidate flavor = FindFlavor(flavors, spec.Format);
                if (flavor == null) continue;
                uint[] masks = flavor.Extensible ? ExclusiveMasks(spec.Channels) : new uint[] { 0 };
                uint mask = masks[0];
                string key = spec.Rate + "|" + spec.Channels + "|" + spec.Format + "|" + mask;
                if (seen.ContainsKey(key)) continue;
                seen[key] = true;

                InitAttempt attempt = new InitAttempt();
                attempt.Rate = spec.Rate;
                attempt.Channels = spec.Channels;
                attempt.Format = spec.Format;
                attempt.Mask = MaskName(mask, flavor.Extensible);
                int supported = CheckFormat(queryClient, ShareExclusive, spec.Rate, spec.Channels, flavor, mask);
                attempt.SupportedHr = HrName(supported);
                string note;
                attempt.InitializeHr = TryInitializeExclusive(device, spec.Rate, spec.Channels, flavor, mask, out note);
                attempt.Note = note;
                attempts.Add(attempt);
            }
            return attempts;
        }

        private struct InitSpec
        {
            public uint Rate;
            public ushort Channels;
            public string Format;
        }

        private static void AddInit(List<InitSpec> specs, uint rate, ushort channels, string format)
        {
            if (rate == 0 || channels == 0) return;
            InitSpec spec = new InitSpec();
            spec.Rate = rate;
            spec.Channels = channels;
            spec.Format = format;
            specs.Add(spec);
        }

        private static Candidate FindFlavor(Candidate[] flavors, string name)
        {
            for (int i = 0; i < flavors.Length; i++)
            {
                if (flavors[i].Name == name) return flavors[i];
            }
            return null;
        }

        private static string TryInitializeExclusive(IntPtr device, uint rate, ushort channels, Candidate flavor, uint mask, out string note)
        {
            note = "";
            Guid iid = AudioClientIid;
            ActivateFn activate = (ActivateFn)VCall(device, 3, typeof(ActivateFn));
            IntPtr client;
            int activateHr = activate(device, ref iid, ClsCtxAll, IntPtr.Zero, out client);
            if (activateHr != 0 || client == IntPtr.Zero)
            {
                note = "activate";
                return HrName(activateHr);
            }

            try
            {
                long defaultPeriod = 0;
                long minPeriod = 0;
                GetDevicePeriodFn getPeriod = (GetDevicePeriodFn)VCall(client, 9, typeof(GetDevicePeriodFn));
                getPeriod(client, out defaultPeriod, out minPeriod);
                long period = defaultPeriod > 0 ? defaultPeriod : 100000;

                IntPtr formatPtr = AllocFormat(rate, channels, flavor, mask);
                try
                {
                    InitializeFn initialize = (InitializeFn)VCall(client, 3, typeof(InitializeFn));
                    int hr = initialize(client, ShareExclusive, 0, period, period, formatPtr, IntPtr.Zero);
                    uint code = unchecked((uint)hr);
                    if (code != AudclntBufferNotAligned)
                    {
                        if (hr == 0) note = "period=" + period;
                        return HrName(hr);
                    }

                    uint frames = 0;
                    GetBufferSizeFn getBuffer = (GetBufferSizeFn)VCall(client, 4, typeof(GetBufferSizeFn));
                    getBuffer(client, out frames);
                    Marshal.Release(client);
                    client = IntPtr.Zero;
                    if (frames == 0)
                    {
                        note = "align-retry-no-frames";
                        return HrName(hr);
                    }

                    activateHr = activate(device, ref iid, ClsCtxAll, IntPtr.Zero, out client);
                    if (activateHr != 0 || client == IntPtr.Zero)
                    {
                        note = "align-reactivate";
                        return HrName(activateHr);
                    }
                    period = (long)frames * 10000000L / rate;
                    initialize = (InitializeFn)VCall(client, 3, typeof(InitializeFn));
                    hr = initialize(client, ShareExclusive, 0, period, period, formatPtr, IntPtr.Zero);
                    note = "aligned-frames=" + frames + " period=" + period;
                    return HrName(hr);
                }
                finally
                {
                    Marshal.FreeHGlobal(formatPtr);
                }
            }
            finally
            {
                if (client != IntPtr.Zero) Marshal.Release(client);
            }
        }

        private sealed class Candidate
        {
            public string Name;
            public ushort Tag;
            public ushort ContainerBits;
            public ushort ValidBits;
            public bool Float;
            public bool Extensible;
            public bool InEngineGrid;
            public uint DefaultMask;
        }

        private static Candidate[] BuildFlavors()
        {
            return new Candidate[] {
                Flavor("i16-pcm", WaveFormatPcm, 16, 16, false, false, true),
                Flavor("i16-ext", WaveFormatExtensible, 16, 16, false, true, false),
                Flavor("i24-in-32-ext", WaveFormatExtensible, 32, 24, false, true, true),
                Flavor("packed24-pcm", WaveFormatPcm, 24, 24, false, false, false),
                Flavor("i32-ext", WaveFormatExtensible, 32, 32, false, true, true),
                Flavor("f32-ext", WaveFormatExtensible, 32, 32, true, true, true),
                Flavor("f32-ieee", WaveFormatIeeeFloat, 32, 32, true, false, false)
            };
        }

        private static Candidate Flavor(string name, ushort tag, ushort containerBits, ushort validBits, bool isFloat, bool extensible, bool inEngineGrid)
        {
            Candidate item = new Candidate();
            item.Name = name;
            item.Tag = tag;
            item.ContainerBits = containerBits;
            item.ValidBits = validBits;
            item.Float = isFloat;
            item.Extensible = extensible;
            item.InEngineGrid = inEngineGrid;
            item.DefaultMask = 0;
            return item;
        }

        private static int CheckFormat(IntPtr client, int shareMode, uint rate, ushort channels, Candidate flavor, uint mask)
        {
            IntPtr ptr = AllocFormat(rate, channels, flavor, mask);
            try
            {
                IsFormatSupportedFn isSupported = (IsFormatSupportedFn)VCall(client, 7, typeof(IsFormatSupportedFn));
                return isSupported(client, shareMode, ptr, IntPtr.Zero);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        private static IntPtr AllocFormat(uint rate, ushort channels, Candidate flavor, uint mask)
        {
            WaveFormatExtensible format = new WaveFormatExtensible();
            ushort bytes = (ushort)(flavor.ContainerBits / 8);
            format.Format.wFormatTag = flavor.Tag;
            format.Format.nChannels = channels;
            format.Format.nSamplesPerSec = rate;
            format.Format.nBlockAlign = (ushort)(channels * bytes);
            format.Format.nAvgBytesPerSec = rate * format.Format.nBlockAlign;
            format.Format.wBitsPerSample = flavor.ContainerBits;
            format.Format.cbSize = flavor.Extensible ? (ushort)22 : (ushort)0;
            format.wValidBitsPerSample = flavor.ValidBits;
            format.dwChannelMask = mask;
            format.SubFormat = flavor.Float ? SubtypeIeeeFloat : SubtypePcm;
            IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WaveFormatExtensible)));
            Marshal.StructureToPtr(format, ptr, false);
            return ptr;
        }

        private static uint[] ExclusiveMasks(ushort channels)
        {
            uint speaker = 0;
            if (channels == 1) speaker = 0x4;
            else if (channels == 2) speaker = 0x1 | 0x2;
            else if (channels == 4) speaker = 0x1 | 0x2 | 0x10 | 0x20;
            else if (channels == 6) speaker = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20;
            else if (channels == 8) speaker = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x200 | 0x400;
            if (speaker == 0) return new uint[] { 0 };
            return new uint[] { speaker, 0 };
        }

        private static string MaskName(uint mask, bool extensible)
        {
            if (!extensible) return "-";
            if (mask == 0) return "DIRECTOUT";
            if (mask == 0x4) return "FC";
            if (mask == 0x3) return "FL+FR";
            return "0x" + mask.ToString("X");
        }

        private static string DeviceId(IntPtr device)
        {
            IntPtr pId;
            GetIdFn getId = (GetIdFn)VCall(device, 5, typeof(GetIdFn));
            if (getId(device, out pId) != 0 || pId == IntPtr.Zero) return "";
            try { return Marshal.PtrToStringUni(pId) ?? ""; }
            finally { CoTaskMemFree(pId); }
        }

        private static bool IdsEqual(string left, string right)
        {
            return !string.IsNullOrEmpty(left) && string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }

        private static string ReadFriendlyName(IntPtr device, string id)
        {
            string name = ReadStringProp(device, PkeyFriendlyName);
            return string.IsNullOrEmpty(name) ? id : name;
        }

        private static void ReadExclusivePolicy(IntPtr device, string id, out string allow, out string priority)
        {
            allow = FormatPolicy(ReadUIntProp(device, PkeyExclusiveAllow), "allow", "deny");
            priority = FormatPolicy(ReadUIntProp(device, PkeyExclusivePriority), "on", "off");
            if (allow != "unset" && priority != "unset") return;

            string guid = EndpointGuid(id);
            if (guid == null)
            {
                if (allow == "unset") allow = "default-allow";
                if (priority == "unset") priority = "default";
                return;
            }

            try
            {
                string keyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\" + guid + @"\Properties";
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(keyPath))
                {
                    if (key != null)
                    {
                        if (allow == "unset")
                        {
                            allow = FormatPolicy(ReadRegistryUInt(key, "{b3f8fa53-0004-438e-9003-51a46e139bfc},3"), "allow", "deny");
                        }
                        if (priority == "unset")
                        {
                            priority = FormatPolicy(ReadRegistryUInt(key, "{b3f8fa53-0004-438e-9003-51a46e139bfc},4"), "on", "off");
                        }
                    }
                }
            }
            catch { }

            if (allow == "unset") allow = "default-allow";
            if (priority == "unset") priority = "default";
        }

        private static string FormatPolicy(int? value, string onText, string offText)
        {
            if (!value.HasValue) return "unset";
            return value.Value != 0 ? onText : offText;
        }

        private static int? ReadRegistryUInt(RegistryKey key, string name)
        {
            object value = key.GetValue(name);
            if (value is int) return (int)value;
            byte[] bytes = value as byte[];
            if (bytes != null && bytes.Length >= 4) return BitConverter.ToInt32(bytes, 0);
            return null;
        }

        private static string EndpointGuid(string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            int dot = id.LastIndexOf('.');
            if (dot < 0 || dot + 1 >= id.Length) return null;
            return id.Substring(dot + 1);
        }

        private static string ReadStringProp(IntPtr device, PropertyKey key)
        {
            IntPtr store = OpenStore(device);
            if (store == IntPtr.Zero) return null;
            try
            {
                PropVariant variant;
                GetValueFn getValue = (GetValueFn)VCall(store, 5, typeof(GetValueFn));
                if (getValue(store, ref key, out variant) != 0) return null;
                try
                {
                    if (variant.vt == VtLpwstr && variant.data1 != IntPtr.Zero)
                    {
                        return Marshal.PtrToStringUni(variant.data1);
                    }
                    return null;
                }
                finally { PropVariantClear(ref variant); }
            }
            finally { Marshal.Release(store); }
        }

        private static int? ReadUIntProp(IntPtr device, PropertyKey key)
        {
            IntPtr store = OpenStore(device);
            if (store == IntPtr.Zero) return null;
            try
            {
                PropVariant variant;
                GetValueFn getValue = (GetValueFn)VCall(store, 5, typeof(GetValueFn));
                if (getValue(store, ref key, out variant) != 0) return null;
                try
                {
                    if (variant.vt == VtEmpty) return null;
                    if (variant.vt == VtUi4 || variant.vt == VtBool)
                    {
                        return (int)(variant.data1.ToInt64() & 0xFFFFFFFF);
                    }
                    return null;
                }
                finally { PropVariantClear(ref variant); }
            }
            finally { Marshal.Release(store); }
        }

        private static IntPtr OpenStore(IntPtr device)
        {
            IntPtr store;
            OpenPropertyStoreFn open = (OpenPropertyStoreFn)VCall(device, 4, typeof(OpenPropertyStoreFn));
            if (open(device, 0, out store) != 0) return IntPtr.Zero;
            return store;
        }

        private static string DescribeWave(IntPtr ptr)
        {
            WaveFormatEx format = (WaveFormatEx)Marshal.PtrToStructure(ptr, typeof(WaveFormatEx));
            string tag = WaveTag(format.wFormatTag);
            ushort valid = format.wBitsPerSample;
            string sub = "";
            string mask = "";
            if (format.wFormatTag == WaveFormatExtensible)
            {
                WaveFormatExtensible ext = (WaveFormatExtensible)Marshal.PtrToStructure(ptr, typeof(WaveFormatExtensible));
                tag = "EXTENSIBLE";
                valid = ext.wValidBitsPerSample;
                sub = SubtypeName(ext.SubFormat);
                mask = " mask=" + MaskName(ext.dwChannelMask, true);
            }
            return string.Format("{0} Hz / {1}ch / {2}{3} container={4} valid={5}{6}",
                format.nSamplesPerSec, format.nChannels, tag, sub, format.wBitsPerSample, valid, mask);
        }

        private static string WaveTag(ushort tag)
        {
            if (tag == WaveFormatPcm) return "PCM";
            if (tag == WaveFormatIeeeFloat) return "IEEE_FLOAT";
            if (tag == WaveFormatExtensible) return "EXTENSIBLE";
            return "0x" + tag.ToString("X");
        }

        private static string SubtypeName(Guid guid)
        {
            if (guid == SubtypePcm) return " PCM";
            if (guid == SubtypeIeeeFloat) return " FLOAT";
            return " " + guid.ToString();
        }

        private static string FormFactorName(int? value)
        {
            if (!value.HasValue) return "unset";
            switch (value.Value)
            {
                case 0: return "RemoteNetworkDevice";
                case 1: return "Speakers";
                case 2: return "LineLevel";
                case 3: return "Headphones";
                case 4: return "Microphone";
                case 5: return "Headset";
                case 6: return "Handset";
                case 7: return "UnknownDigitalPassthrough";
                case 8: return "SPDIF";
                case 9: return "DigitalAudioDisplayDevice";
                default: return "Unknown(" + value.Value + ")";
            }
        }

        private static PropertyKey Key(string guid, int pid)
        {
            PropertyKey key = new PropertyKey();
            key.fmtid = new Guid(guid);
            key.pid = pid;
            return key;
        }

        public static string HrName(int hr)
        {
            uint code = unchecked((uint)hr);
            if (code == 0) return "S_OK";
            if (code == 1) return "S_FALSE";
            if (code == 0x88890008) return "AUDCLNT_E_UNSUPPORTED_FORMAT";
            if (code == 0x8889000A) return "AUDCLNT_E_DEVICE_IN_USE";
            if (code == 0x8889000E) return "AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED";
            if (code == 0x8889000F) return "AUDCLNT_E_ENDPOINT_CREATE_FAILED";
            if (code == 0x88890001) return "AUDCLNT_E_NOT_INITIALIZED";
            if (code == 0x88890019) return "AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED";
            if (code == 0x80070057) return "E_INVALIDARG";
            if (code == 0x80004003) return "E_POINTER";
            if (code == 0x80040154) return "REGDB_E_CLASSNOTREG";
            if (code == 0x80070005) return "E_ACCESSDENIED";
            return "0x" + code.ToString("X8");
        }

        private static string Dominant(Dictionary<string, int> counts)
        {
            string best = "";
            int bestCount = -1;
            foreach (KeyValuePair<string, int> pair in counts)
            {
                if (pair.Value > bestCount)
                {
                    best = pair.Key;
                    bestCount = pair.Value;
                }
            }
            return best;
        }

        private static string JoinCounts(Dictionary<string, int> counts)
        {
            List<string> parts = new List<string>();
            foreach (KeyValuePair<string, int> pair in counts)
            {
                parts.Add(pair.Key + "=" + pair.Value);
            }
            parts.Sort();
            return string.Join(", ", parts.ToArray());
        }
    }
}
'@
} catch {
  Write-Host 'Add-Type failed. This PC needs the .NET Framework C# compiler (normally present on Windows 10/11).'
  Write-Host $_.Exception.Message
  if ($_.Exception.InnerException) { Write-Host $_.Exception.InnerException.Message }
  exit 1
}
}

function Get-OsLine {
  $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  $display = $cv.DisplayVersion
  if (-not $display) { $display = $cv.ReleaseId }
  return "Windows $display $($cv.CurrentBuildNumber).$($cv.UBR)  $([Environment]::OSVersion.VersionString)"
}

function Get-SafeCim($class, $filter = $null) {
  try {
    if ($filter) { return @(Get-CimInstance -ClassName $class -Filter $filter -ErrorAction Stop) }
    return @(Get-CimInstance -ClassName $class -ErrorAction Stop)
  } catch {
    return @()
  }
}

function Get-AudioProcesses {
  $pattern = 'Focusrite|Scarlett|Clarett|asio|Voicemeeter|VB-Audio|EqualizerAPO|Audition|Reaper|Ableton|Cubase|ProTools|Studio One|FL64|obs|Discord|Teams|Zoom|WeChat|WXWork|chrome|msedge|firefox|spotify|itunes|qqmusic|cloudmusic|databaker|recorder-engine'
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match $pattern -or $_.MainWindowTitle -match $pattern } |
    Sort-Object ProcessName, Id |
    ForEach-Object {
      [pscustomobject]@{
        name = $_.ProcessName
        id = $_.Id
        title = $_.MainWindowTitle
        path = $_.Path
      }
    }
}

function Get-SoundDrivers {
  $drivers = Get-SafeCim 'Win32_PnPSignedDriver'
  $drivers | Where-Object {
    $_.DeviceClass -match 'MEDIA|SOUND|USB|SYSTEM' -and (
      $_.DeviceName -match 'Audio|Sound|Focusrite|Scarlett|Realtek|Senary|Microphone|USB' -or
      $_.DriverProviderName -match 'Focusrite|Realtek|Microsoft|NVIDIA'
    )
  } | ForEach-Object {
    [pscustomobject]@{
      device = $_.DeviceName
      class = $_.DeviceClass
      manufacturer = $_.Manufacturer
      provider = $_.DriverProviderName
      version = $_.DriverVersion
      date = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { '' }
      inf = $_.InfName
      signer = $_.Signer
      deviceId = $_.DeviceID
    }
  }
}

function Get-PnpAudio {
  try {
    Get-PnpDevice -PresentOnly -ErrorAction Stop |
      Where-Object { $_.Class -match 'MEDIA|AudioEndpoint|USB' -or $_.FriendlyName -match 'Focusrite|Audio|Microphone|Senary|Scarlett' } |
      ForEach-Object {
        [pscustomobject]@{
          status = $_.Status
          class = $_.Class
          name = $_.FriendlyName
          instanceId = $_.InstanceId
          problem = $_.Problem
        }
      }
  } catch {
    @()
  }
}

function Get-VendorKeys {
  $paths = @(
    'HKLM:\SOFTWARE\Focusrite',
    'HKLM:\SOFTWARE\WOW6432Node\Focusrite',
    'HKCU:\SOFTWARE\Focusrite',
    'HKLM:\SOFTWARE\ASIO',
    'HKLM:\SOFTWARE\WOW6432Node\ASIO'
  )
  $rows = @()
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try {
      Get-ChildItem -LiteralPath $path -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
        $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
        if (-not $props) { return }
        $map = [ordered]@{}
        $props.PSObject.Properties |
          Where-Object { $_.Name -notmatch '^PS' } |
          ForEach-Object { $map[$_.Name] = [string]$_.Value }
        $rows += [pscustomobject]@{ path = $_.PSPath.Replace('Microsoft.PowerShell.Core\Registry::', ''); values = $map }
      }
    } catch {}
  }
  return $rows
}

function Get-Hint($d) {
  if ($d.ActivateHr) {
    return "无法 Activate IAudioClient：$($d.ActivateHr)"
  }
  if ($d.ExclusiveAllowed -eq 'deny' -or $d.DominantExclusiveHr -eq 'AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED') {
    return '独占被系统策略关掉。声音设置 -> 此设备 -> 高级 -> 允许应用程序独占控制。'
  }
  $i16FailCreate = @($d.InitAttempts | Where-Object { $_.Rate -eq 48000 -and $_.Format -like 'i16*' -and $_.SupportedHr -eq 'S_OK' -and $_.InitializeHr -eq 'AUDCLNT_E_ENDPOINT_CREATE_FAILED' })
  $i24Ok = @($d.InitAttempts | Where-Object { $_.Rate -eq 48000 -and $_.Format -like '*i24*' -and $_.InitializeHr -eq 'S_OK' })
  if ($i16FailCreate.Count -gt 0 -and $i24Ok.Count -gt 0) {
    return '典型 Focusrite：IsFormatSupported(48k/i16) 说能开，Initialize 却 0x8889000F。请改用 48k / 24-bit / i24 独占。'
  }
  if ($d.Init48kI24Ok) {
    return '48 kHz / 24-bit 独占 Initialize 成功。采集软件应选 i24 或 f32，不要强开 i16 独占。'
  }
  if (-not $d.Init48kI16Ok -and -not $d.Init48kI24Ok -and $d.Init44100I24Ok) {
    return '48 kHz 独占失败，44.1 kHz / 24-bit 成功。去 Focusrite Control 把硬件时钟锁成 48 kHz。'
  }
  $busy = @($d.InitAttempts | Where-Object { $_.InitializeHr -eq 'AUDCLNT_E_DEVICE_IN_USE' })
  if ($busy.Count -gt 0) {
    return '独占 Initialize 报 DEVICE_IN_USE。关掉 Focusrite Control / DAW / 浏览器 / 会议软件后再测。'
  }
  if ($d.MixRate -eq 16000) {
    return '系统混音是 16 kHz。共享模式录 48k 会升采样，频谱会在 8 kHz 切平。不要用这个端点做高保真。'
  }
  if ($d.Name -match 'Array|Senary|阵列') {
    return '笔记本阵列麦，通常是通讯链路，不要当采集设备。'
  }
  if ($d.InitAttempts | Where-Object { $_.InitializeHr -eq 'S_OK' }) {
    return '部分独占格式能真正 Initialize。看下面 init 表，用 S_OK 的那一行。'
  }
  if ($d.HasEngineGridHit) {
    return 'IsFormatSupported 有命中，但 Initialize 都失败。优先查占用进程和硬件时钟。'
  }
  return '看 init 表和 HRESULT 汇总。'
}

function Get-Verdict($d) {
  if ($d.ActivateHr) { return 'ACTIVATE_FAILED' }
  if ($d.ExclusiveAllowed -eq 'deny') { return 'EXCLUSIVE_DENIED' }
  if ($d.Init48kI24Ok -and -not $d.Init48kI16Ok) { return 'USE_48K_24BIT_EXCLUSIVE' }
  if ($d.Init48kI16Ok) { return 'EXCLUSIVE_48K_I16_OK' }
  if ($d.Init44100I24Ok -and -not $d.Init48kI24Ok) { return 'HARDWARE_CLOCK_NOT_48K' }
  if (@($d.InitAttempts | Where-Object { $_.InitializeHr -eq 'AUDCLNT_E_DEVICE_IN_USE' }).Count -gt 0) {
    return 'DEVICE_BUSY'
  }
  if ($d.MixRate -eq 16000) { return 'SHARED_MIX_16K' }
  if ($d.HasEngineGridHit) { return 'SUPPORTED_BUT_INIT_FAILED' }
  if ($d.Hits.Count -eq 0) { return 'NO_EXCLUSIVE_FORMAT' }
  return 'CHECK_INIT_TABLE'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$lines = New-Object System.Collections.Generic.List[string]
function Out-Line([string]$text) {
  $script:lines.Add($text)
  Write-Host $text
}

Out-Line '============================================================'
Out-Line ' DataBaker 采集硬件信息收集'
Out-Line '============================================================'
Out-Line ("Time: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Out-Line ("Host: " + $env:COMPUTERNAME + " / " + $env:USERNAME)
Out-Line ("OS:   " + (Get-OsLine))
Out-Line ("Arch: " + $env:PROCESSOR_ARCHITECTURE + "  PS=" + $PSVersionTable.PSVersion)
Out-Line ''
Out-Line 'engine_grid = i16-pcm / i24-in-32-ext / i32-ext / f32-ext'
Out-Line 'init 表是真正 IAudioClient.Initialize(exclusive)，不是只问 IsFormatSupported。'
Out-Line ''

try {
  $devices = [WasapiCaptureInventory.Native]::Run()
} catch {
  Write-Host 'WASAPI probe failed:'
  Write-Host $_.Exception.Message
  exit 1
}

$processes = @(Get-AudioProcesses)
$drivers = @(Get-SoundDrivers)
$pnp = @(Get-PnpAudio)
$vendorKeys = @(Get-VendorKeys)
$soundDevices = @(Get-SafeCim 'Win32_SoundDevice' | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    manufacturer = $_.Manufacturer
    status = $_.Status
    pnpId = $_.PNPDeviceID
  }
})

if (-not $devices -or $devices.Count -eq 0) {
  Out-Line '没有枚举到活动的采集端点。先插声卡，确认 Windows 声音设置里能看到输入设备。'
} else {
  $index = 0
  foreach ($d in $devices) {
    $index++
    $roles = @()
    if ($d.IsDefaultConsole) { $roles += 'console' }
    if ($d.IsDefaultMultimedia) { $roles += 'multimedia' }
    if ($d.IsDefaultCommunications) { $roles += 'communications' }
    $roleText = $(if ($roles.Count) { '  [' + ($roles -join ',') + ']' } else { '' })
    Out-Line '------------------------------------------------------------'
    Out-Line ("[$index] $($d.Name)$roleText")
    Out-Line ("    id:          $($d.Id)")
    Out-Line ("    interface:   $($d.InterfaceName)")
    Out-Line ("    desc:        $($d.DeviceDesc)")
    Out-Line ("    formFactor:  $($d.FormFactor)")
    Out-Line ("    mix:         $($d.MixSummary)")
    Out-Line ("    exclusive:   allow=$($d.ExclusiveAllowed)  priority=$($d.ExclusivePriority)")
    if ($d.ActivateHr) { Out-Line ("    activate:    $($d.ActivateHr)") }
    Out-Line ("    IsFormatSupported HRESULT: $($d.HresultSummary)")
    Out-Line ("    verdict:     $(Get-Verdict $d)")

    if ($d.SampleAttempts -and $d.SampleAttempts.Count -gt 0) {
      Out-Line '    mix-rate exclusive IsFormatSupported:'
      foreach ($row in $d.SampleAttempts) { Out-Line ("      $row") }
    }

    if ($d.Hits -and $d.Hits.Count -gt 0) {
      $engineHits = @($d.Hits | Where-Object { $_.InEngineGrid })
      $extraHits = @($d.Hits | Where-Object { -not $_.InEngineGrid })
      Out-Line ("    S_OK exclusive formats: $($d.Hits.Count)  engine_grid=$($engineHits.Count)  extra=$($extraHits.Count)")
      foreach ($hit in @($d.Hits | Select-Object -First 50)) {
        $grid = $(if ($hit.InEngineGrid) { 'engine_grid' } else { 'extra      ' })
        Out-Line ("      $grid  $($hit.Rate) Hz  $($hit.Channels)ch  $($hit.Format)  mask=$($hit.Mask)")
      }
      if ($d.Hits.Count -gt 50) { Out-Line ("      ... $($d.Hits.Count - 50) more") }
    } else {
      Out-Line '    S_OK exclusive formats: 0'
    }

    Out-Line '    exclusive Initialize (this is the real open, matches the app):'
    if ($d.InitAttempts -and $d.InitAttempts.Count -gt 0) {
      foreach ($attempt in $d.InitAttempts) {
        $mark = $(if ($attempt.InitializeHr -eq 'S_OK') { 'OK  ' } else { 'FAIL' })
        $note = $(if ($attempt.Note) { "  ($($attempt.Note))" } else { '' })
        Out-Line ("      $mark  $($attempt.Rate) Hz  $($attempt.Channels)ch  $($attempt.Format)  supported=$($attempt.SupportedHr)  init=$($attempt.InitializeHr)$note")
      }
    } else {
      Out-Line '      (no attempts)'
    }
    Out-Line ("    hint: $(Get-Hint $d)")
    Out-Line ''
  }
}

Out-Line '============================================================'
Out-Line ' 音频相关进程（可能占用声卡）'
Out-Line '============================================================'
if ($processes.Count -eq 0) {
  Out-Line '  (none matched)'
} else {
  foreach ($proc in $processes) {
    Out-Line ("  $($proc.name)  pid=$($proc.id)  $($proc.title)")
    if ($proc.path) { Out-Line ("    $($proc.path)") }
  }
}
Out-Line ''

Out-Line '============================================================'
Out-Line ' Win32_SoundDevice'
Out-Line '============================================================'
if ($soundDevices.Count -eq 0) {
  Out-Line '  (none)'
} else {
  foreach ($item in $soundDevices) {
    Out-Line ("  $($item.name)  status=$($item.status)  $($item.manufacturer)")
    Out-Line ("    $($item.pnpId)")
  }
}
Out-Line ''

Out-Line '============================================================'
Out-Line ' 驱动 / PnP'
Out-Line '============================================================'
if ($drivers.Count -eq 0) {
  Out-Line '  (no matching signed drivers)'
} else {
  foreach ($item in $drivers) {
    Out-Line ("  $($item.device)")
    Out-Line ("    class=$($item.class)  provider=$($item.provider)  version=$($item.version)  date=$($item.date)")
    Out-Line ("    inf=$($item.inf)  id=$($item.deviceId)")
  }
}
Out-Line ''
if ($pnp.Count -gt 0) {
  Out-Line '  present PnP:'
  foreach ($item in $pnp) {
    Out-Line ("    [$($item.status)] $($item.class)  $($item.name)")
    Out-Line ("      $($item.instanceId)")
  }
  Out-Line ''
}

if ($vendorKeys.Count -gt 0) {
  Out-Line '============================================================'
  Out-Line ' Focusrite / ASIO 注册表（可能含硬件采样率）'
  Out-Line '============================================================'
  foreach ($row in $vendorKeys) {
    Out-Line ("  $($row.path)")
    foreach ($name in $row.values.Keys) {
      Out-Line ("    $name = $($row.values[$name])")
    }
  }
  Out-Line ''
}

Out-Line '============================================================'
Out-Line ' Summary'
Out-Line '============================================================'
if ($devices) {
  foreach ($d in $devices) {
    Out-Line ("- $(Get-Verdict $d)  $($d.Name)  mix=$($d.MixRate)Hz/$($d.MixChannels)ch  init48k_i16=$($d.Init48kI16Ok)  init48k_i24=$($d.Init48kI24Ok)  init48k_f32=$($d.Init48kF32Ok)")
  }
}
Out-Line ''
Out-Line 'How to read verdict:'
Out-Line '  USE_48K_24BIT_EXCLUSIVE   48k/16-bit 独占开不了，48k/24-bit 能开。按这个设采集软件。'
Out-Line '  EXCLUSIVE_48K_I16_OK      48k/16-bit 独占真能 Initialize。'
Out-Line '  HARDWARE_CLOCK_NOT_48K    硬件时钟不在 48k，去 Focusrite Control 锁 48k。'
Out-Line '  DEVICE_BUSY               有程序占着独占。'
Out-Line '  SHARED_MIX_16K            Windows 默认格式是 16 kHz，共享录音会假 48k。'
Out-Line '  SUPPORTED_BUT_INIT_FAILED 口头支持独占，真正 Initialize 失败。'
Out-Line '  NO_EXCLUSIVE_FORMAT       这个端点没有独占格式。'
Out-Line '  EXCLUSIVE_DENIED          控制面板禁止独占。'
Out-Line ''
Out-Line '请把 txt 和 json 一起发回。优先看 Focusrite 设备的 init 表，不要只看 IsFormatSupported。'

$payload = [ordered]@{
  generated_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  user = $env:USERNAME
  os = Get-OsLine
  arch = $env:PROCESSOR_ARCHITECTURE
  devices = @($devices | ForEach-Object {
    [ordered]@{
      name = $_.Name
      id = $_.Id
      interface = $_.InterfaceName
      desc = $_.DeviceDesc
      form_factor = $_.FormFactor
      default_console = [bool]$_.IsDefaultConsole
      default_multimedia = [bool]$_.IsDefaultMultimedia
      default_communications = [bool]$_.IsDefaultCommunications
      mix = $_.MixSummary
      mix_rate = $_.MixRate
      mix_channels = $_.MixChannels
      exclusive_allow = $_.ExclusiveAllowed
      exclusive_priority = $_.ExclusivePriority
      activate_hr = $_.ActivateHr
      verdict = Get-Verdict $_
      hint = Get-Hint $_
      supported_hits = @($_.Hits | ForEach-Object {
        [ordered]@{ rate = $_.Rate; channels = $_.Channels; format = $_.Format; mask = $_.Mask; engine_grid = [bool]$_.InEngineGrid }
      })
      init_attempts = @($_.InitAttempts | ForEach-Object {
        [ordered]@{
          rate = $_.Rate
          channels = $_.Channels
          format = $_.Format
          mask = $_.Mask
          supported = $_.SupportedHr
          initialize = $_.InitializeHr
          note = $_.Note
        }
      })
      init_48k_i16 = [bool]$_.Init48kI16Ok
      init_48k_i24 = [bool]$_.Init48kI24Ok
      init_48k_f32 = [bool]$_.Init48kF32Ok
      init_44100_i24 = [bool]$_.Init44100I24Ok
    }
  })
  processes = $processes
  sound_devices = $soundDevices
  drivers = $drivers
  pnp = $pnp
  vendor_registry = $vendorKeys
}

$baseName = "databaker-capture-hw-$stamp"
$targets = New-Object System.Collections.Generic.List[string]
function Save-Report([string]$directory) {
  if (-not $directory) { return }
  try {
    if (-not (Test-Path -LiteralPath $directory)) { return }
    $txt = Join-Path $directory ($script:baseName + '.txt')
    $json = Join-Path $directory ($script:baseName + '.json')
    [System.IO.File]::WriteAllLines($txt, $script:lines, (New-Object System.Text.UTF8Encoding $true))
    [System.IO.File]::WriteAllText($json, ($script:payload | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $true))
    $script:targets.Add($txt) | Out-Null
    $script:targets.Add($json) | Out-Null
  } catch {}
}

Save-Report $env:PROBE_DIR
Save-Report ([Environment]::GetFolderPath('Desktop'))
if ($targets.Count -eq 0) { Save-Report $env:TEMP }

Write-Host ''
Write-Host 'Report saved:'
foreach ($path in $targets) { Write-Host "  $path" }
Write-Host ''
Write-Host '把桌面上的 databaker-capture-hw-*.txt 和 .json 发回来即可。'
exit 0

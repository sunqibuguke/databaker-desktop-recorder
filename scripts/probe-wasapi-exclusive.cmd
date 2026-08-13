@echo off
setlocal EnableExtensions
chcp 65001 >nul
title WASAPI exclusive probe
echo.
echo  WASAPI exclusive probe
echo  Double-click on the affected Windows PC. A UTF-8 report is written
echo  next to this file and onto the Desktop.
echo.
set "PROBE_SELF=%~f0"
set "PROBE_DIR=%~dp0"
set "PROBE_PS=%TEMP%\probe-wasapi-exclusive-%RANDOM%%RANDOM%.ps1"
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

if (-not ('WasapiExclusiveProbe.Native' -as [type])) {
try {
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace WasapiExclusiveProbe
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

    public class DeviceProbe
    {
        public string Name { get; set; }
        public string Id { get; set; }
        public bool IsDefault { get; set; }
        public int State { get; set; }
        public string MixSummary { get; set; }
        public uint MixRate { get; set; }
        public ushort MixChannels { get; set; }
        public string ExclusiveAllowed { get; set; }
        public string ExclusivePriority { get; set; }
        public string ActivateHr { get; set; }
        public ExclusiveHit[] Hits { get; set; }
        public string[] SampleAttempts { get; set; }
        public string HresultSummary { get; set; }
        public bool HasEngineGridHit { get; set; }
        public bool HasExtraHitOnly { get; set; }
        public string DominantExclusiveHr { get; set; }
    }

    public static class Native
    {
        public const int ECapture = 1;
        public const int DeviceStateActive = 1;
        public const int RoleConsole = 0;
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

        public static readonly Guid AudioClientIid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        public static readonly Guid SubtypePcm = new Guid("00000001-0000-0010-8000-00AA00389B71");
        public static readonly Guid SubtypeIeeeFloat = new Guid("00000003-0000-0010-8000-00AA00389B71");
        public static readonly PropertyKey PkeyFriendlyName = Key("a45c254e-df1c-4efd-8020-67d146a850e0", 14);
        public static readonly PropertyKey PkeyExclusiveAllow = Key("b3f8fa53-0004-438e-9003-51a46e139bfc", 3);
        public static readonly PropertyKey PkeyExclusivePriority = Key("b3f8fa53-0004-438e-9003-51a46e139bfc", 4);

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
                string defaultId = null;
                IntPtr defaultDevice;
                GetDefaultAudioEndpointFn getDefault = (GetDefaultAudioEndpointFn)VCall(enumerator, 4, typeof(GetDefaultAudioEndpointFn));
                if (getDefault(enumerator, ECapture, RoleConsole, out defaultDevice) == 0 && defaultDevice != IntPtr.Zero)
                {
                    try { defaultId = DeviceId(defaultDevice); }
                    finally { Marshal.Release(defaultDevice); }
                }

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
                        try { results.Add(ProbeDevice(device, defaultId)); }
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

        private static DeviceProbe ProbeDevice(IntPtr device, string defaultId)
        {
            DeviceProbe result = new DeviceProbe();
            result.Hits = new ExclusiveHit[0];
            result.SampleAttempts = new string[0];
            result.ExclusiveAllowed = "default-allow";
            result.ExclusivePriority = "default";
            result.ActivateHr = "";
            result.MixSummary = "";
            result.DominantExclusiveHr = "";
            result.HresultSummary = "";

            string id = DeviceId(device);
            result.Id = id ?? "";
            result.IsDefault = !string.IsNullOrEmpty(defaultId) && string.Equals(defaultId, id, StringComparison.OrdinalIgnoreCase);

            GetStateFn getState = (GetStateFn)VCall(device, 6, typeof(GetStateFn));
            int state;
            getState(device, out state);
            result.State = state;
            result.Name = ReadFriendlyName(device, result.Id);

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
                    result.MixSummary = DescribeWave(mixPtr);
                    result = ProbeFormats(client, result);
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

        private static DeviceProbe ProbeFormats(IntPtr client, DeviceProbe result)
        {
            List<ExclusiveHit> hits = new List<ExclusiveHit>();
            List<string> samples = new List<string>();
            Dictionary<string, int> counts = new Dictionary<string, int>();

            List<uint> rates = new List<uint>(ProbeRates);
            if (result.MixRate != 0 && !rates.Contains(result.MixRate))
            {
                rates.Add(result.MixRate);
            }
            List<ushort> channels = new List<ushort>(ProbeChannels);
            if (result.MixChannels != 0 && !channels.Contains(result.MixChannels))
            {
                channels.Add(result.MixChannels);
            }

            Candidate[] flavors = BuildFlavors();
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
                            int hr = CheckExclusive(client, rates[r], channels[c], flavor, masks[m]);
                            string hrName = HrName(hr);
                            if (!counts.ContainsKey(hrName))
                            {
                                counts[hrName] = 0;
                            }
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
                if (hits[i].InEngineGrid)
                {
                    engineHit = true;
                }
                else
                {
                    extraHit = true;
                }
            }
            result.HasEngineGridHit = engineHit;
            result.HasExtraHitOnly = extraHit && !engineHit;
            return result;
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

        private static int CheckExclusive(IntPtr client, uint rate, ushort channels, Candidate flavor, uint mask)
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
            try
            {
                Marshal.StructureToPtr(format, ptr, false);
                IsFormatSupportedFn isSupported = (IsFormatSupportedFn)VCall(client, 7, typeof(IsFormatSupportedFn));
                return isSupported(client, ShareExclusive, ptr, IntPtr.Zero);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        private static uint[] ExclusiveMasks(ushort channels)
        {
            uint speaker = 0;
            if (channels == 1) speaker = 0x4;
            else if (channels == 2) speaker = 0x1 | 0x2;
            else if (channels == 4) speaker = 0x1 | 0x2 | 0x10 | 0x20;
            else if (channels == 6) speaker = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20;
            else if (channels == 8) speaker = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x200 | 0x400;
            if (speaker == 0)
            {
                return new uint[] { 0 };
            }
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
            if (getId(device, out pId) != 0 || pId == IntPtr.Zero)
            {
                return "";
            }
            try
            {
                return Marshal.PtrToStringUni(pId) ?? "";
            }
            finally
            {
                CoTaskMemFree(pId);
            }
        }

        private static string ReadFriendlyName(IntPtr device, string id)
        {
            string name = ReadStringProp(device, PkeyFriendlyName);
            if (!string.IsNullOrEmpty(name))
            {
                return name;
            }
            return id;
        }

        private static void ReadExclusivePolicy(IntPtr device, string id, out string allow, out string priority)
        {
            allow = FormatPolicy(ReadUIntProp(device, PkeyExclusiveAllow), "allow", "deny");
            priority = FormatPolicy(ReadUIntProp(device, PkeyExclusivePriority), "on", "off");

            if (allow != "unset" && priority != "unset")
            {
                return;
            }

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
            catch
            {
            }

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
            if (value is int)
            {
                return (int)value;
            }
            if (value is byte[])
            {
                byte[] bytes = (byte[])value;
                if (bytes.Length >= 4)
                {
                    return BitConverter.ToInt32(bytes, 0);
                }
            }
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
            if (store == IntPtr.Zero)
            {
                return null;
            }
            try
            {
                PropVariant variant;
                GetValueFn getValue = (GetValueFn)VCall(store, 5, typeof(GetValueFn));
                if (getValue(store, ref key, out variant) != 0)
                {
                    return null;
                }
                try
                {
                    if (variant.vt == VtLpwstr && variant.data1 != IntPtr.Zero)
                    {
                        return Marshal.PtrToStringUni(variant.data1);
                    }
                    return null;
                }
                finally
                {
                    PropVariantClear(ref variant);
                }
            }
            finally
            {
                Marshal.Release(store);
            }
        }

        private static int? ReadUIntProp(IntPtr device, PropertyKey key)
        {
            IntPtr store = OpenStore(device);
            if (store == IntPtr.Zero)
            {
                return null;
            }
            try
            {
                PropVariant variant;
                GetValueFn getValue = (GetValueFn)VCall(store, 5, typeof(GetValueFn));
                if (getValue(store, ref key, out variant) != 0)
                {
                    return null;
                }
                try
                {
                    if (variant.vt == VtEmpty)
                    {
                        return null;
                    }
                    if (variant.vt == VtUi4 || variant.vt == VtBool)
                    {
                        return (int)(variant.data1.ToInt64() & 0xFFFFFFFF);
                    }
                    return null;
                }
                finally
                {
                    PropVariantClear(ref variant);
                }
            }
            finally
            {
                Marshal.Release(store);
            }
        }

        private static IntPtr OpenStore(IntPtr device)
        {
            IntPtr store;
            OpenPropertyStoreFn open = (OpenPropertyStoreFn)VCall(device, 4, typeof(OpenPropertyStoreFn));
            if (open(device, 0, out store) != 0)
            {
                return IntPtr.Zero;
            }
            return store;
        }

        private static string DescribeWave(IntPtr ptr)
        {
            WaveFormatEx format = (WaveFormatEx)Marshal.PtrToStructure(ptr, typeof(WaveFormatEx));
            string tag;
            ushort valid = format.wBitsPerSample;
            string sub = "";
            string mask = "";
            if (format.wFormatTag == WaveFormatPcm)
            {
                tag = "PCM";
            }
            else if (format.wFormatTag == WaveFormatIeeeFloat)
            {
                tag = "IEEE_FLOAT";
            }
            else if (format.wFormatTag == WaveFormatExtensible)
            {
                WaveFormatExtensible ext = (WaveFormatExtensible)Marshal.PtrToStructure(ptr, typeof(WaveFormatExtensible));
                tag = "EXTENSIBLE";
                valid = ext.wValidBitsPerSample;
                if (ext.SubFormat == SubtypePcm) sub = " PCM";
                else if (ext.SubFormat == SubtypeIeeeFloat) sub = " FLOAT";
                else sub = " " + ext.SubFormat.ToString();
                mask = " mask=" + MaskName(ext.dwChannelMask, true);
            }
            else
            {
                tag = "0x" + format.wFormatTag.ToString("X");
            }
            return string.Format("{0} Hz / {1}ch / {2}{3} container={4} valid={5}{6}",
                format.nSamplesPerSec, format.nChannels, tag, sub, format.wBitsPerSample, valid, mask);
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
  $build = $cv.CurrentBuildNumber
  $ubr = $cv.UBR
  return "Windows $display $build.$ubr  $([Environment]::OSVersion.VersionString)"
}

function Get-Hint([WasapiExclusiveProbe.DeviceProbe]$d) {
  $name = $d.Name
  if ($d.ActivateHr) {
    return ('Cannot activate IAudioClient: ' + $d.ActivateHr + '. If shared enumeration still works, this is more like a permission/driver issue.')
  }
  if ($d.ExclusiveAllowed -eq 'deny' -or $d.DominantExclusiveHr -eq 'AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED') {
    return 'Exclusive mode is denied. mmsys.cpl -> device -> Advanced -> enable Allow applications to take exclusive control of this device.'
  }
  if ($d.HasEngineGridHit) {
    return 'Hardware accepts exclusive formats already in the app grid (i16-pcm / i24-in-32-ext / i32-ext / f32-ext). App exclusive_empty is unexpected on this device.'
  }
  if ($d.HasExtraHitOnly) {
    return 'Hardware accepts exclusive, but only extra formats the app does not probe (packed24-pcm / i16-ext / f32-ieee). This becomes exclusive_empty in the app.'
  }
  if ($d.MixRate -eq 16000 -and $d.MixChannels -eq 1) {
    return 'Shared mix is 16 kHz / 1ch. This looks like a Bluetooth HFP call mic, which often has no exclusive formats.'
  }
  if ($name -match 'Array|Senary|\u9635\u5217') {
    return 'Laptop mic array. OEMs often disable exclusive, or exclusive wants raw multi-channel. Shared formats do not imply exclusive formats.'
  }
  if ($d.Hits.Count -eq 0) {
    return 'Policy looks allowed, but every candidate failed including packed24 / i16-ext. The endpoint itself likely has no exclusive mode.'
  }
  return 'See the hit list above.'
}

function Get-Verdict([WasapiExclusiveProbe.DeviceProbe]$d) {
  if ($d.ActivateHr) { return 'ACTIVATE_FAILED' }
  if ($d.ExclusiveAllowed -eq 'deny' -or $d.DominantExclusiveHr -eq 'AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED') {
    return 'EXCLUSIVE_DENIED'
  }
  if ($d.HasEngineGridHit) { return 'ENGINE_SHOULD_SEE_FORMATS' }
  if ($d.HasExtraHitOnly) { return 'PROBE_GRID_GAP' }
  if ($d.Hits.Count -eq 0) { return 'NO_EXCLUSIVE_FORMAT' }
  return 'CHECK_HITS'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$lines = New-Object System.Collections.Generic.List[string]
function Out-Line([string]$text) {
  $script:lines.Add($text)
  Write-Host $text
}

Out-Line '============================================================'
Out-Line ' WASAPI exclusive probe'
Out-Line '============================================================'
Out-Line ("Time: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Out-Line ("Host: " + $env:COMPUTERNAME + " / " + $env:USERNAME)
Out-Line ("OS:   " + (Get-OsLine))
Out-Line ''
Out-Line 'engine_grid = i16-pcm / i24-in-32-ext / i32-ext / f32-ext'
Out-Line 'extra       = packed24-pcm / i16-ext / f32-ieee  (App 当前不探测)'
Out-Line ''

try {
  $devices = [WasapiExclusiveProbe.Native]::Run()
} catch {
  Write-Host 'WASAPI probe failed:'
  Write-Host $_.Exception.Message
  exit 1
}
if (-not $devices -or $devices.Count -eq 0) {
  Out-Line '没有枚举到活动的采集端点。'
} else {
  $index = 0
  foreach ($d in $devices) {
    $index++
    $verdict = Get-Verdict $d
    $defaultMark = $(if ($d.IsDefault) { '  [default capture]' } else { '' })
    Out-Line ('------------------------------------------------------------')
    Out-Line ("[$index] $($d.Name)$defaultMark")
    Out-Line ("    id:        $($d.Id)")
    Out-Line ("    mix:       $($d.MixSummary)")
    Out-Line ("    exclusive: allow=$($d.ExclusiveAllowed)  priority=$($d.ExclusivePriority)")
    if ($d.ActivateHr) {
      Out-Line ("    activate:  $($d.ActivateHr)")
    }
    Out-Line ("    HRESULT:   $($d.HresultSummary)")
    Out-Line ("    verdict:   $verdict")
    if ($d.SampleAttempts -and $d.SampleAttempts.Count -gt 0) {
      Out-Line '    mix-rate exclusive attempts:'
      foreach ($row in $d.SampleAttempts) {
        Out-Line ("      $row")
      }
    }
    if ($d.Hits -and $d.Hits.Count -gt 0) {
      $engineHits = @($d.Hits | Where-Object { $_.InEngineGrid })
      $extraHits = @($d.Hits | Where-Object { -not $_.InEngineGrid })
      Out-Line ("    S_OK exclusive: $($d.Hits.Count)  engine_grid=$($engineHits.Count)  extra=$($extraHits.Count)")
      $shown = @($d.Hits | Select-Object -First 40)
      foreach ($hit in $shown) {
        $grid = $(if ($hit.InEngineGrid) { 'engine_grid' } else { 'extra      ' })
        Out-Line ("      $grid  $($hit.Rate) Hz  $($hit.Channels)ch  $($hit.Format)  mask=$($hit.Mask)")
      }
      if ($d.Hits.Count -gt 40) {
        Out-Line ("      ... $($d.Hits.Count - 40) more")
      }
    } else {
      Out-Line '    S_OK exclusive: 0'
    }
    Out-Line ("    hint: $($(Get-Hint $d))")
    Out-Line ''
  }

  Out-Line '============================================================'
  Out-Line ' Summary'
  Out-Line '============================================================'
  foreach ($d in $devices) {
    Out-Line ("- $(Get-Verdict $d)  $($d.Name)")
  }
  Out-Line ''
  Out-Line 'How to read verdict:'
  Out-Line '  EXCLUSIVE_DENIED          控制面板/驱动禁止独占。三个设备一起空，优先看这个。'
  Out-Line '  PROBE_GRID_GAP            硬件能独占，但只有 packed24 / i16-ext 等，App 会报 exclusive_empty。'
  Out-Line '  ENGINE_SHOULD_SEE_FORMATS 硬件和引擎网格都能命中。若 App 仍 empty，对一下是否同一台机器/同一设备。'
  Out-Line '  NO_EXCLUSIVE_FORMAT       策略允许，但所有候选都失败。蓝牙 HFP、阵列麦很常见。'
  Out-Line '  ACTIVATE_FAILED           端点激活失败。'
}

$reportName = "wasapi-exclusive-probe-$stamp.txt"
$reportPaths = @()
$primary = Join-Path $env:PROBE_DIR $reportName
try {
  [System.IO.File]::WriteAllLines($primary, $lines, (New-Object System.Text.UTF8Encoding $true))
  $reportPaths += $primary
} catch {
  $fallback = Join-Path $env:TEMP $reportName
  [System.IO.File]::WriteAllLines($fallback, $lines, (New-Object System.Text.UTF8Encoding $true))
  $reportPaths += $fallback
}

$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) {
  $desktopPath = Join-Path $desktop $reportName
  try {
    [System.IO.File]::WriteAllLines($desktopPath, $lines, (New-Object System.Text.UTF8Encoding $true))
    if ($reportPaths -notcontains $desktopPath) { $reportPaths += $desktopPath }
  } catch {}
}

Write-Host ''
Write-Host 'Report saved:'
foreach ($path in $reportPaths) {
  Write-Host "  $path"
}
Write-Host ''
Write-Host '把报告发回来即可，尤其看 Focusrite 那一段的 verdict 和 mix-rate exclusive attempts。'
exit 0

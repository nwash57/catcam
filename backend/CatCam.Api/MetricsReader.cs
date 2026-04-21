using System.Globalization;

namespace CatCam.Api;

public sealed class MetricsReader
{
    private readonly object _lock = new();
    private CpuSnapshot? _previousCpu;

    public DeviceMetrics Read(string capturesDir)
    {
        return new DeviceMetrics(
            Hostname: Environment.MachineName,
            Os: RuntimeInformation(),
            UptimeSeconds: ReadUptimeSeconds(),
            CpuTemperatureC: ReadCpuTemperatureC(),
            CpuUsagePercent: ReadCpuUsagePercent(),
            CpuFrequencyMhz: ReadCpuFrequencyMhz(),
            LoadAverage: ReadLoadAverage(),
            Memory: ReadMemory(),
            Disk: ReadDisk(capturesDir),
            Throttled: ReadThrottled());
    }

    private static string RuntimeInformation()
    {
        var desc = System.Runtime.InteropServices.RuntimeInformation.OSDescription;
        var arch = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture;
        return $"{desc} ({arch})";
    }

    private static double? ReadUptimeSeconds()
    {
        var text = TryReadFirstLine("/proc/uptime");
        if (text is null) return null;

        var first = text.Split(' ', 2)[0];
        return double.TryParse(first, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
    }

    private static double? ReadCpuTemperatureC()
    {
        var text = TryReadFirstLine("/sys/class/thermal/thermal_zone0/temp");
        if (text is null) return null;

        if (long.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var milli))
            return milli / 1000.0;
        return null;
    }

    private double? ReadCpuUsagePercent()
    {
        var snapshot = ReadCpuSnapshot();
        if (snapshot is null) return null;

        lock (_lock)
        {
            var prev = _previousCpu;
            _previousCpu = snapshot;
            if (prev is null) return null;

            var totalDelta = snapshot.Total - prev.Total;
            var idleDelta = snapshot.Idle - prev.Idle;
            if (totalDelta <= 0) return null;

            var usage = (totalDelta - idleDelta) * 100.0 / totalDelta;
            return Math.Clamp(usage, 0, 100);
        }
    }

    private static CpuSnapshot? ReadCpuSnapshot()
    {
        var text = TryReadFirstLine("/proc/stat");
        if (text is null || !text.StartsWith("cpu ", StringComparison.Ordinal)) return null;

        var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        // parts[0] == "cpu"; fields: user nice system idle iowait irq softirq steal guest guest_nice
        var values = new long[parts.Length - 1];
        for (var i = 0; i < values.Length; i++)
        {
            if (!long.TryParse(parts[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out values[i]))
                return null;
        }

        long total = 0;
        foreach (var v in values) total += v;
        var idle = values.Length > 3 ? values[3] : 0;
        var iowait = values.Length > 4 ? values[4] : 0;
        return new CpuSnapshot(total, idle + iowait);
    }

    private static double? ReadCpuFrequencyMhz()
    {
        var text = TryReadFirstLine("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq");
        if (text is null) return null;

        if (long.TryParse(text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var khz))
            return khz / 1000.0;
        return null;
    }

    private static LoadAverage? ReadLoadAverage()
    {
        var text = TryReadFirstLine("/proc/loadavg");
        if (text is null) return null;

        var parts = text.Split(' ');
        if (parts.Length < 3) return null;

        if (double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var one)
            && double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var five)
            && double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var fifteen))
        {
            return new LoadAverage(one, five, fifteen);
        }
        return null;
    }

    private static MemoryInfo? ReadMemory()
    {
        if (!File.Exists("/proc/meminfo")) return null;

        long? totalKb = null, availableKb = null, freeKb = null;
        foreach (var line in File.ReadLines("/proc/meminfo"))
        {
            if (line.StartsWith("MemTotal:", StringComparison.Ordinal)) totalKb = ParseMemLine(line);
            else if (line.StartsWith("MemAvailable:", StringComparison.Ordinal)) availableKb = ParseMemLine(line);
            else if (line.StartsWith("MemFree:", StringComparison.Ordinal)) freeKb = ParseMemLine(line);

            if (totalKb is not null && availableKb is not null) break;
        }

        if (totalKb is null) return null;
        var avail = availableKb ?? freeKb ?? 0;
        var used = totalKb.Value - avail;
        return new MemoryInfo(
            TotalBytes: totalKb.Value * 1024,
            AvailableBytes: avail * 1024,
            UsedBytes: used * 1024);
    }

    private static long? ParseMemLine(string line)
    {
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2) return null;
        return long.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : null;
    }

    private static DiskInfo? ReadDisk(string capturesDir)
    {
        try
        {
            var target = Directory.Exists(capturesDir) ? capturesDir : Path.GetPathRoot(Path.GetFullPath(capturesDir));
            if (string.IsNullOrEmpty(target)) return null;

            var drive = new DriveInfo(target);
            if (!drive.IsReady) return null;

            return new DiskInfo(
                Mount: drive.Name,
                TotalBytes: drive.TotalSize,
                FreeBytes: drive.AvailableFreeSpace,
                UsedBytes: drive.TotalSize - drive.AvailableFreeSpace);
        }
        catch
        {
            return null;
        }
    }

    private static ThrottledInfo? ReadThrottled()
    {
        // Raspberry Pi exposes this via vcgencmd; it's not in sysfs, so skip unless present via a cached file.
        // Keep hook for future: return null today.
        return null;
    }

    private static string? TryReadFirstLine(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var reader = new StreamReader(path);
            return reader.ReadLine();
        }
        catch
        {
            return null;
        }
    }

    private sealed record CpuSnapshot(long Total, long Idle);
}

public record DeviceMetrics(
    string Hostname,
    string Os,
    double? UptimeSeconds,
    double? CpuTemperatureC,
    double? CpuUsagePercent,
    double? CpuFrequencyMhz,
    LoadAverage? LoadAverage,
    MemoryInfo? Memory,
    DiskInfo? Disk,
    ThrottledInfo? Throttled);

public record LoadAverage(double OneMinute, double FiveMinute, double FifteenMinute);

public record MemoryInfo(long TotalBytes, long AvailableBytes, long UsedBytes);

public record DiskInfo(string Mount, long TotalBytes, long FreeBytes, long UsedBytes);

public record ThrottledInfo(bool UnderVoltageNow, bool ThrottledNow, bool UnderVoltageEver, bool ThrottledEver);

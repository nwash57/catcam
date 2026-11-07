using System.Globalization;

namespace CatCam.Api;

public sealed record HealthCheck(
    string Id,
    string Title,
    string Status,
    string Detail,
    string? Hint = null);

public sealed record HealthReport(
    string Status,
    DateTimeOffset CheckedAt,
    DateTimeOffset? LastEventAt,
    IReadOnlyList<HealthCheck> Checks);

/// <summary>
/// Turns raw metrics into named pass/warn/fail checks.
///
/// The checks exist because this system fails quietly. A detector can run for
/// months with a camera, a live stream, and a green process while every capture
/// it writes lands somewhere nobody reads. Each check below corresponds to a way
/// that has actually happened or plausibly could.
/// </summary>
public sealed class HealthService(MetricsReader metrics, IConfiguration config)
{
    public const string Ok = "ok";
    public const string Warn = "warn";
    public const string Fail = "fail";

    private double FreshnessWarnHours => config.GetValue("Health:FreshnessWarnHours", 12.0);
    private double FreshnessFailHours => config.GetValue("Health:FreshnessFailHours", 48.0);
    private double PiDiskWarnPercent => config.GetValue("Health:PiDiskWarnPercent", 85.0);
    private double PiDiskFailPercent => config.GetValue("Health:PiDiskFailPercent", 95.0);
    private double ServerDiskWarnPercent => config.GetValue("Health:ServerDiskWarnPercent", 90.0);
    private double ServerDiskFailPercent => config.GetValue("Health:ServerDiskFailPercent", 97.0);

    /// <summary>False for an all-in-one install, where local captures are correct.</summary>
    private bool ExpectSharedCaptures => config.GetValue("Health:ExpectSharedCaptures", true);

    public async Task<HealthReport> CheckAsync(string capturesDir, CancellationToken ct = default)
    {
        var device = await metrics.ReadAsync(capturesDir, config["Pi:MetricsUrl"]);
        var lastEvent = NewestEventTime(capturesDir);
        var checks = new List<HealthCheck>
        {
            CheckFreshness(lastEvent),
            CheckCapturesTarget(device),
            CheckWriteErrors(device),
            CheckPiReachable(device),
            CheckPiDisk(device),
            CheckServerDisk(device),
            CheckPower(device),
        };

        return new HealthReport(Worst(checks), DateTimeOffset.Now, lastEvent, checks);
    }

    private static string Worst(IEnumerable<HealthCheck> checks)
    {
        var statuses = checks.Select(c => c.Status).ToArray();
        if (statuses.Contains(Fail)) return Fail;
        return statuses.Contains(Warn) ? Warn : Ok;
    }

    /// <summary>
    /// Newest event, taken from the directory name rather than a timestamp.
    /// Names are `event_yyyyMMdd_HHmmss`; mtimes on a network share get rewritten
    /// by copies and rsyncs, so the name is the more trustworthy clock.
    /// </summary>
    private static DateTimeOffset? NewestEventTime(string capturesDir)
    {
        if (!Directory.Exists(capturesDir)) return null;

        var newest = new DirectoryInfo(capturesDir)
            .EnumerateDirectories("event_*")
            .Select(d => d.Name)
            .OrderByDescending(n => n, StringComparer.Ordinal)
            .FirstOrDefault();

        if (newest is null) return null;

        var stamp = newest.Length > 6 ? newest[6..] : null;
        return DateTimeOffset.TryParseExact(
            stamp, "yyyyMMdd_HHmmss", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeLocal, out var parsed)
            ? parsed
            : null;
    }

    private HealthCheck CheckFreshness(DateTimeOffset? lastEvent)
    {
        if (lastEvent is null)
            return new HealthCheck("capture_freshness", "Recent captures", Warn,
                "No events found at all.",
                "Expected if this is a fresh install; otherwise the detector has never written here.");

        var age = DateTimeOffset.Now - lastEvent.Value;
        var detail = $"Last event {Humanize(age)} ago ({lastEvent:yyyy-MM-dd HH:mm}).";

        if (age.TotalHours >= FreshnessFailHours)
            return new HealthCheck("capture_freshness", "Recent captures", Fail, detail,
                "Nothing is being recorded. Check the detector service and that its captures directory is mounted.");
        if (age.TotalHours >= FreshnessWarnHours)
            return new HealthCheck("capture_freshness", "Recent captures", Warn, detail,
                "Quiet for a while. Normal overnight, suspicious across a whole day.");

        return new HealthCheck("capture_freshness", "Recent captures", Ok, detail);
    }

    /// <summary>The check that would have caught the two-month outage.</summary>
    private HealthCheck CheckCapturesTarget(DeviceMetrics device)
    {
        var captures = device.Captures;
        if (captures?.OnRootFilesystem is null)
            return new HealthCheck("captures_target", "Captures destination", Ok,
                "Detector did not report a captures location.",
                "Needs a detector new enough to publish captures info in /metrics.");

        var path = captures.Path ?? "(unknown)";
        if (captures.OnRootFilesystem == true && ExpectSharedCaptures)
            return new HealthCheck("captures_target", "Captures destination", Fail,
                $"{path} is on the detector's own root filesystem — the share is not mounted.",
                "Captures are accumulating on the Pi's SD card where nothing will read them. Remount the share and move or discard what landed locally.");

        var where = captures.MountPoint is null ? path : $"{path} (mount {captures.MountPoint})";
        if (captures.Writable == false)
            return new HealthCheck("captures_target", "Captures destination", Fail,
                $"{where} is not writable.",
                "The detector cannot save anything. Check permissions and free space.");

        return new HealthCheck("captures_target", "Captures destination", Ok, $"Writing to {where}.");
    }

    private static HealthCheck CheckWriteErrors(DeviceMetrics device)
    {
        var err = device.Captures?.LastWriteError;
        if (err is null)
            return new HealthCheck("write_errors", "Write errors", Ok, "No write failures reported.");

        return new HealthCheck("write_errors", "Write errors", Fail,
            $"{err.Message} (at {err.At:yyyy-MM-dd HH:mm})",
            "The detector is running but could not save an event.");
    }

    private static HealthCheck CheckPiReachable(DeviceMetrics device) => device.PiReachable switch
    {
        null => new HealthCheck("pi_reachable", "Detector reachable", Ok,
            "No detector metrics URL configured.",
            "Set PI_METRICS_URL to monitor the detector host."),
        false => new HealthCheck("pi_reachable", "Detector reachable", Fail,
            "Cannot reach the detector's metrics endpoint.",
            "The Pi may be off, unreachable, or running without --stream."),
        _ => new HealthCheck("pi_reachable", "Detector reachable", Ok,
            $"Responding as {device.Hostname}."),
    };

    private HealthCheck CheckPiDisk(DeviceMetrics device)
    {
        var disk = device.RootDisk;
        if (disk?.PercentUsed is null)
            return new HealthCheck("pi_disk", "Detector disk", Ok, "Not reported.");

        var used = disk.PercentUsed.Value;
        var detail = $"{used:0.#}% used, {Bytes(disk.FreeBytes)} free on the detector's own disk.";

        if (used >= PiDiskFailPercent)
            return new HealthCheck("pi_disk", "Detector disk", Fail, detail,
                "About to run out of space. A full disk stops recording entirely.");
        if (used >= PiDiskWarnPercent)
            return new HealthCheck("pi_disk", "Detector disk", Warn, detail,
                "Filling up. If captures are supposed to go to a share, check that it is still mounted.");

        return new HealthCheck("pi_disk", "Detector disk", Ok, detail);
    }

    private HealthCheck CheckServerDisk(DeviceMetrics device)
    {
        var disk = device.Disk;
        if (disk is null || disk.TotalBytes <= 0)
            return new HealthCheck("server_disk", "Captures volume", Ok, "Not reported.");

        var used = disk.UsedBytes * 100.0 / disk.TotalBytes;
        var detail = $"{used:0.#}% used, {Bytes(disk.FreeBytes)} free on {disk.Mount}.";

        if (used >= ServerDiskFailPercent)
            return new HealthCheck("server_disk", "Captures volume", Fail, detail,
                "The captures volume is nearly full.");
        if (used >= ServerDiskWarnPercent)
            return new HealthCheck("server_disk", "Captures volume", Warn, detail);

        return new HealthCheck("server_disk", "Captures volume", Ok, detail);
    }

    private static HealthCheck CheckPower(DeviceMetrics device)
    {
        var t = device.Throttled;
        if (t is null)
            return new HealthCheck("power", "Power and throttling", Ok, "Not reported.");

        if (t.UnderVoltageNow || t.ThrottledNow)
            return new HealthCheck("power", "Power and throttling", Warn,
                t.UnderVoltageNow ? "Under-voltage right now." : "CPU is being throttled right now.",
                "Usually an underpowered supply or a thin USB cable. Dropped frames and camera resets follow.");

        if (t.UnderVoltageEver || t.ThrottledEver)
            return new HealthCheck("power", "Power and throttling", Ok,
                "Under-voltage or throttling seen since boot, but not currently.");

        return new HealthCheck("power", "Power and throttling", Ok, "Nominal.");
    }

    private static string Humanize(TimeSpan span)
    {
        if (span.TotalMinutes < 1) return "less than a minute";
        if (span.TotalMinutes < 60) return $"{span.TotalMinutes:0} minutes";
        if (span.TotalHours < 48) return $"{span.TotalHours:0.#} hours";
        return $"{span.TotalDays:0.#} days";
    }

    private static string Bytes(long value)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double size = value;
        var unit = 0;
        while (size >= 1024 && unit < units.Length - 1) { size /= 1024; unit++; }
        return $"{size:0.#} {units[unit]}";
    }
}

using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CatCam.Api;

public sealed class TranscodeService : BackgroundService
{
    private readonly ILogger<TranscodeService> _logger;
    private readonly string _capturesDir;
    private readonly JsonSerializerOptions _json;

    public TranscodeService(ILogger<TranscodeService> logger, IConfiguration config, IHostEnvironment env)
    {
        _logger = logger;
        var configured = config["Captures:Directory"]
            ?? throw new InvalidOperationException("Captures:Directory is not configured.");
        _capturesDir = Path.IsPathRooted(configured)
            ? configured
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, configured));

        _json = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var ffmpeg = FindFfmpeg();
        if (ffmpeg is null)
        {
            _logger.LogWarning("ffmpeg not found in PATH; background transcoding is disabled");
            return;
        }

        _logger.LogInformation("Transcode service started (ffmpeg: {Ffmpeg})", ffmpeg);

        while (!stoppingToken.IsCancellationRequested)
        {
            await ProcessPendingAsync(ffmpeg, stoppingToken);
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken).ConfigureAwait(false);
        }
    }

    private async Task ProcessPendingAsync(string ffmpeg, CancellationToken ct)
    {
        if (!Directory.Exists(_capturesDir)) return;

        foreach (var rawPath in Directory.EnumerateFiles(_capturesDir, "recording-raw.mp4", SearchOption.AllDirectories))
        {
            if (ct.IsCancellationRequested) break;
            await TryTranscodeAsync(rawPath, ffmpeg, ct);
        }
    }

    private async Task TryTranscodeAsync(string rawPath, string ffmpeg, CancellationToken ct)
    {
        var eventDir = Path.GetDirectoryName(rawPath)!;
        var jsonPath = Path.Combine(eventDir, "event.json");
        var outPath = Path.Combine(eventDir, "recording.mp4");

        EventSidecar? sidecar = null;
        if (File.Exists(jsonPath))
        {
            try
            {
                var text = await File.ReadAllTextAsync(jsonPath, ct);
                sidecar = JsonSerializer.Deserialize<EventSidecar>(text, _json);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not read {Json}", jsonPath);
            }
        }

        // Don't transcode while the event is still in progress.
        if (sidecar?.EndedAt is null)
            return;

        _logger.LogInformation("Transcoding {Raw}", rawPath);

        var args = new List<string> { "-y", "-loglevel", "error" };
        if (sidecar.MeasuredFps is > 0)
            args.AddRange(["-r", FormattableString.Invariant($"{sidecar.MeasuredFps:F3}")]);
        args.AddRange([
            "-i", rawPath,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            outPath,
        ]);

        int exitCode;
        try
        {
            exitCode = await RunAsync(ffmpeg, args, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ffmpeg process failed for {Raw}", rawPath);
            return;
        }

        if (exitCode != 0)
        {
            _logger.LogError("ffmpeg exited {Code} for {Raw}", exitCode, rawPath);
            return;
        }

        // Update event.json to point at the transcoded file.
        sidecar.VideoFile = "recording.mp4";
        try
        {
            await File.WriteAllTextAsync(jsonPath, JsonSerializer.Serialize(sidecar, _json), ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to update {Json} after transcode", jsonPath);
            return;
        }

        try { File.Delete(rawPath); } catch { /* best effort */ }

        _logger.LogInformation("Transcoded → {Out}", outPath);
    }

    private static async Task<int> RunAsync(string exe, IList<string> args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start process");
        await proc.WaitForExitAsync(ct);
        return proc.ExitCode;
    }

    private static string? FindFfmpeg()
    {
        var name = OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg";
        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        return pathVar
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(dir => Path.Combine(dir, name))
            .FirstOrDefault(File.Exists);
    }
}

// Matches the event.json written by the Python recorder.
// Used by both BuildSummary (read-only) and TranscodeService (read+write).
public class EventSidecar
{
    [JsonPropertyName("id")] public string? Id { get; set; }
    [JsonPropertyName("startedAt")] public DateTimeOffset? StartedAt { get; set; }
    [JsonPropertyName("endedAt")] public DateTimeOffset? EndedAt { get; set; }
    [JsonPropertyName("snapshotCount")] public int? SnapshotCount { get; set; }
    [JsonPropertyName("videoFile")] public string? VideoFile { get; set; }
    [JsonPropertyName("triggerFile")] public string? TriggerFile { get; set; }
    [JsonPropertyName("species")] public List<string>? Species { get; set; }
    [JsonPropertyName("measuredFps")] public double? MeasuredFps { get; set; }
}

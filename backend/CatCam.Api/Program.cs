using System.Text.Json;
using System.Text.Json.Serialization;
using CatCam.Api;
using Microsoft.AspNetCore.StaticFiles;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddSingleton<MetricsReader>();
builder.Services.AddHostedService<TranscodeService>();

const string AngularDevCors = "AngularDev";
builder.Services.AddCors(options =>
{
    options.AddPolicy(AngularDevCors, policy => policy
        .WithOrigins("http://localhost:4200", "http://catcam.local:4200")
        .AllowAnyHeader()
        .AllowAnyMethod());
});

var app = builder.Build();

var capturesDir = ResolveCapturesDirectory(app);
app.Logger.LogInformation("Serving captures from {Dir}", capturesDir);

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseCors(AngularDevCors);
}

var contentTypes = new FileExtensionContentTypeProvider();
var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);

app.MapGet("/api/events", (int? skip, int? take) =>
{
    var skipN = Math.Max(0, skip ?? 0);
    var takeN = Math.Clamp(take ?? 48, 1, 200);

    if (!Directory.Exists(capturesDir))
        return Results.Ok(new EventPage(Array.Empty<EventSummary>(), 0));

    // Directory names are `event_YYYYMMDD_HHMMSS`, so ordinal desc sort == newest first.
    // Sort before reading sidecars so we only parse event.json for the current page.
    var dirs = new DirectoryInfo(capturesDir)
        .EnumerateDirectories("event_*")
        .OrderByDescending(d => d.Name, StringComparer.Ordinal)
        .ToArray();

    var items = dirs
        .Skip(skipN)
        .Take(takeN)
        .Select(dir => BuildSummary(dir, jsonOptions))
        .OrderByDescending(e => e.StartedAt)
        .ToArray();

    return Results.Ok(new EventPage(items, dirs.Length));
});

app.MapGet("/api/events/{id}", (string id) =>
{
    if (!IsSafeSegment(id)) return Results.BadRequest();

    var dir = new DirectoryInfo(Path.Combine(capturesDir, id));
    if (!dir.Exists) return Results.NotFound();

    var summary = BuildSummary(dir, jsonOptions);
    var snapshots = dir.EnumerateFiles("*.jpg")
        .Concat(dir.EnumerateFiles("*.jpeg"))
        .Concat(dir.EnumerateFiles("*.png"))
        .OrderBy(f => f.Name)
        .Select(f => new MediaFile(f.Name, f.Length))
        .ToArray();

    return Results.Ok(new EventDetail(summary, snapshots));
});

app.MapGet("/media/{eventId}/{filename}", (string eventId, string filename) =>
{
    if (!IsSafeSegment(eventId) || !IsSafeSegment(filename))
        return Results.BadRequest();

    var path = Path.Combine(capturesDir, eventId, filename);
    if (!File.Exists(path)) return Results.NotFound();

    if (!contentTypes.TryGetContentType(path, out var contentType))
        contentType = "application/octet-stream";

    return Results.File(path, contentType, enableRangeProcessing: true);
});

app.MapGet("/api/metrics", async (MetricsReader reader, IConfiguration config) =>
{
    var piUrl = config["Pi:MetricsUrl"];
    return Results.Ok(await reader.ReadAsync(capturesDir, piUrl));
});

app.MapGet("/api/stream", (IConfiguration config) =>
{
    var url = config["Stream:Url"];
    return Results.Ok(new StreamConfig(string.IsNullOrWhiteSpace(url) ? null : url));
});

app.Run();

static string ResolveCapturesDirectory(WebApplication app)
{
    var configured = app.Configuration["Captures:Directory"]
        ?? throw new InvalidOperationException("Captures:Directory is not configured.");

    return Path.IsPathRooted(configured)
        ? configured
        : Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, configured));
}

static bool IsSafeSegment(string s) =>
    !string.IsNullOrEmpty(s)
    && !s.Contains('/') && !s.Contains('\\') && !s.Contains("..");

static EventSummary BuildSummary(DirectoryInfo dir, JsonSerializerOptions json)
{
    var jsonPath = Path.Combine(dir.FullName, "event.json");
    if (File.Exists(jsonPath))
    {
        try
        {
            var sidecar = JsonSerializer.Deserialize<EventSidecar>(File.ReadAllText(jsonPath), json);
            if (sidecar is not null)
            {
                var pendingVideo = string.IsNullOrEmpty(sidecar.VideoFile)
                    && File.Exists(Path.Combine(dir.FullName, "recording-raw.mp4"));
                return new EventSummary(
                    Id: sidecar.Id ?? dir.Name,
                    StartedAt: sidecar.StartedAt ?? dir.CreationTimeUtc,
                    EndedAt: sidecar.EndedAt,
                    SnapshotCount: sidecar.SnapshotCount ?? CountSnapshots(dir),
                    HasVideo: !string.IsNullOrEmpty(sidecar.VideoFile),
                    VideoFile: sidecar.VideoFile,
                    TriggerFile: sidecar.TriggerFile ?? FirstSnapshot(dir),
                    Species: (IReadOnlyList<string>?)sidecar.Species ?? Array.Empty<string>(),
                    InProgress: sidecar.EndedAt is null,
                    PendingVideo: pendingVideo);
            }
        }
        catch
        {
            // Fall through to filesystem inference.
        }
    }

    return InferSummary(dir);
}

static EventSummary InferSummary(DirectoryInfo dir)
{
    var videoFile = dir.EnumerateFiles("recording.mp4").FirstOrDefault();
    var rawFile = dir.EnumerateFiles("recording-raw.mp4").FirstOrDefault();
    return new EventSummary(
        Id: dir.Name,
        StartedAt: dir.CreationTimeUtc,
        EndedAt: null,
        SnapshotCount: CountSnapshots(dir),
        HasVideo: videoFile is not null,
        VideoFile: videoFile?.Name,
        TriggerFile: FirstSnapshot(dir),
        Species: Array.Empty<string>(),
        InProgress: true,
        PendingVideo: videoFile is null && rawFile is not null);
}

static int CountSnapshots(DirectoryInfo dir) =>
    dir.EnumerateFiles("*.jpg").Count()
    + dir.EnumerateFiles("*.jpeg").Count()
    + dir.EnumerateFiles("*.png").Count();

static string? FirstSnapshot(DirectoryInfo dir) =>
    dir.EnumerateFiles("*.jpg")
        .Concat(dir.EnumerateFiles("*.jpeg"))
        .Concat(dir.EnumerateFiles("*.png"))
        .OrderBy(f => f.Name)
        .FirstOrDefault()?.Name;

record EventSummary(
    string Id,
    DateTimeOffset StartedAt,
    DateTimeOffset? EndedAt,
    int SnapshotCount,
    bool HasVideo,
    string? VideoFile,
    string? TriggerFile,
    IReadOnlyList<string> Species,
    bool InProgress,
    bool PendingVideo);

record MediaFile(string Name, long SizeBytes);

record EventDetail(EventSummary Summary, IReadOnlyList<MediaFile> Snapshots);

record EventPage(IReadOnlyList<EventSummary> Items, int Total);

record StreamConfig(string? Url);

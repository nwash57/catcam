using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using CatCam.Api;
using Microsoft.AspNetCore.StaticFiles;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddSingleton<MetricsReader>();
builder.Services.AddHostedService<TranscodeService>();
builder.Services.AddHttpClient("AutoLabel")
    .ConfigureHttpClient(c => c.Timeout = TimeSpan.FromMinutes(5));

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

app.MapGet("/api/events", (int? skip, int? take, string? species, string? name) =>
{
    var skipN = Math.Max(0, skip ?? 0);
    var takeN = Math.Clamp(take ?? 48, 1, 200);
    var hasFilter = !string.IsNullOrWhiteSpace(species) || !string.IsNullOrWhiteSpace(name);

    if (!Directory.Exists(capturesDir))
        return Results.Ok(new EventPage(Array.Empty<EventSummary>(), 0));

    // Directory names are `event_YYYYMMDD_HHMMSS`, so ordinal desc sort == newest first.
    var dirs = new DirectoryInfo(capturesDir)
        .EnumerateDirectories("event_*")
        .OrderByDescending(d => d.Name, StringComparer.Ordinal)
        .ToArray();

    if (!hasFilter)
    {
        // Fast path: only read sidecars for the current page.
        var items = dirs
            .Skip(skipN)
            .Take(takeN)
            .Select(dir => BuildSummary(dir, jsonOptions))
            .OrderByDescending(e => e.StartedAt)
            .ToArray();
        return Results.Ok(new EventPage(items, dirs.Length));
    }

    // Filtered path: read all summaries (including annotations) then paginate.
    var filtered = dirs
        .Select(dir => BuildSummary(dir, jsonOptions))
        .OrderByDescending(e => e.StartedAt)
        .Where(e =>
            (string.IsNullOrWhiteSpace(species) || e.Species.Any(s => s.Equals(species, StringComparison.OrdinalIgnoreCase)))
            && (string.IsNullOrWhiteSpace(name) || e.SubjectNames.Any(n => n.Equals(name, StringComparison.OrdinalIgnoreCase))))
        .ToArray();

    return Results.Ok(new EventPage(filtered.Skip(skipN).Take(takeN).ToArray(), filtered.Length));
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

app.MapGet("/api/events/{id}/neighbors", (string id) =>
{
    if (!IsSafeSegment(id)) return Results.BadRequest();

    if (!Directory.Exists(capturesDir))
        return Results.Ok(new EventNeighbors(null, null));

    // Directory names are `event_YYYYMMDD_HHMMSS`, ordinal desc = newest first.
    var dirs = new DirectoryInfo(capturesDir)
        .EnumerateDirectories("event_*")
        .OrderByDescending(d => d.Name, StringComparer.Ordinal)
        .Select(d => d.Name)
        .ToArray();

    var idx = Array.IndexOf(dirs, id);
    if (idx < 0) return Results.NotFound();

    var newer = idx > 0 ? dirs[idx - 1] : null;
    var older = idx < dirs.Length - 1 ? dirs[idx + 1] : null;

    return Results.Ok(new EventNeighbors(older, newer));
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

app.MapGet("/api/events/{id}/annotations", (string id) =>
{
    if (!IsSafeSegment(id)) return Results.BadRequest();
    var dir = new DirectoryInfo(Path.Combine(capturesDir, id));
    if (!dir.Exists) return Results.NotFound();
    return Results.Ok(ReadAnnotations(dir, jsonOptions));
});

app.MapPut("/api/events/{id}/annotations", async (string id, EventAnnotations body, CancellationToken ct) =>
{
    if (!IsSafeSegment(id)) return Results.BadRequest();
    var dir = new DirectoryInfo(Path.Combine(capturesDir, id));
    if (!dir.Exists) return Results.NotFound();

    // Validate species
    var allowed = new HashSet<string> { "cat", "dog", "possum", "raccoon", "deer" };
    if (body.Subjects.Any(s => !allowed.Contains(s.Species)))
        return Results.BadRequest("Invalid species value.");

    // Validate bounding box coordinates
    static bool ValidBox(AnnotationBoundingBox b) =>
        b.X >= 0 && b.Y >= 0 && b.Width > 0 && b.Height > 0
        && b.X + b.Width <= 1.0 + 1e-9 && b.Y + b.Height <= 1.0 + 1e-9;
    var badBox = body.Snapshots
        .SelectMany(s => s.Annotations)
        .Where(a => a.BoundingBox is not null)
        .Any(a => !ValidBox(a.BoundingBox!));
    if (badBox) return Results.BadRequest("Bounding box coordinates out of range.");

    // Validate subjectId references
    var subjectIds = body.Subjects.Select(s => s.Id).ToHashSet();
    var badRef = body.Snapshots
        .SelectMany(s => s.Annotations)
        .Any(a => !subjectIds.Contains(a.SubjectId));
    if (badRef) return Results.BadRequest("Snapshot annotation references unknown subjectId.");

    var saved = body with { SchemaVersion = 1, UpdatedAt = DateTimeOffset.UtcNow };
    await WriteAnnotationsAsync(dir, saved, jsonOptions, ct);
    return Results.Ok(saved);
});

app.MapPost("/api/events/{id}/auto-label", async (
    string id, IConfiguration config, IHttpClientFactory httpFactory, CancellationToken ct) =>
{
    if (!IsSafeSegment(id)) return Results.BadRequest();
    var dir = new DirectoryInfo(Path.Combine(capturesDir, id));
    if (!dir.Exists) return Results.NotFound();

    var sidecarUrl = config["AutoLabel:Url"];
    if (string.IsNullOrWhiteSpace(sidecarUrl))
        return Results.Problem("Auto-label service not configured.", statusCode: 503);

    var snapshots = dir.EnumerateFiles("*.jpg")
        .Concat(dir.EnumerateFiles("*.jpeg"))
        .Concat(dir.EnumerateFiles("*.png"))
        .OrderBy(f => f.Name);

    var client = httpFactory.CreateClient("AutoLabel");
    var results = new List<AutoLabelSnapshotResult>();

    foreach (var snap in snapshots)
    {
        try
        {
            var resp = await client.PostAsJsonAsync(
                $"{sidecarUrl}/label",
                new { image_path = snap.FullName },
                jsonOptions, ct);
            if (!resp.IsSuccessStatusCode) continue;
            var body = await resp.Content.ReadFromJsonAsync<JsonElement>(jsonOptions, ct);
            var detections = body.GetProperty("detections")
                .Deserialize<List<AutoLabelDetection>>(jsonOptions) ?? [];
            results.Add(new AutoLabelSnapshotResult(snap.Name, detections));
        }
        catch { /* skip failed snapshots */ }
    }

    return Results.Ok(new AutoLabelResponse(results));
});

app.MapDelete("/api/events/{id}", (string id) =>
{
    if (!IsSafeSegment(id)) return Results.BadRequest();
    var dir = new DirectoryInfo(Path.Combine(capturesDir, id));
    if (!dir.Exists) return Results.NotFound();
    dir.Delete(recursive: true);
    return Results.NoContent();
});

app.MapGet("/api/subjects/names", (string? species) =>
{
    if (!Directory.Exists(capturesDir))
        return Results.Ok(new SubjectNameList(Array.Empty<string>()));

    var names = new DirectoryInfo(capturesDir)
        .EnumerateDirectories("event_*")
        .Select(d => ReadAnnotations(d, jsonOptions))
        .SelectMany(a => a.Subjects)
        .Where(s => species is null || s.Species == species)
        .Select(s => s.Name)
        .Where(n => !string.IsNullOrWhiteSpace(n))
        .Select(n => n!.Trim())
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    return Results.Ok(new SubjectNameList(names));
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
                var annotations = ReadAnnotations(dir, json);
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
                    PendingVideo: pendingVideo,
                    AnnotatedSubjectCount: annotations.Subjects.Count,
                    SubjectNames: ExtractSubjectNames(annotations));
            }
        }
        catch
        {
            // Fall through to filesystem inference.
        }
    }

    return InferSummary(dir, json);
}

static EventSummary InferSummary(DirectoryInfo dir, JsonSerializerOptions json)
{
    var videoFile = dir.EnumerateFiles("recording.mp4").FirstOrDefault();
    var rawFile = dir.EnumerateFiles("recording-raw.mp4").FirstOrDefault();
    var annotations = ReadAnnotations(dir, json);
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
        PendingVideo: videoFile is null && rawFile is not null,
        AnnotatedSubjectCount: annotations.Subjects.Count,
        SubjectNames: ExtractSubjectNames(annotations));
}

static IReadOnlyList<string> ExtractSubjectNames(EventAnnotations annotations) =>
    annotations.Subjects
        .Select(s => s.Name)
        .Where(n => !string.IsNullOrWhiteSpace(n))
        .Select(n => n!)
        .ToArray();

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

static EventAnnotations ReadAnnotations(DirectoryInfo dir, JsonSerializerOptions json)
{
    var path = Path.Combine(dir.FullName, "annotations.json");
    if (!File.Exists(path))
        return new EventAnnotations(1, DateTimeOffset.MinValue, [], []);
    try
    {
        var a = JsonSerializer.Deserialize<EventAnnotations>(File.ReadAllText(path), json);
        return a ?? new EventAnnotations(1, DateTimeOffset.MinValue, [], []);
    }
    catch { return new EventAnnotations(1, DateTimeOffset.MinValue, [], []); }
}

static async Task WriteAnnotationsAsync(DirectoryInfo dir, EventAnnotations annotations,
    JsonSerializerOptions json, CancellationToken ct)
{
    var dest = Path.Combine(dir.FullName, "annotations.json");
    var tmp = Path.Combine(dir.FullName, ".annotations.tmp");
    await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(annotations, json), ct);
    File.Move(tmp, dest, overwrite: true);
}

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
    bool PendingVideo,
    int AnnotatedSubjectCount,
    IReadOnlyList<string> SubjectNames);

record MediaFile(string Name, long SizeBytes);

record EventDetail(EventSummary Summary, IReadOnlyList<MediaFile> Snapshots);

record EventPage(IReadOnlyList<EventSummary> Items, int Total);

record StreamConfig(string? Url);

record EventNeighbors(string? OlderId, string? NewerId);

record SubjectNameList(IReadOnlyList<string> Names);

record EventAnnotations(
    [property: JsonPropertyName("schemaVersion")] int SchemaVersion,
    [property: JsonPropertyName("updatedAt")] DateTimeOffset UpdatedAt,
    [property: JsonPropertyName("subjects")] List<AnnotatedSubject> Subjects,
    [property: JsonPropertyName("snapshots")] List<SnapshotAnnotation> Snapshots);

record AnnotatedSubject(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("species")] string Species,
    [property: JsonPropertyName("name")] string? Name);

record SnapshotAnnotation(
    [property: JsonPropertyName("filename")] string Filename,
    [property: JsonPropertyName("annotations")] List<SubjectAnnotation> Annotations);

record SubjectAnnotation(
    [property: JsonPropertyName("subjectId")] string SubjectId,
    [property: JsonPropertyName("includeInTraining")] bool IncludeInTraining,
    [property: JsonPropertyName("boundingBox")] AnnotationBoundingBox? BoundingBox);

record AnnotationBoundingBox(
    [property: JsonPropertyName("x")] double X,
    [property: JsonPropertyName("y")] double Y,
    [property: JsonPropertyName("width")] double Width,
    [property: JsonPropertyName("height")] double Height);

record AutoLabelDetection(
    [property: JsonPropertyName("species")] string Species,
    [property: JsonPropertyName("confidence")] double Confidence,
    [property: JsonPropertyName("bbox")] AnnotationBoundingBox Bbox);

record AutoLabelSnapshotResult(
    [property: JsonPropertyName("filename")] string Filename,
    [property: JsonPropertyName("detections")] List<AutoLabelDetection> Detections);

record AutoLabelResponse(
    [property: JsonPropertyName("snapshots")] List<AutoLabelSnapshotResult> Snapshots);

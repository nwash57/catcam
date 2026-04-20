using Microsoft.AspNetCore.StaticFiles;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();

const string AngularDevCors = "AngularDev";
builder.Services.AddCors(options =>
{
    options.AddPolicy(AngularDevCors, policy => policy
        .WithOrigins("http://localhost:4200")
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

app.MapGet("/api/captures", () =>
{
    if (!Directory.Exists(capturesDir))
        return Results.Ok(Array.Empty<CaptureDto>());

    var captures = new DirectoryInfo(capturesDir)
        .EnumerateFiles()
        .Where(f => IsMedia(f.Name))
        .OrderByDescending(f => f.LastWriteTimeUtc)
        .Select(f => new CaptureDto(
            f.Name,
            IsVideo(f.Name) ? "video" : "image",
            f.LastWriteTimeUtc,
            f.Length))
        .ToArray();

    return Results.Ok(captures);
});

app.MapGet("/media/{filename}", (string filename) =>
{
    // Prevent path traversal — only allow a bare filename.
    if (filename.Contains('/') || filename.Contains('\\') || filename.Contains(".."))
        return Results.BadRequest();

    var path = Path.Combine(capturesDir, filename);
    if (!File.Exists(path))
        return Results.NotFound();

    if (!contentTypes.TryGetContentType(path, out var contentType))
        contentType = "application/octet-stream";

    return Results.File(path, contentType, enableRangeProcessing: true);
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

static bool IsMedia(string name) => IsImage(name) || IsVideo(name);
static bool IsImage(string name) => name.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
    || name.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)
    || name.EndsWith(".png", StringComparison.OrdinalIgnoreCase);
static bool IsVideo(string name) => name.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)
    || name.EndsWith(".webm", StringComparison.OrdinalIgnoreCase)
    || name.EndsWith(".mov", StringComparison.OrdinalIgnoreCase);

record CaptureDto(string Name, string Type, DateTime CapturedAt, long SizeBytes);

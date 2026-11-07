using System.Diagnostics;
using System.Text.Json;

namespace CatCam.Api;

/// <summary>One event as the index knows it.</summary>
internal sealed record IndexedEvent(
    EventSummary Summary,
    IReadOnlyList<AnnotatedSubject> Subjects,
    long SizeBytes,
    DateTime DirWrittenAtUtc);

/// <summary>
/// In-memory index of every event directory, so requests never walk the
/// captures tree themselves.
///
/// With tens of thousands of events, listing the directory and reading each
/// sidecar per request made the dashboard slow, and the filtered views and the
/// subject-name list read every annotations.json on every load. Instead, one
/// full scan runs at startup, then a cheap reconcile runs periodically: it lists
/// only the top-level directories and rescans an event only when its directory
/// timestamp changed (a file was added, removed, or renamed — which covers the
/// detector finishing an event, a transcode completing, and atomic annotation
/// saves) or while it is still in progress and its files are growing.
///
/// Writes the API makes itself call <see cref="Refresh"/> or <see cref="Remove"/>
/// so they show up immediately rather than on the next reconcile.
/// </summary>
internal sealed class EventIndex
{
    private static readonly string[] SnapshotExtensions = [".jpg", ".jpeg", ".png"];

    private readonly string _capturesDir;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);
    private readonly ILogger<EventIndex> _logger;
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object _writeLock = new();

    private Snapshot _snapshot = Snapshot.Empty;

    public EventIndex(CapturesDirectory captures, ILogger<EventIndex> logger)
    {
        _capturesDir = captures.Path;
        _logger = logger;
    }

    /// <summary>Completes once the first full scan has finished.</summary>
    public Task WhenReadyAsync(CancellationToken ct = default) => _ready.Task.WaitAsync(ct);

    public bool IsReady => _ready.Task.IsCompleted;

    /// <summary>
    /// Lets waiters through after a failed first scan, so requests get an empty
    /// index instead of hanging. The next successful reconcile fills it in.
    /// </summary>
    public void ReleaseWaiters() => _ready.TrySetResult();

    /// <summary>All events, newest first (directory names sort chronologically).</summary>
    public IReadOnlyList<IndexedEvent> Events => _snapshot.Events;

    /// <summary>Bytes under the captures directory: every event plus loose top-level files.</summary>
    public long TotalBytes => _snapshot.TotalBytes;

    public DateTimeOffset? ScannedAt => _snapshot.ScannedAt;

    public IndexedEvent? Get(string id) =>
        _snapshot.ById.TryGetValue(id, out var e) ? e : null;

    /// <summary>
    /// Brings the index up to date with the filesystem. The first call scans
    /// every event; later calls only rescan what changed.
    /// </summary>
    public void Reconcile(CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var previous = _snapshot;
        var root = new DirectoryInfo(_capturesDir);
        // A recording grows without touching its directory's timestamp, so live
        // events are rescanned every pass. Bounded by age so an event the detector
        // abandoned (no event.json ever written) doesn't cost a rescan forever.
        var liveCutoff = DateTime.UtcNow - TimeSpan.FromHours(1);
        var events = new List<IndexedEvent>(previous.Events.Count + 16);
        long looseBytes = 0;
        var rescanned = 0;

        if (root.Exists)
        {
            foreach (var info in root.EnumerateFileSystemInfos())
            {
                ct.ThrowIfCancellationRequested();
                switch (info)
                {
                    case FileInfo f:
                        looseBytes += f.Length;
                        break;
                    case DirectoryInfo d when d.Name.StartsWith("event_", StringComparison.Ordinal):
                        // LastWriteTimeUtc comes from the directory listing itself,
                        // so checking for changes costs no extra I/O per event.
                        if (previous.ById.TryGetValue(d.Name, out var known)
                            && known.DirWrittenAtUtc == d.LastWriteTimeUtc
                            && !(known.Summary.InProgress && known.DirWrittenAtUtc > liveCutoff))
                        {
                            events.Add(known);
                        }
                        else
                        {
                            events.Add(Scan(d));
                            rescanned++;
                        }
                        break;
                }
            }
        }

        lock (_writeLock)
        {
            // Directory names are `event_YYYYMMDD_HHMMSS`, so ordinal desc == newest first.
            events.Sort((a, b) => StringComparer.Ordinal.Compare(b.Summary.Id, a.Summary.Id));
            _snapshot = Snapshot.Create(events, looseBytes);
        }

        if (!IsReady)
        {
            _logger.LogInformation("Indexed {Count} events ({Bytes:N0} bytes) in {Ms} ms",
                events.Count, _snapshot.TotalBytes, sw.ElapsedMilliseconds);
            _ready.TrySetResult();
        }
        else if (rescanned > 0)
        {
            _logger.LogDebug("Reconciled index: rescanned {Rescanned} of {Count} events in {Ms} ms",
                rescanned, events.Count, sw.ElapsedMilliseconds);
        }
    }

    /// <summary>Rescans one event now, e.g. after the API wrote to it.</summary>
    public IndexedEvent? Refresh(string id)
    {
        var dir = new DirectoryInfo(Path.Combine(_capturesDir, id));
        if (!dir.Exists)
        {
            Remove(id);
            return null;
        }

        var scanned = Scan(dir);
        lock (_writeLock)
        {
            var events = _snapshot.Events.Where(e => e.Summary.Id != id).Append(scanned).ToList();
            events.Sort((a, b) => StringComparer.Ordinal.Compare(b.Summary.Id, a.Summary.Id));
            _snapshot = Snapshot.Create(events, _snapshot.LooseBytes);
        }
        return scanned;
    }

    public void Remove(string id)
    {
        lock (_writeLock)
        {
            if (!_snapshot.ById.ContainsKey(id)) return;
            var events = _snapshot.Events.Where(e => e.Summary.Id != id).ToList();
            _snapshot = Snapshot.Create(events, _snapshot.LooseBytes);
        }
    }

    /// <summary>Reads one event directory: a single listing plus its two sidecars.</summary>
    private IndexedEvent Scan(DirectoryInfo dir)
    {
        var writtenAt = dir.LastWriteTimeUtc;
        FileInfo[] files;
        try
        {
            files = dir.GetFiles();
        }
        catch (IOException)
        {
            // Deleted between the listing and now; the next reconcile drops it.
            files = [];
        }

        long size = 0;
        var snapshots = new List<string>();
        bool hasRaw = false, hasRecording = false;
        foreach (var f in files)
        {
            size += f.Length;
            if (SnapshotExtensions.Contains(f.Extension, StringComparer.OrdinalIgnoreCase))
                snapshots.Add(f.Name);
            else if (f.Name == "recording-raw.mp4") hasRaw = true;
            else if (f.Name == "recording.mp4") hasRecording = true;
        }
        snapshots.Sort(StringComparer.Ordinal);

        var annotations = ReadAnnotations(dir, _json);
        var subjectNames = annotations.Subjects
            .Select(s => s.Name)
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Select(n => n!)
            .ToArray();

        var sidecar = ReadSidecar(dir);
        var summary = sidecar is not null
            ? new EventSummary(
                Id: sidecar.Id ?? dir.Name,
                StartedAt: sidecar.StartedAt ?? dir.CreationTimeUtc,
                EndedAt: sidecar.EndedAt,
                SnapshotCount: sidecar.SnapshotCount ?? snapshots.Count,
                HasVideo: !string.IsNullOrEmpty(sidecar.VideoFile),
                VideoFile: sidecar.VideoFile,
                TriggerFile: sidecar.TriggerFile ?? snapshots.FirstOrDefault(),
                Species: (IReadOnlyList<string>?)sidecar.Species ?? Array.Empty<string>(),
                InProgress: sidecar.EndedAt is null,
                PendingVideo: string.IsNullOrEmpty(sidecar.VideoFile) && hasRaw,
                AnnotatedSubjectCount: annotations.Subjects.Count,
                SubjectNames: subjectNames)
            // No sidecar yet: the detector writes event.json when the event ends.
            : new EventSummary(
                Id: dir.Name,
                StartedAt: dir.CreationTimeUtc,
                EndedAt: null,
                SnapshotCount: snapshots.Count,
                HasVideo: hasRecording,
                VideoFile: hasRecording ? "recording.mp4" : null,
                TriggerFile: snapshots.FirstOrDefault(),
                Species: Array.Empty<string>(),
                InProgress: true,
                PendingVideo: !hasRecording && hasRaw,
                AnnotatedSubjectCount: annotations.Subjects.Count,
                SubjectNames: subjectNames);

        return new IndexedEvent(summary, annotations.Subjects, size, writtenAt);
    }

    private EventSidecar? ReadSidecar(DirectoryInfo dir)
    {
        var path = Path.Combine(dir.FullName, "event.json");
        try
        {
            return File.Exists(path)
                ? JsonSerializer.Deserialize<EventSidecar>(File.ReadAllText(path), _json)
                : null;
        }
        catch
        {
            return null; // Half-written or corrupt; treat as no sidecar.
        }
    }

    public static EventAnnotations ReadAnnotations(DirectoryInfo dir, JsonSerializerOptions json)
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

    /// <summary>Immutable view swapped in whole, so readers never see a half-built index.</summary>
    private sealed record Snapshot(
        IReadOnlyList<IndexedEvent> Events,
        IReadOnlyDictionary<string, IndexedEvent> ById,
        long LooseBytes,
        long TotalBytes,
        DateTimeOffset? ScannedAt)
    {
        public static readonly Snapshot Empty =
            new([], new Dictionary<string, IndexedEvent>(), 0, 0, null);

        public static Snapshot Create(List<IndexedEvent> events, long looseBytes) => new(
            events,
            events.ToDictionary(e => e.Summary.Id),
            looseBytes,
            looseBytes + events.Sum(e => e.SizeBytes),
            DateTimeOffset.Now);
    }
}

/// <summary>Runs the initial scan, then reconciles on a timer.</summary>
internal sealed class EventIndexer(EventIndex index, IConfiguration config, ILogger<EventIndexer> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(config.GetValue("Index:ReconcileSeconds", 15.0));
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // Off the startup path: the scan can take a while on a large tree.
                await Task.Run(() => index.Reconcile(stoppingToken), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Event index reconcile failed");
                index.ReleaseWaiters();
            }
            await Task.Delay(interval, stoppingToken).ConfigureAwait(false);
        }
    }
}

/// <summary>The resolved captures path, shared by everything that reads it.</summary>
internal sealed record CapturesDirectory(string Path)
{
    public static CapturesDirectory Resolve(IConfiguration config, IHostEnvironment env)
    {
        var configured = config["Captures:Directory"]
            ?? throw new InvalidOperationException("Captures:Directory is not configured.");
        return new CapturesDirectory(System.IO.Path.IsPathRooted(configured)
            ? configured
            : System.IO.Path.GetFullPath(System.IO.Path.Combine(env.ContentRootPath, configured)));
    }
}

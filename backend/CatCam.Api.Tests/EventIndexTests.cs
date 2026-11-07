using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace CatCam.Api.Tests;

/// <summary>
/// The index replaces per-request directory walks, so the risk is staleness:
/// these cover that it picks up what the detector and the API change on disk.
/// </summary>
public sealed class EventIndexTests : IDisposable
{
    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "catcam-index-" + Guid.NewGuid().ToString("N"));

    private readonly EventIndex _index;

    public EventIndexTests()
    {
        Directory.CreateDirectory(_root);
        _index = new EventIndex(new CapturesDirectory(_root), NullLogger<EventIndex>.Instance);
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private string MakeEvent(string id, bool ended = true, params (string Name, int Bytes)[] files)
    {
        var dir = Path.Combine(_root, id);
        Directory.CreateDirectory(dir);
        foreach (var (name, bytes) in files)
            File.WriteAllBytes(Path.Combine(dir, name), new byte[bytes]);
        if (ended)
        {
            File.WriteAllText(Path.Combine(dir, "event.json"),
                $$"""{"id":"{{id}}","startedAt":"2026-01-01T00:00:00Z","endedAt":"2026-01-01T00:01:00Z","species":["cat"]}""");
        }
        return dir;
    }

    [Fact]
    public void Reconcile_IndexesEventsNewestFirst_AndTotalsSizesIncludingLooseFiles()
    {
        MakeEvent("event_20260101_000000", files: ("a.jpg", 100));
        var newer = MakeEvent("event_20260102_000000", files: [("a.jpg", 200), ("recording.mp4", 1000)]);
        File.WriteAllBytes(Path.Combine(_root, "stray.jpg"), new byte[50]);

        _index.Reconcile();

        Assert.True(_index.IsReady);
        Assert.Equal(["event_20260102_000000", "event_20260101_000000"],
            _index.Events.Select(e => e.Summary.Id));
        var sidecarBytes = new FileInfo(Path.Combine(newer, "event.json")).Length * 2;
        Assert.Equal(100 + 200 + 1000 + 50 + sidecarBytes, _index.TotalBytes);
        Assert.Equal("a.jpg", _index.Get("event_20260102_000000")!.Summary.TriggerFile);
    }

    [Fact]
    public void Reconcile_PicksUpAddedAndRemovedEvents()
    {
        var first = MakeEvent("event_20260101_000000");
        _index.Reconcile();

        MakeEvent("event_20260102_000000");
        Directory.Delete(first, recursive: true);
        _index.Reconcile();

        Assert.Equal(["event_20260102_000000"], _index.Events.Select(e => e.Summary.Id));
    }

    [Fact]
    public void Reconcile_SeesEventFinishing()
    {
        var id = "event_20260101_000000";
        MakeEvent(id, ended: false, files: ("a.jpg", 10));
        _index.Reconcile();
        Assert.True(_index.Get(id)!.Summary.InProgress);

        // The detector writes event.json when the event ends.
        MakeEvent(id);
        _index.Reconcile();

        Assert.False(_index.Get(id)!.Summary.InProgress);
        Assert.Equal(["cat"], _index.Get(id)!.Summary.Species);
    }

    [Fact]
    public void Refresh_ReflectsAnnotationsImmediately()
    {
        var id = "event_20260101_000000";
        var dir = MakeEvent(id);
        _index.Reconcile();

        File.WriteAllText(Path.Combine(dir, "annotations.json"),
            """{"schemaVersion":1,"updatedAt":"2026-01-01T00:00:00Z","subjects":[{"id":"s1","species":"cat","name":"Tom"}],"snapshots":[]}""");
        _index.Refresh(id);

        Assert.Equal(["Tom"], _index.Get(id)!.Summary.SubjectNames);
    }

    [Fact]
    public void Remove_DropsEventAndItsBytes()
    {
        var id = "event_20260101_000000";
        MakeEvent(id, files: ("a.jpg", 500));
        _index.Reconcile();

        _index.Remove(id);

        Assert.Empty(_index.Events);
        Assert.Equal(0, _index.TotalBytes);
    }
}

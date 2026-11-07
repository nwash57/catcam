using System.Text;

namespace CatCam.Api;

/// <summary>
/// Polls health in the background and pushes to ntfy when it changes.
///
/// The dashboard only helps someone who opens it. This is the part that speaks
/// up on its own — it exists because an outage once ran for two months behind a
/// UI that looked fine and nobody had reason to visit.
/// </summary>
internal sealed class HealthMonitor(
    HealthService health,
    CapturesDirectory captures,
    IConfiguration config,
    IHttpClientFactory httpFactory,
    ILogger<HealthMonitor> logger) : BackgroundService
{
    private string? _lastStatus;
    private DateTimeOffset _lastAlertAt = DateTimeOffset.MinValue;

    private string? Topic => config["Health:NtfyTopic"];
    private TimeSpan Interval => TimeSpan.FromSeconds(config.GetValue("Health:PollSeconds", 300));

    /// <summary>How long a problem may stay quiet before it is re-announced.</summary>
    private TimeSpan ReminderAfter => TimeSpan.FromHours(config.GetValue("Health:ReminderHours", 24.0));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (string.IsNullOrWhiteSpace(Topic))
            logger.LogInformation("Health monitoring active; ntfy alerts disabled (no Health:NtfyTopic).");

        // Let the app settle before the first probe so startup noise doesn't alert.
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken).ContinueWith(_ => { }, CancellationToken.None);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var report = await health.CheckAsync(captures.Path, stoppingToken);
                await ReactAsync(report, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Health check failed");
            }

            try { await Task.Delay(Interval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task ReactAsync(HealthReport report, CancellationToken ct)
    {
        var changed = report.Status != _lastStatus;
        var stale = report.Status != HealthService.Ok
                    && DateTimeOffset.Now - _lastAlertAt >= ReminderAfter;

        if (!changed && !stale)
            return;

        // Don't announce "everything is fine" to a listener that never heard a problem.
        var firstObservation = _lastStatus is null;
        _lastStatus = report.Status;

        if (report.Status == HealthService.Ok && firstObservation)
            return;

        logger.LogInformation("Health status {Status}", report.Status);
        _lastAlertAt = DateTimeOffset.Now;
        await PushAsync(report, ct);
    }

    private async Task PushAsync(HealthReport report, CancellationToken ct)
    {
        var topic = Topic;
        if (string.IsNullOrWhiteSpace(topic))
            return;

        var problems = report.Checks
            .Where(c => c.Status != HealthService.Ok)
            .ToArray();

        var (title, tags, priority) = report.Status switch
        {
            HealthService.Fail => ("CatCam is not recording", "rotating_light", "high"),
            HealthService.Warn => ("CatCam needs a look", "warning", "default"),
            _ => ("CatCam is healthy again", "white_check_mark", "low"),
        };

        var body = new StringBuilder();
        if (problems.Length == 0)
        {
            body.AppendLine("All checks passing.");
        }
        else
        {
            foreach (var p in problems)
            {
                body.AppendLine($"{p.Title}: {p.Detail}");
                if (!string.IsNullOrWhiteSpace(p.Hint))
                    body.AppendLine($"  → {p.Hint}");
            }
        }

        if (report.LastEventAt is { } last)
            body.AppendLine($"Last event: {last:yyyy-MM-dd HH:mm}");

        try
        {
            var client = httpFactory.CreateClient("Ntfy");
            using var request = new HttpRequestMessage(HttpMethod.Post, $"https://ntfy.sh/{topic}")
            {
                Content = new StringContent(body.ToString(), Encoding.UTF8),
            };
            request.Headers.TryAddWithoutValidation("Title", title);
            request.Headers.TryAddWithoutValidation("Tags", tags);
            request.Headers.TryAddWithoutValidation("Priority", priority);

            var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
                logger.LogWarning("ntfy push failed: {Status}", response.StatusCode);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "ntfy push failed");
        }
    }
}

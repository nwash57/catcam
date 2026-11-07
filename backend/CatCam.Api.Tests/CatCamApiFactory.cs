using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace CatCam.Api.Tests;

/// <summary>
/// Boots the API in-memory for integration tests. Each instance points the app
/// at a throwaway temp captures directory so tests never touch real capture
/// data, and the ffmpeg-driven <see cref="TranscodeService"/> is removed so the
/// suite stays hermetic.
/// </summary>
public sealed class CatCamApiFactory : WebApplicationFactory<Program>
{
    public string CapturesDirectory { get; } =
        Path.Combine(Path.GetTempPath(), "catcam-tests-" + Guid.NewGuid().ToString("N"));

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(CapturesDirectory);

        // Appended after appsettings.json, so these win over whatever the
        // real config files contain — keeping the suite hermetic and offline.
        builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Captures:Directory"] = CapturesDirectory,
                ["Stream:Url"] = "",
                ["Pi:MetricsUrl"] = "",
                ["AutoLabel:Url"] = "",
            });
        });

        builder.ConfigureServices(services =>
        {
            var transcoder = services.SingleOrDefault(
                d => d.ServiceType == typeof(IHostedService)
                     && d.ImplementationType == typeof(TranscodeService));
            if (transcoder is not null)
                services.Remove(transcoder);
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(CapturesDirectory))
            Directory.Delete(CapturesDirectory, recursive: true);
    }
}

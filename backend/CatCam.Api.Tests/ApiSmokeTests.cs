using System.Net;
using System.Net.Http.Json;
using Xunit;

namespace CatCam.Api.Tests;

/// <summary>
/// End-to-end smoke tests that prove the HTTP harness boots and routes. They
/// run against an empty captures directory; behavioural coverage of filtering,
/// annotations, and path-traversal guards belongs in dedicated test classes.
/// </summary>
public sealed class ApiSmokeTests(CatCamApiFactory factory) : IClassFixture<CatCamApiFactory>
{
    [Fact]
    public async Task GetEvents_WithEmptyCapturesDirectory_ReturnsEmptyPage()
    {
        var client = factory.CreateClient();

        var page = await client.GetFromJsonAsync<EventPageDto>("/api/events");

        Assert.NotNull(page);
        Assert.Empty(page!.Items);
        Assert.Equal(0, page.Total);
    }

    [Fact]
    public async Task GetEvent_WithUnknownId_ReturnsNotFound()
    {
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/events/event_does_not_exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task GetStream_WithNoConfiguredUrl_ReturnsNullUrl()
    {
        var client = factory.CreateClient();

        var config = await client.GetFromJsonAsync<StreamConfigDto>("/api/stream");

        Assert.NotNull(config);
        Assert.Null(config!.Url);
    }
}

// Local mirrors of the API's response shapes — the production records in
// Program.cs are internal, so tests deserialize into their own DTOs.
file sealed record EventPageDto(EventSummaryDto[] Items, int Total);

file sealed record EventSummaryDto(string Id);

file sealed record StreamConfigDto(string? Url);

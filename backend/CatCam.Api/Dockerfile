FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY CatCam.Api/CatCam.Api.csproj ./CatCam.Api/
RUN dotnet restore ./CatCam.Api/CatCam.Api.csproj
COPY CatCam.Api/ ./CatCam.Api/
RUN dotnet publish ./CatCam.Api/CatCam.Api.csproj -c Release -o /publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /publish .
ENV ASPNETCORE_HTTP_PORTS=8080
ENTRYPOINT ["dotnet", "CatCam.Api.dll"]

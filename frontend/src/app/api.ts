import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface EventSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  snapshotCount: number;
  hasVideo: boolean;
  videoFile: string | null;
  triggerFile: string | null;
  species: string[];
  inProgress: boolean;
  pendingVideo: boolean;
}

export interface MediaFile {
  name: string;
  sizeBytes: number;
}

export interface EventDetail {
  summary: EventSummary;
  snapshots: MediaFile[];
}

export interface EventPage {
  items: EventSummary[];
  total: number;
}

export interface EventNeighbors {
  olderId: string | null;
  newerId: string | null;
}

export interface StreamConfig {
  url: string | null;
}

export interface LoadAverage {
  oneMinute: number;
  fiveMinute: number;
  fifteenMinute: number;
}

export interface MemoryInfo {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
}

export interface DiskInfo {
  mount: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface ThrottledInfo {
  underVoltageNow: boolean;
  throttledNow: boolean;
  underVoltageEver: boolean;
  throttledEver: boolean;
}

export interface DeviceMetrics {
  hostname: string;
  os: string;
  uptimeSeconds: number | null;
  cpuTemperatureC: number | null;
  cpuUsagePercent: number | null;
  cpuFrequencyMhz: number | null;
  loadAverage: LoadAverage | null;
  memory: MemoryInfo | null;
  disk: DiskInfo | null;
  throttled: ThrottledInfo | null;
}

@Injectable({ providedIn: 'root' })
export class CatcamApi {
  private http = inject(HttpClient);

  listEvents(skip = 0, take = 48): Observable<EventPage> {
    const params = new HttpParams().set('skip', skip).set('take', take);
    return this.http.get<EventPage>('/api/events', { params });
  }

  getEvent(id: string): Observable<EventDetail> {
    return this.http.get<EventDetail>(`/api/events/${encodeURIComponent(id)}`);
  }

  getNeighbors(id: string): Observable<EventNeighbors> {
    return this.http.get<EventNeighbors>(`/api/events/${encodeURIComponent(id)}/neighbors`);
  }

  mediaUrl(eventId: string, filename: string): string {
    return `/media/${encodeURIComponent(eventId)}/${encodeURIComponent(filename)}`;
  }

  getStreamConfig(): Observable<StreamConfig> {
    return this.http.get<StreamConfig>('/api/stream');
  }

  getMetrics(): Observable<DeviceMetrics> {
    return this.http.get<DeviceMetrics>('/api/metrics');
  }
}

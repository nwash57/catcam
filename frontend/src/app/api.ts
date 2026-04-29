import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export const ALLOWED_SPECIES = ['cat', 'dog', 'possum', 'raccoon', 'deer'] as const;
export type Species = typeof ALLOWED_SPECIES[number];

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubjectAnnotation {
  subjectId: string;
  includeInTraining: boolean;
  boundingBox: BoundingBox | null;
}

export interface SnapshotAnnotation {
  filename: string;
  annotations: SubjectAnnotation[];
}

export interface AnnotatedSubject {
  id: string;
  species: Species;
  name: string | null;
}

export interface EventAnnotations {
  schemaVersion: number;
  updatedAt: string;
  subjects: AnnotatedSubject[];
  snapshots: SnapshotAnnotation[];
}

export interface SubjectNameList {
  names: string[];
}

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
  annotatedSubjectCount: number;
  subjectNames: string[];
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

export interface AutoLabelDetection {
  species: Species;
  confidence: number;
  bbox: BoundingBox;
}

export interface AutoLabelSnapshotResult {
  filename: string;
  detections: AutoLabelDetection[];
}

export interface AutoLabelResponse {
  snapshots: AutoLabelSnapshotResult[];
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

  listEvents(skip = 0, take = 48, species?: string, name?: string): Observable<EventPage> {
    let params = new HttpParams().set('skip', skip).set('take', take);
    if (species) params = params.set('species', species);
    if (name) params = params.set('name', name);
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

  getAnnotations(eventId: string): Observable<EventAnnotations> {
    return this.http.get<EventAnnotations>(`/api/events/${encodeURIComponent(eventId)}/annotations`);
  }

  putAnnotations(eventId: string, body: EventAnnotations): Observable<EventAnnotations> {
    return this.http.put<EventAnnotations>(`/api/events/${encodeURIComponent(eventId)}/annotations`, body);
  }

  getSubjectNames(species?: Species): Observable<SubjectNameList> {
    const params = species ? new HttpParams().set('species', species) : undefined;
    return this.http.get<SubjectNameList>('/api/subjects/names', { params });
  }

  deleteEvent(id: string): Observable<void> {
    return this.http.delete<void>(`/api/events/${encodeURIComponent(id)}`);
  }

  autoLabel(eventId: string): Observable<AutoLabelResponse> {
    return this.http.post<AutoLabelResponse>(
      `/api/events/${encodeURIComponent(eventId)}/auto-label`,
      null,
    );
  }

  getMetrics(): Observable<DeviceMetrics> {
    return this.http.get<DeviceMetrics>('/api/metrics');
  }
}

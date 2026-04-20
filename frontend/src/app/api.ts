import { HttpClient } from '@angular/common/http';
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
}

export interface MediaFile {
  name: string;
  sizeBytes: number;
}

export interface EventDetail {
  summary: EventSummary;
  snapshots: MediaFile[];
}

@Injectable({ providedIn: 'root' })
export class CatcamApi {
  private http = inject(HttpClient);

  listEvents(): Observable<EventSummary[]> {
    return this.http.get<EventSummary[]>('/api/events');
  }

  getEvent(id: string): Observable<EventDetail> {
    return this.http.get<EventDetail>(`/api/events/${encodeURIComponent(id)}`);
  }

  mediaUrl(eventId: string, filename: string): string {
    return `/media/${encodeURIComponent(eventId)}/${encodeURIComponent(filename)}`;
  }
}

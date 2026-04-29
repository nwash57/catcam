import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, forkJoin, of, switchMap, timer } from 'rxjs';
import {
  ALLOWED_SPECIES,
  AnnotatedSubject,
  AutoLabelSnapshotResult,
  CatcamApi,
  EventAnnotations,
  EventDetail as EventDetailModel,
  EventNeighbors,
  MediaFile,
  SnapshotAnnotation,
  Species,
} from '../api';
import { SubjectEditor } from '../annotation/subject-editor';
import { SnapshotAnnotator } from '../annotation/snapshot-annotator';

@Component({
  selector: 'app-event-detail',
  imports: [RouterLink, DatePipe, SubjectEditor, SnapshotAnnotator],
  templateUrl: './event-detail.html',
})
export class EventDetail {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(CatcamApi);
  private destroyRef = inject(DestroyRef);

  private currentEventId = signal<string | null>(null);

  protected readonly detail = signal<EventDetailModel | null>(null);
  protected readonly annotations = signal<EventAnnotations>({
    schemaVersion: 1, updatedAt: '', subjects: [], snapshots: [],
  });
  readonly isDirty = signal(false);
  protected readonly isSaving = signal(false);
  protected readonly isConfirmingDelete = signal(false);
  protected readonly isDeleting = signal(false);
  protected readonly nameSuggestions = signal<Record<string, string[]>>({});
  protected readonly activeSnapshot = signal<MediaFile | null>(null);
  protected readonly lightbox = signal<MediaFile | null>(null);
  protected readonly isAutoLabeling = signal(false);
  protected readonly autoLabelSuggestions = signal<AutoLabelSnapshotResult[]>([]);
  protected readonly autoLabelError = signal<string | null>(null);

  protected readonly neighbors = toSignal<EventNeighbors | null>(
    this.route.paramMap.pipe(
      switchMap(p => this.api.getNeighbors(p.get('id')!).pipe(catchError(() => of(null)))),
    ),
    { initialValue: null },
  );

  protected readonly streamConfig = toSignal(this.api.getStreamConfig(), { initialValue: null });

  protected readonly liveUrl = computed(() => {
    const d = this.detail();
    const config = this.streamConfig();
    if (!d?.summary.inProgress || !config?.url) return null;
    return config.url;
  });

  protected readonly videoUrl = computed(() => {
    const d = this.detail();
    if (!d?.summary.videoFile) return null;
    return this.api.mediaUrl(d.summary.id, d.summary.videoFile);
  });

  constructor() {
    this.route.paramMap.pipe(
      switchMap(p => {
        const id = p.get('id')!;
        this.currentEventId.set(id);
        this.isDirty.set(false);
        this.isConfirmingDelete.set(false);
        this.activeSnapshot.set(null);
        this.annotations.set({ schemaVersion: 1, updatedAt: '', subjects: [], snapshots: [] });
        this.autoLabelSuggestions.set([]);
        this.autoLabelError.set(null);

        this.api.getAnnotations(id).pipe(catchError(() => of(null))).subscribe(a => {
          if (a) this.annotations.set(a);
        });

        forkJoin(
          ALLOWED_SPECIES.map(s => this.api.getSubjectNames(s).pipe(catchError(() => of({ names: [] as string[] }))))
        ).subscribe(results => {
          this.nameSuggestions.set(Object.fromEntries(ALLOWED_SPECIES.map((s, i) => [s, results[i].names])));
        });

        return timer(0, 5000).pipe(switchMap(() => this.api.getEvent(id)));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(d => {
      if (!this.isDirty()) {
        this.detail.set(d);
      }
    });
  }

  protected snapshotUrl(file: MediaFile): string {
    return this.api.mediaUrl(this.detail()!.summary.id, file.name);
  }

  protected onSubjectsChange(subjects: AnnotatedSubject[]): void {
    this.annotations.update(a => ({ ...a, subjects }));
    this.isDirty.set(true);
  }

  protected saveAnnotations(): void {
    const id = this.currentEventId();
    if (!id) return;
    this.isSaving.set(true);
    this.api.putAnnotations(id, this.annotations()).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: saved => {
        this.annotations.set(saved);
        this.isDirty.set(false);
        this.isSaving.set(false);
      },
      error: () => this.isSaving.set(false),
    });
  }

  protected openAnnotator(snapshot: MediaFile): void {
    this.activeSnapshot.set(snapshot);
  }

  protected onAnnotatorSave(result: SnapshotAnnotation): void {
    this.applyAnnotation(result);
    this.activeSnapshot.set(null);
  }

  protected onAnnotatorSaveAndNext(result: SnapshotAnnotation): void {
    this.applyAnnotation(result);
    this.navigateAnnotator('next');
  }

  protected onAnnotatorSkip(): void {
    this.navigateAnnotator('next');
  }

  protected onAnnotatorBack(): void {
    this.navigateAnnotator('prev');
  }

  protected onAnnotatorCancel(): void {
    this.activeSnapshot.set(null);
  }

  private applyAnnotation(result: SnapshotAnnotation): void {
    this.annotations.update(a => {
      const existing = a.snapshots.filter(s => s.filename !== result.filename);
      const snapshots = result.annotations.length > 0 ? [...existing, result] : existing;
      return { ...a, snapshots };
    });
    this.isDirty.set(true);
  }

  private navigateAnnotator(direction: 'next' | 'prev'): void {
    const snapshots = this.detail()?.snapshots ?? [];
    const current = this.activeSnapshot();
    if (!current) return;
    const idx = snapshots.findIndex(s => s.name === current.name);
    if (idx < 0) return;
    const target = direction === 'next' ? snapshots[idx + 1] : snapshots[idx - 1];
    this.activeSnapshot.set(target ?? null);
  }

  protected readonly annotatorHasPrev = computed(() => {
    const snapshots = this.detail()?.snapshots ?? [];
    const current = this.activeSnapshot();
    if (!current) return false;
    return snapshots.findIndex(s => s.name === current.name) > 0;
  });

  protected readonly annotatorHasNext = computed(() => {
    const snapshots = this.detail()?.snapshots ?? [];
    const current = this.activeSnapshot();
    if (!current) return false;
    const idx = snapshots.findIndex(s => s.name === current.name);
    return idx >= 0 && idx < snapshots.length - 1;
  });

  protected deleteEvent(): void {
    const id = this.currentEventId();
    if (!id) return;
    this.isDeleting.set(true);
    this.api.deleteEvent(id).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: () => this.router.navigate(['/']),
      error: () => this.isDeleting.set(false),
    });
  }

  protected snapshotAnnotation(filename: string): SnapshotAnnotation | null {
    return this.annotations().snapshots.find(s => s.filename === filename) ?? null;
  }

  protected hasAnnotation(filename: string): boolean {
    const a = this.snapshotAnnotation(filename);
    return (a?.annotations.length ?? 0) > 0;
  }

  protected suggestionsForSnapshot(filename: string): AutoLabelSnapshotResult | null {
    return this.autoLabelSuggestions().find(s => s.filename === filename) ?? null;
  }

  private autoAddSubjectsFromDetections(snapshots: AutoLabelSnapshotResult[]): void {
    const detected = new Set(snapshots.flatMap(s => s.detections.map(d => d.species as string)));
    const subjects = this.annotations().subjects;
    const newSubjects: AnnotatedSubject[] = [];

    for (const value of detected) {
      const isSpecies = (ALLOWED_SPECIES as readonly string[]).includes(value);
      const exists = isSpecies
        ? subjects.some(s => s.species === value && !s.name)
        : subjects.some(s => s.name?.toLowerCase() === value.toLowerCase());
      if (exists) continue;

      const id = `s${subjects.length + newSubjects.length + 1}_${Date.now()}`;
      newSubjects.push(isSpecies
        ? { id, species: value as Species, name: null }
        : { id, species: 'cat', name: value });
    }

    if (newSubjects.length > 0) {
      this.annotations.update(a => ({ ...a, subjects: [...a.subjects, ...newSubjects] }));
      this.isDirty.set(true);
    }
  }

  protected onAutoLabel(): void {
    const id = this.currentEventId();
    if (!id) return;
    this.isAutoLabeling.set(true);
    this.autoLabelError.set(null);
    this.api.autoLabel(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: r => {
        this.autoLabelSuggestions.set(r.snapshots);
        this.isAutoLabeling.set(false);
        this.autoAddSubjectsFromDetections(r.snapshots);
      },
      error: () => {
        this.autoLabelError.set('Auto-label failed — is the GPU service running?');
        this.isAutoLabeling.set(false);
      },
    });
  }
}

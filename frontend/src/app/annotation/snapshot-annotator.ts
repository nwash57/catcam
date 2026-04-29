import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { AnnotatedSubject, AutoLabelSnapshotResult, BoundingBox, SnapshotAnnotation, SubjectAnnotation } from '../api';
import { BboxCanvas, DrawnBox, PreviewBox } from './bbox-canvas';

const SUBJECT_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7'];

@Component({
  selector: 'app-snapshot-annotator',
  imports: [BboxCanvas],
  templateUrl: './snapshot-annotator.html',
})
export class SnapshotAnnotator implements OnInit {
  readonly filename = input.required<string>();
  readonly imageUrl = input.required<string>();
  readonly subjects = input.required<AnnotatedSubject[]>();
  readonly existingAnnotation = input<SnapshotAnnotation | null>(null);
  readonly autoLabelSuggestions = input<AutoLabelSnapshotResult | null>(null);
  readonly hasPrev = input<boolean>(false);
  readonly hasNext = input<boolean>(false);
  readonly save = output<SnapshotAnnotation>();
  readonly saveAndNext = output<SnapshotAnnotation>();
  readonly skip = output<void>();
  readonly back = output<void>();
  readonly cancel = output<void>();

  protected readonly activeSubjectId = signal<string | null>(null);
  protected readonly rows = signal<SubjectAnnotation[]>([]);
  protected readonly assignedSuggestions = signal<Set<number>>(new Set());
  protected readonly hoveredSuggestionIndex = signal<number | null>(null);
  // Maps subjectId → suggestion index that provided the current bbox, so clearing can free the suggestion
  private readonly suggestionSourceMap = signal<Map<string, number>>(new Map());

  protected readonly pendingSuggestions = computed(() =>
    (this.autoLabelSuggestions()?.detections ?? [])
      .map((d, i) => ({ ...d, index: i }))
      .filter(d => !this.assignedSuggestions().has(d.index))
  );

  protected readonly previewBox = computed<PreviewBox | null>(() => {
    const idx = this.hoveredSuggestionIndex();
    if (idx === null) return null;
    const det = this.autoLabelSuggestions()?.detections[idx];
    if (!det) return null;
    const pct = Math.round(det.confidence * 100);
    return { bbox: det.bbox, label: `${det.species} ${pct}%` };
  });

  ngOnInit(): void {
    const existing = this.existingAnnotation();
    const initial = this.subjects().map(subject => {
      const found = existing?.annotations.find(a => a.subjectId === subject.id);
      return found ?? { subjectId: subject.id, includeInTraining: false, boundingBox: null };
    });
    this.rows.set(initial);
    if (!existing) {
      this.autoAssignNamedSuggestions();
    }
  }

  private autoAssignNamedSuggestions(): void {
    const detections = this.autoLabelSuggestions()?.detections ?? [];
    for (const subject of this.subjects()) {
      if (!subject.name) continue;
      const name = subject.name.toLowerCase();
      let bestIndex = -1, bestConf = -1;
      detections.forEach((det, i) => {
        if (!this.assignedSuggestions().has(i) && det.species.toLowerCase() === name && det.confidence > bestConf) {
          bestIndex = i;
          bestConf = det.confidence;
        }
      });
      if (bestIndex >= 0) this.acceptSuggestion(bestIndex, subject.id);
    }
  }

  protected colorFor(subjectId: string): string {
    const idx = this.subjects().findIndex(s => s.id === subjectId);
    return SUBJECT_COLORS[idx % SUBJECT_COLORS.length] ?? '#64748b';
  }

  protected labelFor(subjectId: string): string {
    const s = this.subjects().find(s => s.id === subjectId);
    if (!s) return subjectId;
    return s.name ? `${s.name} (${s.species})` : s.species;
  }

  protected appearsInSnapshot(subjectId: string): boolean {
    const row = this.rows().find(r => r.subjectId === subjectId);
    if (!row) return false;
    return row.includeInTraining || row.boundingBox !== null;
  }

  protected setAppears(subjectId: string, appears: boolean): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === subjectId
        ? { ...r, includeInTraining: appears, boundingBox: appears ? r.boundingBox : null }
        : r
    ));
    if (!appears && this.activeSubjectId() === subjectId) {
      this.activeSubjectId.set(null);
    }
  }

  protected getIncludeInTraining(subjectId: string): boolean {
    return this.rows().find(r => r.subjectId === subjectId)?.includeInTraining ?? false;
  }

  protected setIncludeInTraining(subjectId: string, value: boolean): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === subjectId ? { ...r, includeInTraining: value } : r
    ));
  }

  protected getBbox(subjectId: string): BoundingBox | null {
    return this.rows().find(r => r.subjectId === subjectId)?.boundingBox ?? null;
  }

  protected toggleDrawMode(subjectId: string): void {
    this.activeSubjectId.set(
      this.activeSubjectId() === subjectId ? null : subjectId
    );
  }

  protected clearBbox(subjectId: string): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === subjectId ? { ...r, boundingBox: null } : r
    ));
    if (this.activeSubjectId() === subjectId) {
      this.activeSubjectId.set(null);
    }
    this.freeSuggestionSource(subjectId);
  }

  protected readonly boxes = computed<DrawnBox[]>(() =>
    this.rows()
      .filter(r => r.boundingBox !== null)
      .map(r => ({ subjectId: r.subjectId, box: r.boundingBox! }))
  );

  protected onBoxDrawn(drawn: DrawnBox): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === drawn.subjectId
        ? { ...r, boundingBox: drawn.box, includeInTraining: true }
        : r
    ));
    this.activeSubjectId.set(null);
    this.freeSuggestionSource(drawn.subjectId);
  }

  protected onSave(): void {
    this.save.emit(this.buildAnnotation());
  }

  protected onSaveAndNext(): void {
    const annotation = this.buildAnnotation();
    this.saveAndNext.emit({
      ...annotation,
      annotations: annotation.annotations.map(a => ({ ...a, boundingBox: null })),
    });
  }

  protected onSkip(): void {
    this.skip.emit();
  }

  protected onBack(): void {
    this.back.emit();
  }

  protected onCancel(): void {
    this.cancel.emit();
  }

  private buildAnnotation(): SnapshotAnnotation {
    const annotations = this.rows().filter(r => r.includeInTraining || r.boundingBox !== null);
    return { filename: this.filename(), annotations };
  }

  protected acceptSuggestion(index: number, subjectId: string): void {
    const det = this.autoLabelSuggestions()?.detections[index];
    if (!det) return;
    // Free any suggestion previously assigned to this subject
    this.freeSuggestionSource(subjectId);
    this.rows.update(rows => rows.map(r =>
      r.subjectId === subjectId
        ? { ...r, boundingBox: det.bbox, includeInTraining: true }
        : r
    ));
    this.assignedSuggestions.update(s => new Set([...s, index]));
    this.suggestionSourceMap.update(m => new Map([...m, [subjectId, index]]));
  }

  protected dismissSuggestion(index: number): void {
    this.assignedSuggestions.update(s => new Set([...s, index]));
  }

  private freeSuggestionSource(subjectId: string): void {
    const src = this.suggestionSourceMap().get(subjectId);
    if (src !== undefined) {
      this.assignedSuggestions.update(s => { const n = new Set(s); n.delete(src); return n; });
      this.suggestionSourceMap.update(m => { const n = new Map(m); n.delete(subjectId); return n; });
    }
  }
}

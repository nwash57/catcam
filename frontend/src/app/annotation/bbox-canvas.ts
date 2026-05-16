import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  input,
  output,
} from '@angular/core';
import { AnnotatedSubject, BoundingBox } from '../api';

export interface PreviewBox {
  bbox: BoundingBox;
  label: string;
}

export interface DrawnBox {
  subjectId: string;
  box: BoundingBox;
}

const SUBJECT_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7'];

@Component({
  selector: 'app-bbox-canvas',
  templateUrl: './bbox-canvas.html',
})
export class BboxCanvas implements AfterViewInit, OnDestroy {
  readonly imageUrl = input.required<string>();
  readonly subjects = input.required<AnnotatedSubject[]>();
  readonly boxes = input<DrawnBox[]>([]);
  readonly activeSubjectId = input<string | null>(null);
  readonly previewBox = input<PreviewBox | null>(null);
  readonly boxDrawn = output<DrawnBox>();

  @ViewChild('canvas') private canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('img') private imgRef!: ElementRef<HTMLImageElement>;

  private dragStart: { x: number; y: number } | null = null;
  private dragCurrent: { x: number; y: number } | null = null;

  private readonly onDocMouseMove = (e: MouseEvent) => {
    if (!this.dragStart) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.dragCurrent = {
      x: Math.max(0, Math.min(e.clientX - rect.left, rect.width)),
      y: Math.max(0, Math.min(e.clientY - rect.top, rect.height)),
    };
    this.redraw();
  };

  private readonly onDocMouseUp = (e: MouseEvent) => {
    document.removeEventListener('mousemove', this.onDocMouseMove);
    document.removeEventListener('mouseup', this.onDocMouseUp);
    if (!this.dragStart || !this.activeSubjectId()) {
      this.dragStart = null;
      this.dragCurrent = null;
      this.redraw();
      return;
    }
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const ex = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const ey = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const box = this.makeBox(this.dragStart.x, this.dragStart.y, ex, ey, rect.width, rect.height);
    if (box.width > 0.01 && box.height > 0.01) {
      this.boxDrawn.emit({ subjectId: this.activeSubjectId()!, box });
    }
    this.dragStart = null;
    this.dragCurrent = null;
    this.redraw();
  };

  constructor() {
    effect(() => {
      this.boxes();
      this.activeSubjectId();
      this.previewBox();
      this.redraw();
    });
  }

  ngAfterViewInit(): void {
    this.redraw();
  }

  ngOnDestroy(): void {
    document.removeEventListener('mousemove', this.onDocMouseMove);
    document.removeEventListener('mouseup', this.onDocMouseUp);
  }

  protected colorFor(subjectId: string): string {
    const idx = this.subjects().findIndex(s => s.id === subjectId);
    return SUBJECT_COLORS[idx % SUBJECT_COLORS.length] ?? '#64748b';
  }

  protected onMouseDown(event: MouseEvent): void {
    if (!this.activeSubjectId()) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.dragStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.dragCurrent = { ...this.dragStart };
    document.addEventListener('mousemove', this.onDocMouseMove);
    document.addEventListener('mouseup', this.onDocMouseUp);
    event.preventDefault();
  }

  protected onTouchStart(event: TouchEvent): void {
    if (!this.activeSubjectId() || event.touches.length !== 1) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const t = event.touches[0];
    this.dragStart = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    this.dragCurrent = { ...this.dragStart };
    event.preventDefault();
  }

  protected onTouchMove(event: TouchEvent): void {
    if (!this.dragStart || event.touches.length !== 1) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const t = event.touches[0];
    this.dragCurrent = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    this.redraw();
    event.preventDefault();
  }

  protected onTouchEnd(event: TouchEvent): void {
    if (!this.dragStart || !this.activeSubjectId()) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const t = event.changedTouches[0];
    const box = this.makeBox(
      this.dragStart.x, this.dragStart.y,
      t.clientX - rect.left, t.clientY - rect.top,
      rect.width, rect.height
    );
    if (box.width > 0.01 && box.height > 0.01) {
      this.boxDrawn.emit({ subjectId: this.activeSubjectId()!, box });
    }
    this.dragStart = null;
    this.dragCurrent = null;
    this.redraw();
  }

  private makeBox(sx: number, sy: number, ex: number, ey: number, w: number, h: number): BoundingBox {
    const x = Math.max(0, Math.min(sx, ex) / w);
    const y = Math.max(0, Math.min(sy, ey) / h);
    return {
      x,
      y,
      width: Math.min(Math.abs(ex - sx) / w, 1 - x),
      height: Math.min(Math.abs(ey - sy) / h, 1 - y),
    };
  }

  private redraw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (const drawn of this.boxes()) {
      const color = this.colorFor(drawn.subjectId);
      const isActive = drawn.subjectId === this.activeSubjectId();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      if (isActive) {
        ctx.setLineDash([6, 3]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.strokeRect(
        drawn.box.x * w,
        drawn.box.y * h,
        drawn.box.width * w,
        drawn.box.height * h
      );
      ctx.setLineDash([]);
    }

    // Draw hover-preview suggestion box
    const preview = this.previewBox();
    if (preview) {
      const { x, y, width, height } = preview.bbox;
      ctx.save();
      ctx.strokeStyle = '#7c3aed';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.fillStyle = 'rgba(124, 58, 237, 0.10)';
      ctx.fillRect(x * w, y * h, width * w, height * h);
      ctx.strokeRect(x * w, y * h, width * w, height * h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#7c3aed';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(preview.label, x * w + 3, y * h - 4);
      ctx.restore();
    }

    // Draw in-progress drag rectangle
    if (this.dragStart && this.dragCurrent && this.activeSubjectId()) {
      const color = this.colorFor(this.activeSubjectId()!);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      const x = Math.min(this.dragStart.x, this.dragCurrent.x);
      const y = Math.min(this.dragStart.y, this.dragCurrent.y);
      const bw = Math.abs(this.dragCurrent.x - this.dragStart.x);
      const bh = Math.abs(this.dragCurrent.y - this.dragStart.y);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);
    }
  }

  protected onImageLoad(): void {
    this.syncCanvasSize();
  }

  private syncCanvasSize(): void {
    const img = this.imgRef.nativeElement;
    const canvas = this.canvasRef.nativeElement;
    const rect = img.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    this.redraw();
  }
}

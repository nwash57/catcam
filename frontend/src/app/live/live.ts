import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CatcamApi } from '../api';

@Component({
  selector: 'app-live',
  templateUrl: './live.html',
})
export class LiveView implements OnDestroy {
  @ViewChild('streamWrapper') private streamWrapper!: ElementRef<HTMLDivElement>;
  @ViewChild('theaterWrapper') private theaterWrapper!: ElementRef<HTMLDivElement>;

  private api = inject(CatcamApi);
  protected readonly streamConfig = toSignal(this.api.getStreamConfig(), { initialValue: null });
  protected readonly theater = signal(false);
  protected readonly isFullscreen = signal(false);

  private readonly onFullscreenChange = () => this.isFullscreen.set(!!document.fullscreenElement);

  constructor() {
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  }

  ngOnDestroy() {
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    if (document.fullscreenElement) document.exitFullscreen();
  }

  protected toggleTheater() {
    this.theater.update(v => !v);
  }

  protected toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      const el = this.theater() ? this.theaterWrapper.nativeElement : this.streamWrapper.nativeElement;
      el.requestFullscreen();
    }
  }
}

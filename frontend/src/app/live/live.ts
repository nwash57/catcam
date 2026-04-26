import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CatcamApi } from '../api';

@Component({
  selector: 'app-live',
  templateUrl: './live.html',
})
export class LiveView {
  private api = inject(CatcamApi);
  protected readonly streamConfig = toSignal(this.api.getStreamConfig(), { initialValue: null });
}

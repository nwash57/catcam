import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { DeviceMetricsPanel } from './device-metrics/device-metrics';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet, DeviceMetricsPanel],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}

import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DeviceMetricsPanel } from './device-metrics/device-metrics';
import { HealthPill } from './health/health-pill';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, DeviceMetricsPanel, HealthPill],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}

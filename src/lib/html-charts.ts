/**
 * Inline SVG bar charts for the HTML report. No JavaScript, no external
 * assets: renders under a strict Content-Security-Policy (e.g. Jenkins).
 * Pure.
 */

export interface BarRow {
  readonly label: string;
  /** Main bar (e.g. p95). */
  readonly value: number;
  /** Optional darker overlay bar (e.g. p50 / avg), must be <= value to be visible. */
  readonly overlay?: number | null;
  /** Text shown at the end of the bar. */
  readonly text: string;
  /** Highlight the row (e.g. failures). */
  readonly alert?: boolean;
}

export interface BarChartOptions {
  readonly width?: number;
  readonly rowHeight?: number;
  readonly labelWidth?: number;
  readonly valueWidth?: number;
  readonly color?: string;
  readonly overlayColor?: string;
  readonly alertColor?: string;
}

const DEFAULTS: Required<BarChartOptions> = {
  width: 900,
  rowHeight: 26,
  labelWidth: 300,
  valueWidth: 190,
  color: '#60a5fa',
  overlayColor: '#1d4ed8',
  alertColor: '#ef4444',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** Horizontal bar chart; bars are scaled to the largest `value`. */
export function barChart(rows: readonly BarRow[], options: BarChartOptions = {}): string {
  const o = { ...DEFAULTS, ...options };
  if (rows.length === 0) return '';
  const max = Math.max(...rows.map((r) => r.value), 0);
  const barArea = o.width - o.labelWidth - o.valueWidth - 20;
  const height = rows.length * o.rowHeight + 8;
  const scale = (v: number): number => (max > 0 ? Math.max(0, (v / max) * barArea) : 0);
  const body = rows
    .map((row, i) => {
      const y = i * o.rowHeight + 4;
      const barY = y + 5;
      const barH = o.rowHeight - 10;
      const x0 = o.labelWidth + 10;
      const main = row.alert ? o.alertColor : o.color;
      const overlay =
        row.overlay !== undefined && row.overlay !== null && row.overlay > 0
          ? `<rect x="${x0}" y="${barY}" width="${scale(row.overlay).toFixed(1)}" height="${barH}" rx="3" fill="${o.overlayColor}"/>`
          : '';
      return [
        `<text x="${o.labelWidth}" y="${y + o.rowHeight / 2 + 4}" text-anchor="end" class="lbl"><title>${escapeHtml(row.label)}</title>${escapeHtml(truncate(row.label, 44))}</text>`,
        `<rect x="${x0}" y="${barY}" width="${scale(row.value).toFixed(1)}" height="${barH}" rx="3" fill="${main}"/>`,
        overlay,
        `<text x="${x0 + scale(row.value) + 6}" y="${y + o.rowHeight / 2 + 4}" class="val">${escapeHtml(row.text)}</text>`,
      ].join('');
    })
    .join('\n');
  return `<svg class="chart" viewBox="0 0 ${o.width} ${height}" width="100%" role="img">\n${body}\n</svg>`;
}

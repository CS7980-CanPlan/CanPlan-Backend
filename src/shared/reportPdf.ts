import { PageSizes, PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib';
import type { ReportDocument } from './types';

const PAGE_WIDTH = PageSizes.Letter[0];
const PAGE_HEIGHT = PageSizes.Letter[1];
const MARGIN = 46;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const FOOTER_Y = 24;
const BODY_SIZE = 9;
const BODY_LINE_HEIGHT = 12;

const COLORS = {
  ink: rgb(0.09, 0.12, 0.2),
  muted: rgb(0.36, 0.41, 0.5),
  blue: rgb(0.12, 0.35, 0.72),
  line: rgb(0.82, 0.85, 0.9),
  tableHeader: rgb(0.92, 0.95, 1),
  tableAlternate: rgb(0.97, 0.98, 1),
  white: rgb(1, 1, 1),
} satisfies Record<string, RGB>;

interface RenderState {
  readonly document: PDFDocument;
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  page: PDFPage;
  y: number;
}

interface TableColumn {
  readonly heading: string;
  readonly width: number;
  readonly align?: 'left' | 'right';
}

/**
 * Normalize arbitrary user/AI text to the printable ASCII repertoire supported by PDF's
 * built-in Helvetica font. This keeps PDF generation fail-closed and dependency-light until
 * a licensed Unicode font is bundled with the Lambda.
 *
 * Common Western diacritics and punctuation are transliterated. Characters without a safe
 * representation (for example CJK glyphs and emoji) become `?` rather than making pdf-lib
 * throw while encoding the page. A future embedded Unicode font can replace this seam without
 * changing report layout or the download API.
 */
export function normalizeReportPdfText(value: unknown): string {
  const replacements: Record<string, string> = {
    '\u00a0': ' ',
    '\u00ad': '',
    '\u00d0': 'D',
    '\u00d8': 'O',
    '\u00de': 'Th',
    '\u00df': 'ss',
    '\u00e6': 'ae',
    '\u00f0': 'd',
    '\u00f8': 'o',
    '\u00fe': 'th',
    '\u0110': 'D',
    '\u0111': 'd',
    '\u0126': 'H',
    '\u0127': 'h',
    '\u0131': 'i',
    '\u0141': 'L',
    '\u0142': 'l',
    '\u0152': 'OE',
    '\u0153': 'oe',
    '\u2010': '-',
    '\u2011': '-',
    '\u2012': '-',
    '\u2013': '-',
    '\u2014': '-',
    '\u2015': '-',
    '\u2018': "'",
    '\u2019': "'",
    '\u201a': "'",
    '\u201b': "'",
    '\u201c': '"',
    '\u201d': '"',
    '\u201e': '"',
    '\u2022': '*',
    '\u2026': '...',
    '\u2032': "'",
    '\u2033': '"',
    '\u20ac': 'EUR',
    '\u2122': '(TM)',
    '\u2190': '<-',
    '\u2192': '->',
    '\u2212': '-',
    '\u00d7': 'x',
  };

  const source = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n');
  let normalized = '';

  for (const originalCharacter of source) {
    const replacement = replacements[originalCharacter] ?? originalCharacter;
    for (const character of replacement.normalize('NFKD')) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (character === '\n') {
        normalized += '\n';
      } else if (character === '\t') {
        normalized += '    ';
      } else if (codePoint >= 0x20 && codePoint <= 0x7e) {
        normalized += character;
      } else if (/\p{Mark}/u.test(character)) {
        // NFKD emits combining marks after a transliterated base letter.
        continue;
      } else if (
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x206f) ||
        codePoint === 0xfeff
      ) {
        // Drop invisible layout controls, including bidirectional overrides.
        continue;
      } else {
        normalized += '?';
      }
    }
  }

  return normalized;
}

/** Render one immutable saved report document into a self-contained PDF byte array. */
export async function renderReportPdf(report: ReportDocument): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const initialPage = document.addPage(PageSizes.Letter);
  const state: RenderState = {
    document,
    regular,
    bold,
    page: initialPage,
    y: PAGE_HEIGHT - MARGIN,
  };

  const createdAt = parseDate(report.createdAt);
  document.setTitle(normalizeReportPdfText('CanPlan progress report'));
  document.setAuthor('CanPlan');
  document.setCreator('CanPlan report service');
  document.setProducer('CanPlan report service');
  document.setSubject(
    normalizeReportPdfText(
      `Task completion report for ${report.scope.userId}, ${report.dateRange.from} to ${report.dateRange.to}`,
    ),
  );
  if (createdAt) {
    document.setCreationDate(createdAt);
    document.setModificationDate(createdAt);
  }

  drawTitle(state, 'CanPlan progress report');
  drawParagraph(
    state,
    `${report.dateRange.from} to ${report.dateRange.to}`,
    12,
    state.bold,
    COLORS.blue,
    16,
  );
  drawTable(
    state,
    [
      { heading: 'Report detail', width: 140 },
      { heading: 'Value', width: CONTENT_WIDTH - 140 },
    ],
    [
      ['Primary user', report.scope.userId],
      ['Report ID', report.reportId],
      ['Saved by', report.createdBy],
      ['Saved at', formatTimestamp(report.createdAt)],
    ],
  );

  drawSectionTitle(state, 'AI-assisted summary');
  drawParagraph(state, report.narrative || 'No narrative was saved with this report.');

  const { stats } = report;
  drawSectionTitle(state, 'Overview');
  drawTable(
    state,
    [
      { heading: 'Measure', width: 220 },
      { heading: 'Value', width: CONTENT_WIDTH - 220, align: 'right' },
    ],
    [
      ['Attempted task instances', numberText(stats.meta.totalInstances)],
      ['Completed', numberText(stats.completion.completed)],
      ['Completion rate', percentText(stats.completion.completionRate)],
      ['Overall focus ratio', percentText(stats.focus.focusRatio)],
    ],
  );
  drawParagraph(
    state,
    `Measurement basis: ${stats.meta.basis.replace(/-/g, ' ')}. The statistics cover materialized task instances from ${stats.meta.from} through ${stats.meta.to}; they do not expand every virtual schedule occurrence.`,
    8,
    state.regular,
    COLORS.muted,
    11,
  );

  drawSectionTitle(state, 'Completion status');
  drawTable(
    state,
    [
      { heading: 'Status', width: 220 },
      { heading: 'Instances', width: CONTENT_WIDTH - 220, align: 'right' },
    ],
    [
      ['Completed', numberText(stats.completion.completed)],
      ['Skipped', numberText(stats.completion.skipped)],
      ['Cancelled', numberText(stats.completion.cancelled)],
      ['Overdue', numberText(stats.completion.overdue)],
      ['In progress', numberText(stats.completion.inProgress)],
      ['To do', numberText(stats.completion.toDo)],
    ],
  );

  drawSectionTitle(state, 'Weekly completion trend');
  drawTableOrEmpty(
    state,
    [
      { heading: 'Week beginning', width: 165 },
      { heading: 'Completed', width: 105, align: 'right' },
      { heading: 'Attempted', width: 105, align: 'right' },
      { heading: 'Rate', width: CONTENT_WIDTH - 375, align: 'right' },
    ],
    stats.trend.map((row) => [
      row.weekStart,
      numberText(row.completed),
      numberText(row.total),
      percentText(row.completionRate),
    ]),
    'No weekly completion data was recorded.',
  );

  drawSectionTitle(state, 'Completion by category');
  drawTableOrEmpty(
    state,
    [
      { heading: 'Category', width: 222 },
      { heading: 'Completed', width: 94, align: 'right' },
      { heading: 'Attempted', width: 94, align: 'right' },
      { heading: 'Rate', width: CONTENT_WIDTH - 410, align: 'right' },
    ],
    stats.byCategory.map((row) => [
      `${row.categoryName}\n${row.categoryId}`,
      numberText(row.completed),
      numberText(row.total),
      percentText(row.completionRate),
    ]),
    'No category breakdown was recorded.',
  );

  drawSectionTitle(state, 'Completion by task');
  drawTableOrEmpty(
    state,
    [
      { heading: 'Task', width: 222 },
      { heading: 'Completed', width: 94, align: 'right' },
      { heading: 'Attempted', width: 94, align: 'right' },
      { heading: 'Rate', width: CONTENT_WIDTH - 410, align: 'right' },
    ],
    stats.byTask.map((row) => [
      `${row.title}\n${row.taskId}`,
      numberText(row.completed),
      numberText(row.total),
      percentText(row.completionRate),
    ]),
    'No task breakdown was recorded.',
  );

  drawSectionTitle(state, 'Step active time');
  drawParagraph(
    state,
    'Average server-recorded active time for steps that were started; pauses and idle gaps are excluded.',
    8,
    state.regular,
    COLORS.muted,
    11,
  );
  drawTableOrEmpty(
    state,
    [
      { heading: 'Task and step', width: 270 },
      { heading: 'Step', width: 62, align: 'right' },
      { heading: 'Samples', width: 72, align: 'right' },
      { heading: 'Average', width: CONTENT_WIDTH - 404, align: 'right' },
    ],
    stats.stepDwell.map((row) => [
      `${row.title}\n${row.stepText}`,
      numberText(row.stepOrder),
      numberText(row.samples),
      durationText(row.avgSeconds),
    ]),
    'No started-step timing samples were recorded.',
  );

  drawSectionTitle(state, 'Focus by task');
  drawParagraph(
    state,
    `Overall focus ratio: ${percentText(stats.focus.focusRatio)}. Focus compares active task time with elapsed wall-clock time for qualifying completed instances.`,
    8,
    state.regular,
    COLORS.muted,
    11,
  );
  drawTableOrEmpty(
    state,
    [
      { heading: 'Task', width: 280 },
      { heading: 'Samples', width: 92, align: 'right' },
      { heading: 'Average active time', width: CONTENT_WIDTH - 372, align: 'right' },
    ],
    stats.focus.byTask.map((row) => [
      `${row.title}\n${row.taskId}`,
      numberText(row.samples),
      durationText(row.avgActiveSeconds),
    ]),
    'No focus timing samples were recorded.',
  );

  drawSectionTitle(state, 'Skipped tasks');
  drawTableOrEmpty(
    state,
    [
      { heading: 'Task', width: 360 },
      { heading: 'Skipped', width: CONTENT_WIDTH - 360, align: 'right' },
    ],
    stats.skipPatterns.byTask.map((row) => [
      `${row.title}\n${row.taskId}`,
      numberText(row.skipped),
    ]),
    'No skipped tasks were recorded.',
  );

  drawSectionTitle(state, 'Skip time of day');
  drawHourlyTable(state, stats.skipPatterns.byHour, 'No hourly skip pattern was recorded.');

  drawSectionTitle(state, 'Abandoned task instances');
  drawParagraph(
    state,
    'Started instances that were neither completed nor cancelled, with the first incomplete step when one could be determined.',
    8,
    state.regular,
    COLORS.muted,
    11,
  );
  drawTableOrEmpty(
    state,
    [
      { heading: 'Task', width: 210 },
      { heading: 'Stalled at', width: 100 },
      { heading: 'Task instance', width: CONTENT_WIDTH - 310 },
    ],
    stats.abandonment.map((row) => [
      `${row.title}\n${row.taskId}`,
      row.stalledAtStepOrder == null ? 'Unknown step' : `Step ${row.stalledAtStepOrder}`,
      row.instanceId,
    ]),
    'No abandoned task instances were identified.',
  );

  drawSectionTitle(state, 'Completion time of day');
  drawHourlyTable(state, stats.timeOfDay, 'No completion-hour pattern was recorded.');

  drawSectionTitle(state, 'Important interpretation note');
  drawParagraph(
    state,
    'This report summarizes task-app records and an AI-assisted narrative. It is not medical, clinical, or behavioral advice. Completion rates apply only to materialized, attempted task instances.',
    8,
    state.regular,
    COLORS.muted,
    11,
  );

  addPageFooters(state);
  return document.save();
}

function drawTitle(state: RenderState, text: string): void {
  drawParagraph(state, text, 21, state.bold, COLORS.ink, 25);
}

function drawSectionTitle(state: RenderState, text: string): void {
  ensureSpace(state, 38);
  state.y -= 12;
  state.page.drawLine({
    start: { x: MARGIN, y: state.y + 12 },
    end: { x: PAGE_WIDTH - MARGIN, y: state.y + 12 },
    thickness: 0.7,
    color: COLORS.line,
  });
  drawParagraph(state, text, 13, state.bold, COLORS.ink, 17);
}

function drawParagraph(
  state: RenderState,
  value: unknown,
  size = BODY_SIZE,
  font = state.regular,
  color = COLORS.ink,
  lineHeight = BODY_LINE_HEIGHT,
): void {
  const paragraphs = normalizeReportPdfText(value).split('\n');
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    const lines = wrapText(paragraph, font, size, CONTENT_WIDTH);
    for (const line of lines.length ? lines : ['']) {
      ensureSpace(state, lineHeight);
      if (line) {
        state.page.drawText(line, { x: MARGIN, y: state.y, size, font, color });
      }
      state.y -= lineHeight;
    }
    if (paragraphIndex < paragraphs.length - 1) state.y -= lineHeight / 2;
  }
  state.y -= 4;
}

function drawTableOrEmpty(
  state: RenderState,
  columns: TableColumn[],
  rows: string[][],
  emptyMessage: string,
): void {
  if (rows.length === 0) {
    drawParagraph(state, emptyMessage, 8, state.regular, COLORS.muted, 11);
    return;
  }
  drawTable(state, columns, rows);
}

function drawHourlyTable(state: RenderState, values: number[], emptyMessage: string): void {
  const rows = values
    .map((count, hour) => ({ count, hour }))
    .filter(({ count }) => Number.isFinite(count) && count > 0)
    .map(({ count, hour }) => [hourText(hour), numberText(count)]);
  drawTableOrEmpty(
    state,
    [
      { heading: 'Hour', width: 260 },
      { heading: 'Instances', width: CONTENT_WIDTH - 260, align: 'right' },
    ],
    rows,
    emptyMessage,
  );
}

function drawTable(state: RenderState, columns: TableColumn[], rawRows: string[][]): void {
  const padding = 5;
  const fontSize = 8;
  const lineHeight = 10;
  const headerHeight = 22;

  const drawHeader = () => {
    ensureSpace(state, headerHeight + lineHeight);
    state.page.drawRectangle({
      x: MARGIN,
      y: state.y - headerHeight + 5,
      width: CONTENT_WIDTH,
      height: headerHeight,
      color: COLORS.tableHeader,
    });
    let x = MARGIN;
    for (const column of columns) {
      const heading = normalizeReportPdfText(column.heading);
      state.page.drawText(heading, {
        x: alignedX(
          heading,
          x + padding,
          column.width - padding * 2,
          state.bold,
          fontSize,
          column.align,
        ),
        y: state.y - 9,
        size: fontSize,
        font: state.bold,
        color: COLORS.ink,
      });
      x += column.width;
    }
    state.y -= headerHeight;
  };

  drawHeader();
  rawRows.forEach((rawRow, rowIndex) => {
    const cellLines = columns.map((column, index) =>
      wrapMultilineText(rawRow[index] ?? '', state.regular, fontSize, column.width - padding * 2),
    );
    const rowHeight = Math.max(
      lineHeight + padding * 2,
      ...cellLines.map((lines) => lines.length * lineHeight + padding * 2),
    );

    if (state.y - rowHeight < MARGIN + FOOTER_Y) {
      addPage(state);
      drawHeader();
    }

    if (rowIndex % 2 === 1) {
      state.page.drawRectangle({
        x: MARGIN,
        y: state.y - rowHeight + 5,
        width: CONTENT_WIDTH,
        height: rowHeight,
        color: COLORS.tableAlternate,
      });
    }

    let x = MARGIN;
    cellLines.forEach((lines, columnIndex) => {
      const column = columns[columnIndex];
      lines.forEach((line, lineIndex) => {
        state.page.drawText(line, {
          x: alignedX(
            line,
            x + padding,
            column.width - padding * 2,
            state.regular,
            fontSize,
            column.align,
          ),
          y: state.y - padding - fontSize - lineIndex * lineHeight,
          size: fontSize,
          font: state.regular,
          color: COLORS.ink,
        });
      });
      x += column.width;
    });

    state.page.drawLine({
      start: { x: MARGIN, y: state.y - rowHeight + 5 },
      end: { x: PAGE_WIDTH - MARGIN, y: state.y - rowHeight + 5 },
      thickness: 0.35,
      color: COLORS.line,
    });
    state.y -= rowHeight;
  });
  state.y -= 4;
}

function wrapMultilineText(
  value: unknown,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  return normalizeReportPdfText(value)
    .split('\n')
    .flatMap((paragraph) => wrapText(paragraph, font, size, maxWidth));
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    let fragment = '';
    for (const character of word) {
      const candidateFragment = `${fragment}${character}`;
      if (fragment && font.widthOfTextAtSize(candidateFragment, size) > maxWidth) {
        lines.push(fragment);
        fragment = character;
      } else {
        fragment = candidateFragment;
      }
    }
    current = fragment;
  }
  if (current) lines.push(current);
  return lines;
}

function alignedX(
  text: string,
  left: number,
  width: number,
  font: PDFFont,
  size: number,
  align: TableColumn['align'],
): number {
  if (align !== 'right') return left;
  return Math.max(left, left + width - font.widthOfTextAtSize(text, size));
}

function ensureSpace(state: RenderState, height: number): void {
  if (state.y - height < MARGIN + FOOTER_Y) addPage(state);
}

function addPage(state: RenderState): void {
  state.page = state.document.addPage(PageSizes.Letter);
  state.y = PAGE_HEIGHT - MARGIN;
  state.page.drawText('CanPlan progress report', {
    x: MARGIN,
    y: state.y,
    size: 8,
    font: state.bold,
    color: COLORS.muted,
  });
  state.y -= 20;
}

function addPageFooters(state: RenderState): void {
  const pages = state.document.getPages();
  pages.forEach((page, index) => {
    const label = `Page ${index + 1} of ${pages.length}`;
    page.drawText(label, {
      x: PAGE_WIDTH - MARGIN - state.regular.widthOfTextAtSize(label, 8),
      y: FOOTER_Y,
      size: 8,
      font: state.regular,
      color: COLORS.muted,
    });
    page.drawText('Private report - share only with authorized care team members', {
      x: MARGIN,
      y: FOOTER_Y,
      size: 8,
      font: state.regular,
      color: COLORS.muted,
    });
  });
}

function numberText(value: number): string {
  return Number.isFinite(value) ? String(value) : '-';
}

function percentText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Not available';
  return `${Math.round(value * 1000) / 10}%`;
}

function durationText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-';
  const seconds = Math.round(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function hourText(hour: number): string {
  const safeHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0;
  const suffix = safeHour >= 12 ? 'PM' : 'AM';
  const clockHour = safeHour % 12 || 12;
  return `${clockHour}:00 ${suffix}`;
}

function formatTimestamp(value: string): string {
  const parsed = parseDate(value);
  return parsed ? parsed.toISOString() : value;
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

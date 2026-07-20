import type { EmployeeRow } from '../shared/types.js';

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
}

/**
 * Render a directory listing as RFC-4180 CSV — the same rows the list
 * endpoint returns, so the export honours whatever filters are active.
 */
export function directoryCsv(rows: EmployeeRow[]): string {
  const header = [
    'name',
    'email',
    'job_title',
    'department_code',
    'department',
    'manager',
    'phone',
    'location',
    'start_date',
    'status',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.email,
        row.job_title,
        row.department_code,
        row.department_name,
        row.manager_name,
        row.phone,
        row.location,
        row.start_date,
        row.status,
      ]
        .map(escapeCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

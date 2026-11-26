const { exportQuery, MAX_REPORTS } = require('../../domain/reports/reportExport.rules');
const { ValidationError, ConflictError, ForbiddenError } = require('../../domain/errors');
const { printableBarangayReports } = require('./printableBarangayReports');

function createReportExportService({ repository, workbook, audit, now = () => new Date() }) {
  const active = new Set();
  return { async execute(user, input, { printable = false } = {}) {
    if (printable && user.role !== 'barangay') throw new ForbiddenError('Only Barangay officials may prepare this report.');
    const request = exportQuery(user, input);
    if (active.has(user.id) || active.size >= 2) throw new ConflictError('An export is already being prepared. Please retry shortly.');
    active.add(user.id);
    const started = now();
    const details = { role: user.role, scope: request.scope === null ? 'system' : request.scope, filters: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'search')), searchApplied: Boolean(input.search), timestamp: started.toISOString(), ...(printable ? { format: 'print' } : {}) };
    try {
      const data = await repository.load(printable ? { ...request, printable } : request);
      if (data.rows.length > MAX_REPORTS) throw new ValidationError(`Export limit is ${MAX_REPORTS} reports. Narrow the filters or date range.`);
      const scope = request.scope === null ? 'System reports' : `Barangay ${user.barangay || request.scope}`;
      const { page, pageSize, ...filters } = request.query;
      const success = { ...details, outcome: 'success', count: data.rows.length };
      if (printable) {
        const result = printableBarangayReports(data, user.barangay || String(request.scope), filters);
        await audit.writeAudit(user.id, 'report_export', 'report', null, undefined, success);
        return result;
      }
      const buffer = await workbook.generate({ ...data, context: { scope, role: user.role, filters: { ...filters, barangay: request.barangay, ...(request.publication ? { publication: request.publication } : {}) }, now: started } });
      await audit.writeAudit(user.id, 'report_export', 'report', null, undefined, success);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(started);
      const label = user.role === 'admin' ? 'Admin' : `Barangay_${user.barangay || request.scope}`;
      const filename = `NeighborLens_${label.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80)}_Reports_${day}.xlsx`;
      return { buffer, filename, count: data.rows.length };
    } catch (error) {
      await audit.writeAudit(user.id, 'report_export', 'report', null, undefined, { ...details, outcome: 'failure' }).catch(() => {});
      throw error;
    } finally { active.delete(user.id); }
  } };
}
module.exports = { createReportExportService };

const { NotFoundError, ValidationError } = require('../../domain/errors');

function attachmentUrl(reportId, image) {
  return `/api/reports/${reportId}/images/${image.id ?? `legacy-${image.image_order}`}`;
}

function landmarkUrl(reportId) {
  return `/api/reports/${reportId}/images/landmark`;
}

function createReportAttachmentService({ reportService, reportImageRepository, reportStatusHistoryRepository, localEvidence, getImageStorage }) {
  return {
    async read(reportId, imageId, user) {
      if (!/^[1-9]\d*$/.test(String(reportId)) || !Number.isSafeInteger(Number(reportId)) || !/^(?:[1-9]\d*|legacy-[12]|action-[1-9]\d*)$/.test(String(imageId))) {
        throw new ValidationError('Invalid attachment identifier.');
      }
      const report = await reportService.findAuthorizedReport(Number(reportId), user);
      const action = String(imageId).startsWith('action-');
      const rows = action ? (await reportStatusHistoryRepository.proofs(report.id)).map(row => ({ ...row, id: `action-${row.id}` }))
        : await reportImageRepository.findByReportId(report.id);
      const images = rows.length || action ? rows : String(report.image_path || '').split(',').filter(Boolean)
        .map((image_path, index) => ({ id: `legacy-${index + 1}`, image_path }));
      const image = images.find(row => String(row.id) === String(imageId));
      if (!image) throw new NotFoundError('Attachment not found for this report.');
      if (image.image_path.startsWith('supabase:')) return { url: await getImageStorage().getReadUrl(image.image_path) };
      return { path: await localEvidence.resolve(image.image_path) };
    },

    async readLandmark(reportId, user) {
      if (!/^[1-9]\d*$/.test(String(reportId)) || !Number.isSafeInteger(Number(reportId))) {
        throw new ValidationError('Invalid report ID.');
      }
      const report = await reportService.findAuthorizedReport(Number(reportId), user);
      const ref = report.landmark_image_path;
      if (!ref) throw new NotFoundError('This report does not have landmark evidence.');
      if (ref.startsWith('supabase:')) return { url: await getImageStorage().getReadUrl(ref) };
      return { path: await localEvidence.resolve(ref) };
    }
  };
}

module.exports = { attachmentUrl, landmarkUrl, createReportAttachmentService };

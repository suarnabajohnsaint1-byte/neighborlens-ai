const { communityService } = require('../../../composition');
const communityError = require('./communityError');

function safeError(error) {
  return communityError(error, 'The community request could not be completed. Please retry.');
}

function handle(operation, status = 200) {
  return async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.status(status).json(await operation(req));
    } catch (error) { next(safeError(error)); }
  };
}

module.exports = {
  list: handle(req => communityService.list(req.user, req.query)),
  eligibleReports: handle(req => communityService.eligibleReports(req.user)),
  get: handle(req => communityService.get(req.user, req.params.id)),
  publish: handle(req => communityService.publish(req.user, req.body, req.files), 201),
  edit: handle(req => communityService.update(req.user, req.params.id, req.body)),
  remove: handle(req => communityService.update(req.user, req.params.id, {}, true)),
  react: handle(req => communityService.react(req.user, req.params.id, req.body)),
  comments: handle(req => communityService.comments(req.user, req.params.id, req.query)),
  comment: handle(req => communityService.comment(req.user, req.params.id, req.body)),
  editComment: handle(req => communityService.comment(req.user, req.params.id, req.body, req.params.comment)),
  deleteComment: handle(req => communityService.comment(req.user, req.params.id, {}, req.params.comment, true)),
  reactComment: handle(req => communityService.reactComment(req.user, req.params.id, req.params.comment, req.body)),
  report: handle(req => communityService.publicReport(req.user, req.params.id)),
  identity: handle(req => communityService.identity(req.user, req.params.id)),
  async media(req, res, next) {
    try {
      const bytes = await communityService.image(req.user, req.params.id, req.params.image);
      res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff' });
      res.send(bytes);
    } catch (error) { next(safeError(error)); }
  }
};

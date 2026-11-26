const { communityPublicationService: service } = require('../../../composition');
const communityError = require('./communityError');
const handle = action => async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store').json(await action(req)); }
  catch (error) { next(communityError(error, 'Publication operation failed. Please retry.')); }
};
module.exports = {
  queue: handle(req => service.queue(req.user)),
  detail: handle(req => service.detail(req.user, req.params.id)),
  assign: handle(req => service.assign(req.user, req.params.id)),
  resolveJurisdiction: handle(req => service.resolveJurisdiction(req.user, req.params.id, req.body)),
  decide: handle(req => service.decide(req.user, req.params.id, req.body)),
  owned: handle(req => service.owned(req.user)),
  async image(req, res, next) {
    try { res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff' }).send(await service.image(req.user, req.params.id, req.params.order)); }
    catch (error) { next(communityError(error, 'Publication photo unavailable.')); }
  }
};

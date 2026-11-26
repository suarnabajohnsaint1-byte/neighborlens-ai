const assert = require('node:assert/strict');

async function approvePublication(base, reportId, admin, citizen) {
  const path = `${base}/api/admin/community-publications/${reportId}`;
  const headers = { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' };
  const detail = await fetch(path, { headers });
  assert.equal(detail.status, 200);
  const { publication } = await detail.json();
  const response = await fetch(`${path}/decision`, { method: 'POST', headers, body: JSON.stringify({ state: 'approved', version: publication.version }) });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  const post = await fetch(`${base}/api/community/posts/${data.publication.postId}`, { headers: { Authorization: `Bearer ${citizen.token}` } });
  assert.equal(post.status, 200);
  return post.json();
}
module.exports = { approvePublication };

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const window = {
  ReportPresentation: {
    escape: value => value.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character])
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/community/communityCards.js'), 'utf8'), { window });

for (const status of ['pending', 'ongoing', 'resolved', 'rejected']) {
  test(`citizen community ${status} card retains metadata without a View report control`, () => {
    const post = {
      id: 1,
      title: 'Road damage',
      body: 'Please take care when passing.',
      barangay: 'Villamonte',
      createdAt: '2026-10-19T00:00:00Z',
      linkedReport: { category: 'Road Damage', barangay: 'Villamonte', status },
      media: [{ url: '/api/community/posts/1/media/1' }],
      reactions: { total: 2 },
      commentCount: 3
    };
    for (const current of [post, { ...post, reactions: { total: 3 }, commentCount: 4 }]) {
      const html = window.CommunityCards.render(current);
      assert.doesNotMatch(html, /View report|data-action="report"/i);
      assert.match(html, /Road Damage &middot; Villamonte/);
      assert.match(html, new RegExp(`data-status="${status}"`));
      assert.match(html, /data-evidence-url="\/api\/community\/posts\/1\/media\/1"/);
      assert.match(html, /data-action="react"/);
      assert.match(html, /data-action="comments"/);
    }
  });
}

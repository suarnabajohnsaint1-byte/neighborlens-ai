module.exports = async function () {
  const response = await fetch('http://127.0.0.1:4318/__phase1b_shutdown', { method: 'POST' });
  if (!response.ok) throw new Error('Isolated browser server cleanup failed.');
  await response.json();
};

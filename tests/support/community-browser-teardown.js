module.exports = async function (config) {
  const response = await fetch(new URL('/__phase1b_shutdown', config.projects[0].use.baseURL), { method: 'POST' });
  if (!response.ok) throw new Error('Isolated Community regression server cleanup failed.');
  await response.json();
};

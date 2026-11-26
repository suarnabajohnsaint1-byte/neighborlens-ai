async function fixedBrowserLocation(page, context, coordinates, { simulatedWatch = false } = {}) {
  await context.setGeolocation(coordinates);
  await page.addInitScript(({ coords, simulatedWatch }) => {
    // Emulate a fresh native fix for each request, including final submission.
    // Playwright's cached mock sample can otherwise time out with maximumAge 0.
    const saved = sessionStorage.getItem('neighborlens_fixture_gps');
    window.fixtureGpsCoordinates = saved ? JSON.parse(saved) : coords;
    navigator.geolocation.getCurrentPosition = success => queueMicrotask(() => {
      success({ coords: window.fixtureGpsCoordinates, timestamp: Date.now() });
    });
    if (simulatedWatch) {
      let watchId = 0;
      let lastTimestamp = 0;
      const watchers = new Map();
      const observation = () => ({ coords: window.fixtureGpsCoordinates, timestamp: lastTimestamp = Math.max(Date.now(), lastTimestamp + 1) });
      navigator.geolocation.watchPosition = success => {
        const id = ++watchId;
        watchers.set(id, success);
        queueMicrotask(() => watchers.get(id)?.(observation()));
        return id;
      };
      navigator.geolocation.clearWatch = id => watchers.delete(id);
      window.deliverFixtureGps = () => { for (const success of watchers.values()) success(observation()); };
    }
  }, { coords: coordinates, simulatedWatch });
}

async function moveBrowserLocation(page, context, coordinates) {
  const delivered = await page.evaluate(coords => {
    sessionStorage.setItem('neighborlens_fixture_gps', JSON.stringify(coords));
    window.fixtureGpsCoordinates = coords;
    if (!window.deliverFixtureGps) return false;
    window.deliverFixtureGps();
    return true;
  }, coordinates);
  if (!delivered) await context.setGeolocation(coordinates);
}

module.exports = { fixedBrowserLocation, moveBrowserLocation };

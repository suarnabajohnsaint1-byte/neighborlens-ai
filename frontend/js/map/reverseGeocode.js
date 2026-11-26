// Standalone helper: js/map/reverseGeocode.js
// Additive-only utility to reverse geocode lat/lng into a readable address.
// Safe to call without editing the existing app flow.
//
// Usage:
//   <script src="js/map/reverseGeocode.js"></script>
//   const result = await window.ReverseGeocode.lookup({
//     latitude: 14.5995,
//     longitude: 120.9842,
//     provider: 'nominatim' // or 'google' if you provide a key
//   });
//   console.log(result);

(function () {
  'use strict';

  function extractPurokFromPayload(address = {}, displayName = '') {
    if (!address && !displayName) return null;

    // 1. Explicit address.purok, address.sitio, or address['addr:purok']
    if (typeof address?.purok === 'string' && address.purok.trim()) {
      const val = address.purok.trim();
      return /^(?:purok|prk\.?|puk\.?|sitio)\b/i.test(val) ? val : `Purok ${val}`;
    }
    if (typeof address?.sitio === 'string' && address.sitio.trim()) {
      const val = address.sitio.trim();
      return /^sitio\b/i.test(val) ? val : `Sitio ${val}`;
    }
    if (typeof address?.['addr:purok'] === 'string' && address['addr:purok'].trim()) {
      const val = address['addr:purok'].trim();
      return /^(?:purok|prk\.?|puk\.?)\b/i.test(val) ? val : `Purok ${val}`;
    }

    // 2. Textual pattern check across candidates only with explicit Purok/Sitio keyword
    // Do NOT blindly treat road/suburb/village as purok unless it matches an explicit pattern.
    const candidates = [
      address?.neighbourhood,
      address?.suburb,
      address?.quarter,
      address?.village,
      address?.hamlet,
      address?.road,
      address?.residential,
      address?.amenity,
      address?.industrial,
      displayName
    ].filter(c => typeof c === 'string' && c.trim().length > 0);

    const purokPattern = /\b(?:purok|prk\.?|puk\.?|sitio)\s+#?\s*([A-Za-z0-9\-_]+(?:\s+[A-Za-z0-9\-_]+){0,3})\b/i;

    for (const candidate of candidates) {
      const match = candidate.match(purokPattern);
      if (match) {
        return match[0].trim().replace(/[,;]+$/, '');
      }
    }

    return null;
  }

  function extractPurokFromGoogle(result) {
    if (!result) return null;
    const components = result.address_components || [];
    const purokPattern = /\b(?:purok|prk\.?|puk\.?|sitio)\s+#?\s*([A-Za-z0-9\-_]+(?:\s+[A-Za-z0-9\-_]+){0,3})\b/i;

    for (const c of components) {
      if (c.long_name && purokPattern.test(c.long_name)) {
        const match = c.long_name.match(purokPattern);
        return match[0].trim().replace(/[,;]+$/, '');
      }
    }

    if (result.formatted_address && purokPattern.test(result.formatted_address)) {
      const match = result.formatted_address.match(purokPattern);
      return match[0].trim().replace(/[,;]+$/, '');
    }

    return null;
  }

  function labelFor(payload) {
    if (typeof payload?.display_name === 'string' && payload.display_name.trim()) return payload.display_name.trim();
    const a = payload?.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const parts = [street, a.neighbourhood || a.suburb, a.village || a.hamlet,
      a.city || a.town || a.municipality, a.county, a.state || a.province, a.postcode, a.country];
    return [...new Set(parts.filter(part => typeof part === 'string' && part.trim()).map(part => part.trim()))].join(', ');
  }

  async function lookupNearbyAddress(lat, lng, language, signal) {
    const url = new URL('https://photon.komoot.io/reverse');
    url.search = new URLSearchParams({ lat, lon: lng, lang: language, limit: 1 });
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 5000);
    const response = await fetch(url, { signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
    if (!response.ok) return null;
    const { features } = await response.json();
    const place = features?.[0]?.properties;
    if (!place) return null;
    return { address: {
      house_number: place.housenumber,
      road: place.street,
      neighbourhood: place.locality || place.district,
      city: place.city,
      county: place.county,
      province: place.state,
      postcode: place.postcode,
      country: place.country
    } };
  }

  async function lookup({
    latitude,
    longitude,
    provider = 'nominatim',
    apiKey = '',
    language = 'en',
    signal
  } = {}) {
    try {
      if (latitude == null || longitude == null || Number.isNaN(Number(latitude)) || Number.isNaN(Number(longitude))) {
        return {
          ok: false,
          formattedAddress: '',
          displayName: '',
          country: '',
          city: '',
          barangay: '',
          municipality: '',
          province: '',
          purok: null,
          error: 'Invalid latitude or longitude.'
        };
      }

      const lat = Number(latitude);
      const lng = Number(longitude);

      if (provider === 'google') {
        if (!apiKey) {
          return {
            ok: false,
            formattedAddress: '',
            displayName: '',
            country: '',
            city: '',
            barangay: '',
            municipality: '',
            province: '',
            purok: null,
            error: 'Google Maps API key is required for google provider.'
          };
        }

        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${encodeURIComponent(apiKey)}&language=${encodeURIComponent(language)}`;
        const response = await fetch(url, { signal });
        const payload = await response.json();

        if (!response.ok || payload.status !== 'OK' || !Array.isArray(payload.results) || !payload.results.length) {
          return {
            ok: false,
            formattedAddress: '',
            displayName: '',
            country: '',
            city: '',
            barangay: '',
            municipality: '',
            province: '',
            purok: null,
            error: payload?.error_message || 'Google reverse geocoding failed.'
          };
        }

        const result = payload.results[0];
        const components = result.address_components || [];
        const getComp = (type) => components.find(c => c.types.includes(type))?.long_name || '';

        const rawBarangay = getComp('neighborhood') || getComp('sublocality_level_1') || getComp('sublocality') || '';
        const normalizedBarangay = typeof window !== 'undefined' && typeof window.normalizeToOfficialBarangay === 'function'
          ? window.normalizeToOfficialBarangay(rawBarangay) || window.normalizeToOfficialBarangay(result.formatted_address)
          : '';
        const purok = extractPurokFromGoogle(result);

        const isInsideBacolod = Boolean(normalizedBarangay);

        const city = getComp('locality') || getComp('administrative_area_level_2') || (isInsideBacolod ? 'Bacolod City' : '');
        const municipality = getComp('administrative_area_level_2') || (isInsideBacolod ? 'Bacolod City' : '');
        const province = getComp('administrative_area_level_1') || (isInsideBacolod ? 'Negros Occidental' : '');
        const country = getComp('country') || (isInsideBacolod ? 'Philippines' : '');

        return {
          ok: true,
          formattedAddress: result.formatted_address || '',
          displayName: result.formatted_address || '',
          country,
          city,
          barangay: normalizedBarangay || '',
          municipality,
          province,
          purok,
          raw: result
        };
      }

      // 1. Backend proxy (CORS-safe, server adds User-Agent)
      let payload = null;
      const backendUrl = typeof window !== 'undefined' && typeof window.neighborLensApiUrl === 'function'
        ? window.neighborLensApiUrl(`/api/config/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`)
        : (typeof window !== 'undefined' && window.NEIGHBORLENS_API_BASE_URL
          ? `${window.NEIGHBORLENS_API_BASE_URL}/api/config/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`
          : `http://${(typeof window !== 'undefined' && window.location?.hostname) || '127.0.0.1'}:3000/api/config/reverse-geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`);

      try {
        const proxyResp = await fetch(backendUrl, { method: 'GET', signal });
        if (proxyResp.ok) {
          const proxyData = await proxyResp.json();
          if (proxyData?.ok && proxyData.data) {
            payload = proxyData.data;
          } else if (proxyData?.address || proxyData?.display_name) {
            payload = proxyData;
          }
        }
      } catch (_) {
        // proxy unavailable
      }

      // Use a different provider when the primary lookup is unavailable.
      if (!signal?.aborted && !labelFor(payload)) {
        try {
          payload = await lookupNearbyAddress(lat, lng, language, signal);
        } catch (_) {
          // CORS or offline
        }
      }

      const displayName = labelFor(payload);
      if (displayName) {
        const address = payload?.address || {};
        const city = address.city || address.town || address.village || address.municipality || '';
        const rawBarangay = address.neighbourhood || address.suburb || address.quarter || address.village || address.hamlet || address.city_district || address.borough || '';
        const barangay = typeof window !== 'undefined' && typeof window.normalizeToOfficialBarangay === 'function'
          ? window.normalizeToOfficialBarangay(rawBarangay) || window.normalizeToOfficialBarangay(displayName) || ''
          : '';
        const municipality = address.city_district || address.municipality || address.county || '';
        const province = address.state || address.province || address.region || '';
        const country = address.country || '';
        const purok = extractPurokFromPayload(address, displayName);

        return {
          ok: true,
          formattedAddress: displayName,
          displayName,
          country,
          city,
          barangay,
          municipality,
          province,
          purok,
          raw: payload
        };
      }

    } catch {
      // Address providers are optional. GPS remains available to the caller.
    }
    const lat = Number(latitude);
    const lng = Number(longitude);
    const coordinates = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '';
    return {
      ok: true, formattedAddress: coordinates, displayName: coordinates,
      country: '', city: '', barangay: '', municipality: '', province: '', purok: null, offlineFallback: true
    };
  }

  const ReverseGeocode = {
    lookup,
    extractPurokFromPayload
  };

  if (typeof window !== 'undefined') {
    window.ReverseGeocode = ReverseGeocode;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReverseGeocode;
  }
})();

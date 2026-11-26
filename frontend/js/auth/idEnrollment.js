(function () {
  "use strict";

  async function freshPosition() {
    const { lat, lng, accuracy, timestamp } = await window.getCurrentLocation({ requireAccurate: true });
    return { latitude: lat, longitude: lng, accuracy, timestamp };
  }

  function cameraFailureMessage(error) {
    if (!window.isSecureContext) return "Open this page over HTTPS to use the camera.";
    switch (error?.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Allow camera access for this site, then select Scan ID again.";
      case "NotReadableError":
      case "AbortError":
        return "Close other apps using the camera, then select Scan ID again.";
      case "OverconstrainedError":
        return "This camera could not be selected. Select Scan ID to retry with the default camera.";
      default:
        return "No usable camera could be opened. Connect a camera or open this page on a phone.";
    }
  }

  function sourceRect(video, visible, target) {
    const scale = Math.max(visible.width / video.videoWidth, visible.height / video.videoHeight);
    return [
      (target.left - visible.left) / scale + (video.videoWidth - visible.width / scale) / 2,
      (target.top - visible.top) / scale + (video.videoHeight - visible.height / scale) / 2,
      target.width / scale,
      target.height / scale,
    ];
  }

  function inspectCardFrame(video, guide, canvas) {
    if (video.readyState < 2 || !video.videoWidth || !video.clientWidth || !guide.clientWidth)
      return { aligned: false, hint: "Align the ID inside the outline." };
    const visible = video.getBoundingClientRect();
    return inspectCardImage(video, sourceRect(video, visible, visible), visible, guide.getBoundingClientRect(), canvas);
  }

  function inspectCardImage(image, source, visible, box, canvas) {
    const width = 160;
    const height = 120;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, ...source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const left = (box.left - visible.left) * width / visible.width;
    const right = (box.right - visible.left) * width / visible.width;
    const top = (box.top - visible.top) * height / visible.height;
    const bottom = (box.bottom - visible.top) * height / visible.height;
    function contrast(x, y, vertical) {
      const offset = vertical ? 1 : width;
      const index = y * width + x;
      const before = (index - offset * 2) * 4;
      const after = (index + offset * 2) * 4;
      return (Math.abs(pixels[before] - pixels[after]) +
        Math.abs(pixels[before + 1] - pixels[after + 1]) +
        Math.abs(pixels[before + 2] - pixels[after + 2])) / 3;
    }
    function findEdge(expected, inward, spanStart, spanEnd, vertical, start, end, samples = 12) {
      let strongest = 0;
      let first = null;
      let last = null;
      for (let delta = start; delta <= end; delta++) {
        const axis = Math.round(expected + inward * delta);
        if (axis < 2 || axis >= (vertical ? width : height) - 2) continue;
        let score = 0;
        let supported = 0;
        for (let sample = 0; sample < samples; sample++) {
          const along = Math.round(spanStart + (spanEnd - spanStart) * (sample + 0.5) / samples);
          const difference = vertical ? contrast(axis, along, true) : contrast(along, axis, false);
          if (difference >= 23) supported++;
          score += Math.min(90, difference);
        }
        if (supported * 3 < samples * 2) continue;
        if (score > strongest) {
          strongest = score;
          first = last = delta;
        } else if (score === strongest && delta === last + 1) {
          last = delta;
        }
      }
      // A sharp edge can give several equal adjacent samples. Use the center of that edge.
      return first === null ? null : (Math.round(expected) - expected) * inward + (first + last) / 2;
    }
    const middleX = [left + (right - left) * 0.25, right - (right - left) * 0.25];
    const middleY = [top + (bottom - top) * 0.25, bottom - (bottom - top) * 0.25];
    const horizontalDepth = Math.floor((right - left) * 0.2);
    const verticalDepth = Math.floor((bottom - top) * 0.2);
    function cardEdge(expected, inward, span, vertical, depth) {
      return findEdge(expected, inward, ...span, vertical, -9, depth) ??
        findEdge(expected, inward, ...span, vertical, depth + 1, Math.floor(depth * 1.5));
    }
    function traceEdge(expected, inward, [start, end], vertical, depth, seed) {
      // Three separate sections distinguish a sloping edge from a single strong line in the text.
      const segment = (end - start) / 3;
      const reach = Math.floor(depth * 1.5);
      const min = seed === null ? -9 : Math.max(-9, Math.floor(seed) - 8);
      const max = seed === null ? reach : Math.min(reach, Math.ceil(seed) + 8);
      const offsets = [0, 1, 2].map(index =>
        findEdge(expected, inward, start + segment * index, start + segment * (index + 1),
          vertical, min, max, 6));
      if (offsets.some(offset => offset === null)) return null;
      const [first, middle, last] = offsets;
      if (Math.abs(middle - (first + last) / 2) > 2) return null;
      const slope = inward * (last - first) / (2 * segment);
      const intercept = expected + inward * (first + middle + last) / 3 - slope * (start + end) / 2;
      return { slope, intercept };
    }
    function corner(side, horizontal) {
      const y = (horizontal.slope * side.intercept + horizontal.intercept) /
        (1 - side.slope * horizontal.slope);
      return { x: side.slope * y + side.intercept, y };
    }
    const edges = [
      cardEdge(left, 1, middleY, true, horizontalDepth),
      cardEdge(right, -1, middleY, true, horizontalDepth),
      cardEdge(top, 1, middleX, false, verticalDepth),
      cardEdge(bottom, -1, middleX, false, verticalDepth),
    ];
    const enclosed = edges.every(edge => edge !== null && edge >= 1);
    const aligned = enclosed &&
      edges[0] <= horizontalDepth && edges[1] <= horizontalDepth &&
      edges[2] <= verticalDepth && edges[3] <= verticalDepth;

    const lines = [
      traceEdge(left, 1, middleY, true, horizontalDepth, edges[0]),
      traceEdge(right, -1, middleY, true, horizontalDepth, edges[1]),
      traceEdge(top, 1, middleX, false, verticalDepth, edges[2]),
      traceEdge(bottom, -1, middleX, false, verticalDepth, edges[3]),
    ];
    if (lines.every(Boolean)) {
      const [leftEdge, rightEdge, topEdge, bottomEdge] = lines;
      const tl = corner(leftEdge, topEdge);
      const tr = corner(rightEdge, topEdge);
      const bl = corner(leftEdge, bottomEdge);
      const br = corner(rightEdge, bottomEdge);
      const topWidth = tr.x - tl.x;
      const bottomWidth = br.x - bl.x;
      const leftHeight = bl.y - tl.y;
      const rightHeight = br.y - tr.y;
      const boxWidth = right - left;
      const boxHeight = bottom - top;
      const plausible = Math.min(topWidth, bottomWidth) >= boxWidth * 0.5 &&
        Math.max(topWidth, bottomWidth) <= boxWidth * 1.2 &&
        Math.min(leftHeight, rightHeight) >= boxHeight * 0.5 &&
        Math.max(leftHeight, rightHeight) <= boxHeight * 1.2;
      if (plausible) {
        const pixelAspect = (visible.height / height) / (visible.width / width);
        const slope = (topEdge.slope + bottomEdge.slope) / 2;
        if (topEdge.slope * bottomEdge.slope > 0 && Math.abs(slope * pixelAspect) > 0.16)
          return { aligned: false, hint: slope > 0 ? "Rotate the ID slightly left." : "Rotate the ID slightly right." };
        // With the ID facing the camera, the opposite edges should have similar projected lengths.
        if (Math.abs(topWidth - bottomWidth) > boxWidth * 0.11)
          return { aligned: false, hint: topWidth < bottomWidth
            ? "Tilt the top edge slightly toward the camera." : "Tilt the top edge slightly away from the camera." };
        if (Math.abs(leftHeight - rightHeight) > boxHeight * 0.11)
          return { aligned: false, hint: leftHeight < rightHeight
            ? "Tilt the left edge slightly toward the camera." : "Tilt the right edge slightly toward the camera." };
        if ([tl, tr, bl, br].some(({ x, y }) =>
          x < left - 1 || x > right + 1 || y < top - 1 || y > bottom + 1))
          return { aligned: false, hint: "Keep all four corners inside the outline." };
      }
    }

    if (!enclosed) return { aligned, hint: "Align the ID inside the outline." };
    const pose = edges.map((edge, index) => edge / (index < 2 ? right - left : bottom - top));
    if (!aligned || edges[0] + edges[1] > (right - left) * 0.29 ||
      edges[2] + edges[3] > (bottom - top) * 0.29)
      return { aligned, pose, hint: "Move closer. Keep the ID inside the outline." };

    // Focus feedback is advisory. Card wear and low-contrast printing may produce weak texture.
    let detailedSamples = 0;
    const [xStart, xEnd] = middleX.map(Math.round);
    const [yStart, yEnd] = middleY.map(Math.round);
    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = xStart; x < xEnd; x += 2) {
        if (contrast(x, y, true) >= 16 || contrast(x, y, false) >= 16) detailedSamples++;
        if (detailedSamples >= 10) return { aligned, pose, hint: "Card aligned. Capture is ready." };
      }
    }
    return { aligned, pose, hint: "Image looks soft. Hold steady." };
  }

  function steadyCard(previous, current) {
    return Boolean(previous?.aligned && current.aligned &&
      current.pose.every((offset, index) => Math.abs(offset - previous.pose[index]) <= 0.055));
  }

  async function cameraFrame(video, guide, scratch, previous, onSnapshot) {
    const visible = video.getBoundingClientRect();
    const box = guide.getBoundingClientRect();
    const source = sourceRect(video, visible, visible);
    const card = sourceRect(video, visible, box);
    const longEdge = Math.max(card[2], card[3]);
    const sourceX = Math.max(0, Math.floor(source[0]));
    const sourceY = Math.max(0, Math.floor(source[1]));
    const snapshot = document.createElement("canvas");
    const canvas = document.createElement("canvas");
    snapshot.width = Math.min(video.videoWidth, Math.ceil(source[0] + source[2])) - sourceX;
    snapshot.height = Math.min(video.videoHeight, Math.ceil(source[1] + source[3])) - sourceY;
    try {
      // Validate exactly the frame chosen at the tap, then crop that same frame for OCR and screening.
      // Copy at native resolution so the JPEG crop only resamples the source pixels once.
      snapshot.getContext("2d").drawImage(video, sourceX, sourceY, snapshot.width, snapshot.height,
        0, 0, snapshot.width, snapshot.height);
      const inspected = inspectCardImage(snapshot,
        [source[0] - sourceX, source[1] - sourceY, source[2], source[3]], visible, box, scratch);
      if (!inspected.aligned) return { hint: inspected.hint };
      if (!steadyCard(previous, inspected)) return { hint: "Hold the ID steady." };
      const outputScale = Math.max(1000, Math.min(1600, longEdge)) / longEdge;
      canvas.width = Math.floor(card[2] * outputScale);
      canvas.height = Math.floor(card[3] * outputScale);
      canvas.getContext("2d").drawImage(snapshot,
        card[0] - sourceX, card[1] - sourceY, card[2], card[3],
        0, 0, canvas.width, canvas.height);
      onSnapshot?.();
      const frame = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.94));
      if (!frame) throw new Error("The camera capture failed. Try again.");
      return { frame };
    } finally {
      snapshot.width = snapshot.height = 1;
      canvas.width = canvas.height = 1;
    }
  }

  window.IdEnrollment = { freshPosition, cameraFailureMessage, cameraFrame, inspectCardFrame, steadyCard };
})();

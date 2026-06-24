const canvas = document.querySelector("#glassCanvas");
const ctx = canvas.getContext("2d");
const canvasFrame = document.querySelector(".canvas-frame");
const presetGrid = document.querySelector("#presetGrid");
const loadingState = document.querySelector("#loadingState");
const fileInput = document.querySelector("#fileInput");
const videoSource = document.querySelector("#videoSource");
const assetPrev = document.querySelector("#assetPrev");
const assetNext = document.querySelector("#assetNext");
const assetPageValue = document.querySelector("#assetPageValue");
const sceneCanvas = document.createElement("canvas");
const sceneCtx = sceneCanvas.getContext("2d");

const controls = {
  sourceScale: document.querySelector("#sourceScale"),
  sourceX: document.querySelector("#sourceX"),
  sourceY: document.querySelector("#sourceY"),
  gridCount: document.querySelector("#gridCount"),
  distortion: document.querySelector("#distortion"),
  magnify: document.querySelector("#magnify"),
  softness: document.querySelector("#softness"),
  highlight: document.querySelector("#highlight"),
};

const outputs = {
  sourceScale: document.querySelector("#sourceScaleValue"),
  sourceX: document.querySelector("#sourceXValue"),
  sourceY: document.querySelector("#sourceYValue"),
  gridCount: document.querySelector("#gridCountValue"),
  distortion: document.querySelector("#distortionValue"),
  magnify: document.querySelector("#magnifyValue"),
  softness: document.querySelector("#softnessValue"),
  highlight: document.querySelector("#highlightValue"),
};

const presets = [
  { name: "示例猫", type: "image", src: "./assets/preset-cat.jpg" },
  { name: "示例狗", type: "image", src: "./assets/preset-dog.jpg" },
];

const state = {
  source: null,
  sourceType: "image",
  rawSource: null,
  rawSourceType: "image",
  matteSource: null,
  matteEnabled: false,
  matteToken: 0,
  activePreset: 0,
  seed: Math.random() * 1000,
  raf: null,
  drawTimer: null,
  forceRender: false,
  lastFrameTime: 0,
  objectUrl: null,
  canvasKey: "",
  tileCacheKey: "",
  tileCache: [],
  drag: null,
  assetPage: 0,
  motion: "still",
  exporting: false,
};

const assetPageSize = 5;
const glassRotation = 0.035;
const mediaLimits = {
  image: {
    label: "图片",
    maxBytes: 16 * 1024 * 1024,
    maxPixels: 12000000,
    maxSide: 6000,
  },
  gif: {
    label: "GIF",
    maxBytes: 12 * 1024 * 1024,
    maxPixels: 1600000,
    maxSide: 1280,
  },
  video: {
    label: "视频",
    maxBytes: 40 * 1024 * 1024,
    maxPixels: 2100000,
    maxSide: 1920,
    maxDuration: 20,
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isAnimatedSource() {
  return state.sourceType === "video" || state.sourceType === "gif";
}

function shouldRunContinuousRender() {
  return isAnimatedSource() || state.motion !== "still";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function showMediaError(message) {
  loadingState.textContent = message;
  loadingState.classList.remove("hidden");
}

function isGifFile(file) {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

function getFileKind(file) {
  if (file.type.startsWith("video/")) return "video";
  if (isGifFile(file)) return "gif";
  if (file.type.startsWith("image/")) return "image";
  return "unsupported";
}

function validateFileSize(file, kind) {
  const limit = mediaLimits[kind];
  if (!limit) return "只支持图片、GIF 或视频素材";
  if (file.size <= limit.maxBytes) return "";
  return `${limit.label}太大了，请控制在 ${formatBytes(limit.maxBytes)} 内`;
}

function validateImageDimensions(image, kind) {
  const limit = mediaLimits[kind];
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  if (!limit || !width || !height) return "这张素材暂时无法读取";
  if (width * height > limit.maxPixels || Math.max(width, height) > limit.maxSide) {
    return `${limit.label}尺寸太大，请控制在 ${limit.maxSide}px 最长边以内`;
  }
  return "";
}

function validateVideoMetadata(video) {
  const limit = mediaLimits.video;
  const width = video.videoWidth || 0;
  const height = video.videoHeight || 0;
  const duration = video.duration;
  if (!width || !height || !Number.isFinite(duration)) return "这个视频暂时无法读取";
  if (duration > limit.maxDuration) return `视频太长了，请控制在 ${limit.maxDuration} 秒内`;
  if (width * height > limit.maxPixels || Math.max(width, height) > limit.maxSide) {
    return "视频分辨率太高，请控制在 1080p 以内";
  }
  return "";
}

function rejectObjectUrl(src, message) {
  if (state.objectUrl === src) {
    URL.revokeObjectURL(src);
    state.objectUrl = null;
  }
  showMediaError(message);
}

function colorDistance(data, index, color) {
  const dr = data[index] - color.r;
  const dg = data[index + 1] - color.g;
  const db = data[index + 2] - color.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function estimateBorderBackground(data, width, height) {
  const samples = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
  const addSample = (x, y) => {
    const index = (y * width + x) * 4;
    samples.push({
      r: data[index],
      g: data[index + 1],
      b: data[index + 2],
    });
  };

  for (let x = 0; x < width; x += step) {
    addSample(x, 0);
    addSample(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    addSample(0, y);
    addSample(width - 1, y);
  }

  const color = samples.reduce(
    (result, sample) => ({
      r: result.r + sample.r,
      g: result.g + sample.g,
      b: result.b + sample.b,
    }),
    { r: 0, g: 0, b: 0 },
  );
  color.r /= samples.length;
  color.g /= samples.length;
  color.b /= samples.length;

  const variance = samples.reduce((total, sample) => {
    const dr = sample.r - color.r;
    const dg = sample.g - color.g;
    const db = sample.b - color.b;
    return total + Math.sqrt(dr * dr + dg * dg + db * db);
  }, 0) / samples.length;

  return {
    color,
    threshold: clamp(variance * 1.8 + 42, 46, 112),
  };
}

function createSubjectMatte(source) {
  const { width: sourceWidth, height: sourceHeight } = getSourceSize(source);
  const maxSide = 820;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const matteCanvas = document.createElement("canvas");
  matteCanvas.width = width;
  matteCanvas.height = height;

  const matteCtx = matteCanvas.getContext("2d", { willReadFrequently: true });
  matteCtx.imageSmoothingEnabled = true;
  matteCtx.imageSmoothingQuality = "high";
  matteCtx.drawImage(source, 0, 0, width, height);

  const imageData = matteCtx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const { color: backgroundColor } = estimateBorderBackground(data, width, height);
  const pixelCount = width * height;
  const backgroundSamples = [];
  const foregroundSamples = [];
  const sampleStep = Math.max(2, Math.floor(Math.min(width, height) / 56));
  const addSample = (samples, x, y) => {
    const index = (y * width + x) * 4;
    samples.push([data[index], data[index + 1], data[index + 2]]);
  };

  for (let x = 0; x < width; x += sampleStep) {
    addSample(backgroundSamples, x, 0);
    addSample(backgroundSamples, x, height - 1);
  }
  for (let y = 0; y < height; y += sampleStep) {
    addSample(backgroundSamples, 0, y);
    addSample(backgroundSamples, width - 1, y);
  }

  const localContrast = (x, y) => {
    const index = (y * width + x) * 4;
    const right = (y * width + Math.min(width - 1, x + 2)) * 4;
    const down = (Math.min(height - 1, y + 2) * width + x) * 4;
    return (
      Math.abs(data[index] - data[right]) +
      Math.abs(data[index + 1] - data[right + 1]) +
      Math.abs(data[index + 2] - data[right + 2]) +
      Math.abs(data[index] - data[down]) +
      Math.abs(data[index + 1] - data[down + 1]) +
      Math.abs(data[index + 2] - data[down + 2])
    ) / 2;
  };

  for (let y = Math.round(height * 0.16); y < height * 0.88; y += sampleStep) {
    for (let x = Math.round(width * 0.18); x < width * 0.82; x += sampleStep) {
      const dx = (x - width * 0.5) / (width * 0.36);
      const dy = (y - height * 0.5) / (height * 0.44);
      if (dx * dx + dy * dy > 1.15) continue;
      const index = (y * width + x) * 4;
      const backgroundDistance = colorDistance(data, index, backgroundColor);
      if (backgroundDistance > 26 || localContrast(x, y) > 18) addSample(foregroundSamples, x, y);
    }
  }

  if (foregroundSamples.length < 24) {
    for (let y = Math.round(height * 0.3); y < height * 0.7; y += sampleStep) {
      for (let x = Math.round(width * 0.3); x < width * 0.7; x += sampleStep) addSample(foregroundSamples, x, y);
    }
  }

  const compactSamples = (samples, limit) => {
    if (samples.length <= limit) return samples;
    const compacted = [];
    const step = samples.length / limit;
    for (let index = 0; index < limit; index += 1) compacted.push(samples[Math.floor(index * step)]);
    return compacted;
  };
  const backgroundPalette = compactSamples(backgroundSamples, 120);
  const foregroundPalette = compactSamples(foregroundSamples, 160);
  const paletteDistance = (samples, index) => {
    let best = Infinity;
    for (const sample of samples) {
      const dr = data[index] - sample[0];
      const dg = data[index + 1] - sample[1];
      const db = data[index + 2] - sample[2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < best) best = distance;
    }
    return Math.sqrt(best);
  };

  const alpha = new Float32Array(pixelCount);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const dataIndex = pixelIndex * 4;
      const dx = (x - width * 0.5) / (width * 0.38);
      const dy = (y - height * 0.5) / (height * 0.5);
      const centerBias = clamp(1 - Math.sqrt(dx * dx + dy * dy), 0, 1);
      const edgeBias = clamp(localContrast(x, y) / 92, 0, 1);
      const foregroundDistance = paletteDistance(foregroundPalette, dataIndex);
      const backgroundDistance = paletteDistance(backgroundPalette, dataIndex);
      const colorScore = clamp((backgroundDistance - foregroundDistance + 18) / 90, 0, 1);
      const backgroundMatch = clamp((64 - backgroundDistance) / 64, 0, 1);
      const borderFade = Math.min(x, y, width - 1 - x, height - 1 - y) / Math.max(1, Math.min(width, height) * 0.08);
      alpha[pixelIndex] = clamp(
        colorScore * 0.5 + centerBias * 0.38 + edgeBias * 0.2 - backgroundMatch * (0.34 - centerBias * 0.24),
        0,
        1,
      ) * clamp(borderFade, 0, 1);
    }
  }

  const connected = new Uint8Array(pixelCount);
  const queue = [];
  const seedRadiusX = width * 0.18;
  const seedRadiusY = height * 0.22;
  for (let y = Math.round(height * 0.28); y < height * 0.72; y += 1) {
    for (let x = Math.round(width * 0.3); x < width * 0.7; x += 1) {
      const dx = (x - width * 0.5) / seedRadiusX;
      const dy = (y - height * 0.5) / seedRadiusY;
      const pixelIndex = y * width + x;
      if (dx * dx + dy * dy < 1 && alpha[pixelIndex] > 0.24) {
        connected[pixelIndex] = 1;
        queue.push(pixelIndex);
      }
    }
  }

  if (queue.length < 32) {
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (alpha[pixelIndex] > 0.72) {
        connected[pixelIndex] = 1;
        queue.push(pixelIndex);
      }
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const pixelIndex = queue[index];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const neighbors = [
      x > 0 ? pixelIndex - 1 : -1,
      x < width - 1 ? pixelIndex + 1 : -1,
      y > 0 ? pixelIndex - width : -1,
      y < height - 1 ? pixelIndex + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || connected[neighbor] || alpha[neighbor] < 0.13) continue;
      connected[neighbor] = 1;
      queue.push(neighbor);
    }
  }

  let softAlpha = alpha;
  for (let pass = 0; pass < 2; pass += 1) {
    const nextAlpha = new Float32Array(pixelCount);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let total = 0;
        let count = 0;
        for (let yy = -1; yy <= 1; yy += 1) {
          for (let xx = -1; xx <= 1; xx += 1) {
            const nextX = x + xx;
            const nextY = y + yy;
            if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
            total += softAlpha[nextY * width + nextX];
            count += 1;
          }
        }
        nextAlpha[y * width + x] = total / count;
      }
    }
    softAlpha = nextAlpha;
  }

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const borderFade = clamp(
      Math.min(x, y, width - 1 - x, height - 1 - y) / Math.max(1, Math.min(width, height) * 0.08),
      0,
      1,
    );
    const strong = Math.pow(clamp((Math.max(softAlpha[pixelIndex], alpha[pixelIndex] * 0.95) - 0.06) / 0.5, 0, 1), 0.72);
    const weak = Math.pow(clamp((softAlpha[pixelIndex] - 0.08) / 0.6, 0, 1), 0.82) * 0.56;
    const matteAlpha = (connected[pixelIndex] ? strong : weak) * borderFade;
    data[dataIndex + 3] = Math.round(data[dataIndex + 3] * matteAlpha);
  }

  matteCtx.putImageData(imageData, 0, 0);
  return matteCanvas;
}

function updateMatteControls() {
  const canMatte = state.rawSourceType === "image";
  document.querySelectorAll(".matte-segment").forEach((button) => {
    const active = (button.dataset.matte === "on") === state.matteEnabled;
    button.classList.toggle("active", active);
    button.disabled = !canMatte && button.dataset.matte === "on";
  });
}

function useDisplaySource(source, sourceType) {
  state.source = source;
  state.sourceType = sourceType;
  state.lastFrameTime = 0;
  queueRender({ immediate: true });
}

function applyMatteMode({ immediate = false } = {}) {
  if (!state.rawSource) return;
  const canMatte = state.rawSourceType === "image";
  if (!canMatte && state.matteEnabled) state.matteEnabled = false;
  updateMatteControls();

  if (!state.matteEnabled || !canMatte) {
    useDisplaySource(state.rawSource, state.rawSourceType);
    return;
  }

  if (state.matteSource) {
    useDisplaySource(state.matteSource, "image");
    return;
  }

  const token = state.matteToken + 1;
  state.matteToken = token;
  loadingState.textContent = "正在处理主体...";
  loadingState.classList.remove("hidden");

  window.setTimeout(() => {
    if (token !== state.matteToken || !state.rawSource) return;
    state.matteSource = createSubjectMatte(state.rawSource);
    useDisplaySource(state.matteSource, "image");
  }, immediate ? 0 : 24);
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function getSourceSize(source) {
  if (!source) return { width: 1, height: 1 };
  if (source instanceof HTMLVideoElement) {
    return {
      width: source.videoWidth || 1,
      height: source.videoHeight || 1,
    };
  }
  return {
    width: source.naturalWidth || source.width || 1,
    height: source.naturalHeight || source.height || 1,
  };
}

function getCoverRect(sourceWidth, sourceHeight, targetWidth, targetHeight, motion = { x: 0, y: 0 }) {
  const userScale = Number(controls.sourceScale.value) / 200;
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight) * userScale;
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2 + ((Number(controls.sourceX.value) + motion.x) / 100) * targetWidth,
    y: (targetHeight - height) / 2 + ((Number(controls.sourceY.value) + motion.y) / 100) * targetHeight,
    width,
    height,
    scale,
  };
}

function sourceFromCanvasRect(rect, sourceWidth, sourceHeight, zoom = 1) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const sourceW = rect.width / zoom;
  const sourceH = rect.height / zoom;
  const sw = Math.min(sourceW, sourceWidth);
  const sh = Math.min(sourceH, sourceHeight);
  return {
    sx: clamp(centerX - sw / 2, 0, Math.max(0, sourceWidth - sw)),
    sy: clamp(centerY - sh / 2, 0, Math.max(0, sourceHeight - sh)),
    sw: clamp(sw, 1, sourceWidth),
    sh: clamp(sh, 1, sourceHeight),
  };
}

function applyCanvasSize() {
  const bounds = canvasFrame.getBoundingClientRect();
  const isMobile = window.matchMedia("(max-width: 700px)").matches;
  const isLiveFrame = shouldRunContinuousRender();
  const gridCount = Number(controls.gridCount.value);
  const isDenseLiveFrame = isLiveFrame && gridCount > 12;
  const quality = isLiveFrame
    ? (isDenseLiveFrame ? (isMobile ? 0.95 : 1.02) : (isMobile ? 1.05 : 1.15))
    : (isMobile ? 1.25 : 1.35);
  const maxPixels = isLiveFrame
    ? (isDenseLiveFrame ? (isMobile ? 480000 : 680000) : (isMobile ? 620000 : 860000))
    : (isMobile ? 780000 : 1150000);
  const cssWidth = Math.max(320, Math.round(bounds.width));
  const cssHeight = Math.max(260, Math.round(bounds.height));
  const rawWidth = Math.round(cssWidth * quality);
  const rawHeight = Math.round(cssHeight * quality);
  const pixelRatio = Math.min(1, Math.sqrt(maxPixels / Math.max(1, rawWidth * rawHeight)));
  const nextWidth = Math.max(320, Math.round(rawWidth * pixelRatio));
  const nextHeight = Math.max(260, Math.round(rawHeight * pixelRatio));
  const nextKey = `${nextWidth}x${nextHeight}`;
  if (state.canvasKey !== nextKey) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    sceneCanvas.width = nextWidth;
    sceneCanvas.height = nextHeight;
    state.canvasKey = nextKey;
  }
}

function isLiveRender() {
  return shouldRunContinuousRender();
}

function getFrameInterval() {
  const gridCount = Number(controls.gridCount.value);
  if (state.sourceType === "video") return gridCount > 12 ? 48 : 38;
  if (state.sourceType === "gif") return gridCount > 12 ? 92 : 82;
  if (state.motion !== "still") return gridCount > 12 ? 46 : 34;
  return 0;
}

function drawScene(source, cover) {
  const gradient = sceneCtx.createLinearGradient(0, 0, sceneCanvas.width, sceneCanvas.height);
  gradient.addColorStop(0, "#e8dfd2");
  gradient.addColorStop(0.55, "#dcece7");
  gradient.addColorStop(1, "#f3eadf");
  sceneCtx.fillStyle = gradient;
  sceneCtx.fillRect(0, 0, sceneCanvas.width, sceneCanvas.height);

  if (state.matteEnabled && state.matteSource && source === state.matteSource) {
    sceneCtx.save();
    sceneCtx.globalAlpha = 0.32;
    sceneCtx.filter = "blur(1.4px) saturate(1.05) brightness(1.04)";
    sceneCtx.drawImage(state.matteSource, cover.x, cover.y, cover.width, cover.height);
    sceneCtx.restore();
  }

  sceneCtx.save();
  sceneCtx.filter = state.matteEnabled && source === state.matteSource
    ? "saturate(1.08) contrast(1.12) brightness(1.03)"
    : isLiveRender() ? "saturate(0.98) brightness(0.98)" : "blur(0.7px) saturate(0.98) brightness(0.98)";
  sceneCtx.drawImage(source, cover.x, cover.y, cover.width, cover.height);
  sceneCtx.restore();
  sceneCtx.fillStyle = "rgba(250, 246, 238, 0.08)";
  sceneCtx.fillRect(0, 0, sceneCanvas.width, sceneCanvas.height);
}

function getGlassRect() {
  const minSide = Math.min(canvas.width, canvas.height);
  const size = minSide * 0.64;
  const x = canvas.width * 0.5 - size / 2;
  const y = canvas.height * 0.5 - size / 2;
  return { x, y, size };
}

function getRotatedGlassBounds() {
  const { x, y, size } = getGlassRect();
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const cos = Math.cos(glassRotation);
  const sin = Math.sin(glassRotation);
  const corners = [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ].map((point) => {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    return {
      x: centerX + dx * cos - dy * sin,
      y: centerY + dx * sin + dy * cos,
    };
  });
  const padding = Math.ceil(size * 0.018);
  const left = Math.floor(Math.min(...corners.map((point) => point.x)) - padding);
  const top = Math.floor(Math.min(...corners.map((point) => point.y)) - padding);
  const right = Math.ceil(Math.max(...corners.map((point) => point.x)) + padding);
  const bottom = Math.ceil(Math.max(...corners.map((point) => point.y)) + padding);
  return {
    left: clamp(left, 0, canvas.width),
    top: clamp(top, 0, canvas.height),
    width: Math.min(canvas.width, right) - clamp(left, 0, canvas.width),
    height: Math.min(canvas.height, bottom) - clamp(top, 0, canvas.height),
    glass: { x, y, size, centerX, centerY },
  };
}

function createGlassExportCanvas(bounds = getRotatedGlassBounds(), sourceCanvas = canvas) {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = Math.max(1, Math.round(bounds.width));
  exportCanvas.height = Math.max(1, Math.round(bounds.height));
  const exportCtx = exportCanvas.getContext("2d");

  exportCtx.drawImage(
    sourceCanvas,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );

  exportCtx.globalCompositeOperation = "destination-in";
  exportCtx.save();
  exportCtx.translate(bounds.glass.centerX - bounds.left, bounds.glass.centerY - bounds.top);
  exportCtx.rotate(glassRotation);
  roundedRect(exportCtx, -bounds.glass.size / 2, -bounds.glass.size / 2, bounds.glass.size, bounds.glass.size, 3);
  exportCtx.fill();
  exportCtx.restore();
  exportCtx.globalCompositeOperation = "source-over";
  return exportCanvas;
}

function createScaledGlassExportCanvas(maxSide = 520, bounds = getRotatedGlassBounds()) {
  const sourceCanvas = createGlassExportCanvas(bounds);
  const scale = Math.min(1, maxSide / Math.max(sourceCanvas.width, sourceCanvas.height));
  if (scale >= 1) return sourceCanvas;

  const scaledCanvas = document.createElement("canvas");
  scaledCanvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  scaledCanvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const scaledCtx = scaledCanvas.getContext("2d");
  scaledCtx.imageSmoothingEnabled = true;
  scaledCtx.imageSmoothingQuality = "high";
  scaledCtx.drawImage(sourceCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
  return scaledCanvas;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function canvasToBlob(targetCanvas, type) {
  return new Promise((resolve) => targetCanvas.toBlob(resolve, type));
}

function triggerBlobDownload(blob, filename) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.download = filename;
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createGifPalette() {
  const palette = [];
  for (let index = 0; index < 256; index += 1) {
    if (index === 255) {
      palette.push(0, 0, 0);
      continue;
    }
    const r = index >> 5;
    const g = (index >> 2) & 7;
    const b = index & 3;
    palette.push(Math.round((r / 7) * 255), Math.round((g / 7) * 255), Math.round((b / 3) * 255));
  }
  return palette;
}

function rgbaToGifIndex(r, g, b, a) {
  if (a < 8) return 255;
  const index = ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6);
  return index === 255 ? 254 : index;
}

function canvasToIndexedPixels(targetCanvas) {
  const imageData = targetCanvas.getContext("2d").getImageData(0, 0, targetCanvas.width, targetCanvas.height).data;
  const indexed = new Uint8Array(targetCanvas.width * targetCanvas.height);
  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < imageData.length; sourceIndex += 4, targetIndex += 1) {
    indexed[targetIndex] = rgbaToGifIndex(
      imageData[sourceIndex],
      imageData[sourceIndex + 1],
      imageData[sourceIndex + 2],
      imageData[sourceIndex + 3],
    );
  }
  return indexed;
}

function lzwEncode(minCodeSize, pixels) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  const bytes = [];
  let current = 0;
  let bitCount = 0;

  const writeCode = (code) => {
    current |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(current & 255);
      current >>= 8;
      bitCount -= 8;
    }
  };

  const writeClear = () => {
    codeSize = minCodeSize + 1;
    writeCode(clearCode);
  };

  const chunkSize = 220;
  if (!pixels.length) writeClear();
  for (let index = 0; index < pixels.length; index += chunkSize) {
    writeClear();
    const end = Math.min(pixels.length, index + chunkSize);
    for (let pixelIndex = index; pixelIndex < end; pixelIndex += 1) {
      writeCode(pixels[pixelIndex]);
    }
  }

  writeCode(endCode);
  if (bitCount > 0) bytes.push(current & 255);
  return bytes;
}

async function encodeGif(frames, delayMs) {
  const bytes = [];
  const writeByte = (value) => bytes.push(value & 255);
  const writeBytes = (values) => values.forEach(writeByte);
  const writeString = (value) => {
    for (let index = 0; index < value.length; index += 1) writeByte(value.charCodeAt(index));
  };
  const writeShort = (value) => {
    writeByte(value);
    writeByte(value >> 8);
  };
  const writeBlocks = (values) => {
    for (let index = 0; index < values.length; index += 255) {
      const block = values.slice(index, index + 255);
      writeByte(block.length);
      writeBytes(block);
    }
    writeByte(0);
  };

  const { width, height } = frames[0];
  writeString("GIF89a");
  writeShort(width);
  writeShort(height);
  writeByte(0xf7);
  writeByte(255);
  writeByte(0);
  writeBytes(createGifPalette());

  writeBytes([0x21, 0xff, 0x0b]);
  writeString("NETSCAPE2.0");
  writeBytes([0x03, 0x01, 0x00, 0x00, 0x00]);

  const delay = Math.max(2, Math.round(delayMs / 10));
  for (const frame of frames) {
    writeBytes([0x21, 0xf9, 0x04, 0x09]);
    writeShort(delay);
    writeByte(255);
    writeByte(0);

    writeByte(0x2c);
    writeShort(0);
    writeShort(0);
    writeShort(frame.width);
    writeShort(frame.height);
    writeByte(0);

    writeByte(8);
    writeBlocks(lzwEncode(8, frame.pixels));
    await wait(0);
  }

  writeByte(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}

function getMotionCycleDuration() {
  if (state.motion === "horizontal") return (Math.PI * 2 * 1000) / 1.2;
  if (state.motion === "vertical") return (Math.PI * 2 * 1000) / 1.05;
  if (state.motion === "drift") return 7000;
  return 0;
}

function getGifExportSettings() {
  const motionDuration = getMotionCycleDuration();
  if (motionDuration) {
    const frameCount = Math.min(24, Math.max(20, Math.round(motionDuration / 230)));
    return {
      delay: motionDuration / frameCount,
      duration: motionDuration,
      frameCount,
      maxSide: 360,
      syntheticTimeline: !isAnimatedSource(),
    };
  }

  if (state.sourceType === "video") {
    const sourceDuration = Number.isFinite(videoSource.duration) ? videoSource.duration * 1000 : 3600;
    const duration = clamp(sourceDuration, 1800, 4800);
    const frameCount = Math.min(18, Math.max(14, Math.round(duration / 230)));
    return {
      delay: duration / frameCount,
      duration,
      frameCount,
      maxSide: 360,
      syntheticTimeline: false,
    };
  }

  if (state.sourceType === "gif") {
    const duration = 3000;
    return {
      delay: 150,
      duration,
      frameCount: 20,
      maxSide: 360,
      syntheticTimeline: false,
    };
  }

  return {
    delay: 120,
    duration: 1920,
    frameCount: 16,
    maxSide: 420,
    syntheticTimeline: true,
  };
}

function renderExportFrame(time) {
  state.forceRender = true;
  draw(time);
  stopQueuedRender();
  if (state.exporting) {
    loadingState.textContent = "正在导出 GIF...";
    loadingState.classList.remove("hidden");
  }
}

async function createGlassGifBlob() {
  const frames = [];
  const settings = getGifExportSettings();
  const previousLastFrameTime = state.lastFrameTime;
  const startTime = performance.now();
  let exportBounds = null;

  try {
    for (let index = 0; index < settings.frameCount; index += 1) {
      if (settings.syntheticTimeline) {
        const progress = index / settings.frameCount;
        renderExportFrame(startTime + progress * settings.duration);
        await wait(0);
      } else {
        queueRender({ immediate: true });
        await wait(index === 0 ? 120 : settings.delay);
      }

      if (!exportBounds) exportBounds = getRotatedGlassBounds();
      const frameCanvas = createScaledGlassExportCanvas(settings.maxSide, exportBounds);
      frames.push({
        width: frameCanvas.width,
        height: frameCanvas.height,
        pixels: canvasToIndexedPixels(frameCanvas),
      });
    }
  } finally {
    state.lastFrameTime = previousLastFrameTime;
    state.forceRender = true;
    requestNextFrame();
  }

  return await encodeGif(frames, settings.delay);
}

async function downloadGlassResult() {
  if (state.exporting) return;
  state.exporting = true;
  const previousLoadingText = loadingState.textContent;
  const wasLoadingHidden = loadingState.classList.contains("hidden");
  const shouldExportGif = shouldRunContinuousRender();
  loadingState.textContent = shouldExportGif ? "正在导出 GIF..." : "正在导出 PNG...";
  loadingState.classList.remove("hidden");

  try {
    queueRender({ immediate: true });
    await wait(80);
    if (shouldExportGif) {
      const gifBlob = await createGlassGifBlob();
      triggerBlobDownload(gifBlob, "glass-cat-panel.gif");
    } else {
      const pngBlob = await canvasToBlob(createGlassExportCanvas(), "image/png");
      if (pngBlob) triggerBlobDownload(pngBlob, "glass-cat-panel.png");
    }
  } finally {
    state.exporting = false;
    loadingState.textContent = previousLoadingText.startsWith("正在导出") ? "" : previousLoadingText;
    if (wasLoadingHidden) {
      loadingState.textContent = "";
      loadingState.classList.add("hidden");
    }
  }
}

function getTileCache(gridCount, distortion, size) {
  const cacheKey = `${gridCount}|${distortion}|${Math.round(size)}|${state.seed.toFixed(3)}`;
  if (state.tileCacheKey === cacheKey) return state.tileCache;

  const realTile = size / gridCount;
  const tiles = [];
  for (let row = 0; row < gridCount; row += 1) {
    for (let col = 0; col < gridCount; col += 1) {
      const tx = col * realTile;
      const ty = row * realTile;
      tiles.push({
        tx,
        ty,
        tw: Math.min(realTile, size - tx),
        th: Math.min(realTile, size - ty),
        wobbleX: Math.sin((row + 1.6) * 1.7 + state.seed) * distortion * 0.34,
        wobbleY: Math.cos((col + 0.8) * 1.4 + state.seed) * distortion * 0.3,
        wavePhase: row * 0.7 + col * 0.45,
        zoomOffset: ((row + col) % 3) * 0.018,
        even: (row + col) % 2 === 0,
        shadeHit: (row * 3 + col) % 5 === 0,
      });
    }
  }
  state.tileCacheKey = cacheKey;
  state.tileCache = tiles;
  return tiles;
}

function getMotionOffset(time) {
  if (state.motion === "still") return { x: 0, y: 0 };
  const t = time / 1000;
  if (state.motion === "horizontal") return { x: Math.sin(t * 1.2) * 5.5, y: 0 };
  if (state.motion === "vertical") return { x: 0, y: Math.sin(t * 1.05) * 4.5 };
  return {
    x: Math.sin(t * 0.9) * 3.8,
    y: Math.cos(t * 0.7) * 3.2,
  };
}

function drawEmbossedGrid(gridCount, size, highlight, live) {
  if (live) return;
  const tile = size / gridCount;
  ctx.save();
  ctx.lineWidth = Math.max(0.7, size * 0.0012);

  for (let index = 1; index < gridCount; index += 1) {
    const p = index * tile;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.08 + highlight * 0.1})`;
    ctx.beginPath();
    ctx.moveTo(p - 0.55, 2);
    ctx.lineTo(p - 0.55, size - 2);
    ctx.moveTo(2, p - 0.55);
    ctx.lineTo(size - 2, p - 0.55);
    ctx.stroke();

    ctx.strokeStyle = `rgba(8, 45, 42, ${0.055 + highlight * 0.045})`;
    ctx.beginPath();
    ctx.moveTo(p + 0.75, 2);
    ctx.lineTo(p + 0.75, size - 2);
    ctx.moveTo(2, p + 0.75);
    ctx.lineTo(size - 2, p + 0.75);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGlassBevel(size, highlight, magnify, live) {
  const thickness = clamp((magnify - 1) / 0.36, 0, 1);
  const edge = size * (live ? 0.018 : 0.018 + thickness * 0.022);
  const corner = Math.max(2, edge * 0.55);

  ctx.save();
  roundedRect(ctx, 0, 0, size, size, corner);
  ctx.clip();

  ctx.globalCompositeOperation = "screen";
  let edgeGradient = ctx.createLinearGradient(0, 0, 0, edge * 2.4);
  edgeGradient.addColorStop(0, `rgba(255, 255, 255, ${0.28 + highlight * 0.22})`);
  edgeGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = edgeGradient;
  ctx.fillRect(0, 0, size, edge * 2.4);

  edgeGradient = ctx.createLinearGradient(0, 0, edge * 2.2, 0);
  edgeGradient.addColorStop(0, `rgba(238, 252, 248, ${0.14 + highlight * 0.13})`);
  edgeGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = edgeGradient;
  ctx.fillRect(0, 0, edge * 2.2, size);

  ctx.globalCompositeOperation = "multiply";
  edgeGradient = ctx.createLinearGradient(size - edge * 2.4, 0, size, 0);
  edgeGradient.addColorStop(0, "rgba(255, 255, 255, 0)");
  edgeGradient.addColorStop(1, `rgba(11, 38, 35, ${0.1 + thickness * 0.08})`);
  ctx.fillStyle = edgeGradient;
  ctx.fillRect(size - edge * 2.4, 0, edge * 2.4, size);

  edgeGradient = ctx.createLinearGradient(0, size - edge * 2.6, 0, size);
  edgeGradient.addColorStop(0, "rgba(255, 255, 255, 0)");
  edgeGradient.addColorStop(1, `rgba(11, 38, 35, ${0.12 + thickness * 0.12})`);
  ctx.fillStyle = edgeGradient;
  ctx.fillRect(0, size - edge * 2.6, size, edge * 2.6);

  ctx.globalCompositeOperation = "source-over";
  ctx.lineWidth = Math.max(1.1, edge * 0.36);
  ctx.strokeStyle = `rgba(229, 247, 244, ${0.18 + highlight * 0.19})`;
  roundedRect(ctx, edge * 0.24, edge * 0.24, size - edge * 0.48, size - edge * 0.48, corner);
  ctx.stroke();

  ctx.lineWidth = Math.max(0.7, edge * 0.18);
  ctx.strokeStyle = `rgba(14, 42, 39, ${0.1 + thickness * 0.08})`;
  roundedRect(ctx, edge * 0.85, edge * 0.85, size - edge * 1.7, size - edge * 1.7, corner);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const gloss = ctx.createLinearGradient(0, 0, size, size * 0.78);
  gloss.addColorStop(0, `rgba(255,255,255,${0.16 + highlight * 0.26})`);
  gloss.addColorStop(0.22, "rgba(255,255,255,0.015)");
  gloss.addColorStop(0.5, `rgba(255,255,255,${0.055 + highlight * 0.1})`);
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  roundedRect(ctx, edge * 0.25, edge * 0.25, size - edge * 0.5, size - edge * 0.5, corner);
  ctx.fill();
  ctx.restore();
}

function drawGlass(source, cover, time) {
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const gridCount = Number(controls.gridCount.value);
  const distortion = Number(controls.distortion.value);
  const softness = Number(controls.softness.value);
  const highlight = Number(controls.highlight.value) / 100;
  const magnify = Number(controls.magnify.value) / 100;
  const live = isLiveRender();
  const { x, y, size } = getGlassRect();
  const realTile = size / gridCount;
  const breathe = state.motion !== "still" ? Math.sin(time / 700 + state.seed) * 2.2 : 0;
  const tiles = getTileCache(gridCount, distortion, size);

  ctx.save();
  ctx.translate(x + size / 2, y + size / 2);
  ctx.rotate(glassRotation);
  ctx.translate(-size / 2, -size / 2);

  ctx.shadowColor = "rgba(22, 32, 30, 0.26)";
  ctx.shadowBlur = 34 + (magnify - 1) * 86;
  ctx.shadowOffsetY = 18 + (magnify - 1) * 58;
  ctx.shadowOffsetX = 4 + (magnify - 1) * 10;
  ctx.fillStyle = "rgba(230, 255, 250, 0.1)";
  roundedRect(ctx, 0, 0, size, size, 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.save();
  roundedRect(ctx, 0, 0, size, size, 2);
  ctx.clip();

  const renderSoftness = live ? Math.min(softness, 2) : softness;
  if (renderSoftness > 0) ctx.filter = `blur(${renderSoftness * 0.24}px)`;

  for (const tile of tiles) {
    const { tx, ty, tw, th } = tile;
    const wave = Math.sin(time / 900 + tile.wavePhase) * breathe;
    const rect = {
      x: x + tx + tile.wobbleX + wave,
      y: y + ty + tile.wobbleY - wave,
      width: tw,
      height: th,
    };
    const zoom = magnify + tile.zoomOffset;
    const src = sourceFromCanvasRect(rect, sourceWidth, sourceHeight, zoom);

    if (live) {
      ctx.drawImage(source, src.sx, src.sy, src.sw, src.sh, tx, ty, tw, th);
    } else {
      ctx.save();
      roundedRect(ctx, tx + 1.2, ty + 1.2, tw - 2.4, th - 2.4, realTile * 0.1);
      ctx.clip();
      ctx.drawImage(source, src.sx, src.sy, src.sw, src.sh, tx, ty, tw, th);
      ctx.restore();
    }

    const shine = (tile.even ? 0.08 : 0.02) + highlight * 0.1;
    const shade = tile.shadeHit ? 0.1 : 0.04;
    if (live) {
      ctx.fillStyle = `rgba(255, 255, 255, ${shine * 0.7})`;
      ctx.fillRect(tx + 1.2, ty + 1.2, tw - 2.4, th - 2.4);
      ctx.fillStyle = `rgba(13, 30, 28, ${shade * 0.45})`;
      ctx.fillRect(tx + tw * 0.52, ty + th * 0.52, tw * 0.48 - 1.2, th * 0.48 - 1.2);
    } else {
      const tileGradient = ctx.createLinearGradient(tx, ty, tx + tw, ty + th);
      tileGradient.addColorStop(0, `rgba(255, 255, 255, ${shine + 0.12})`);
      tileGradient.addColorStop(0.45, "rgba(255, 255, 255, 0)");
      tileGradient.addColorStop(1, `rgba(13, 30, 28, ${shade})`);
      ctx.fillStyle = tileGradient;
      roundedRect(ctx, tx + 1.2, ty + 1.2, tw - 2.4, th - 2.4, realTile * 0.1);
      ctx.fill();
    }
  }

  drawEmbossedGrid(gridCount, size, highlight, live);
  ctx.restore();
  drawGlassBevel(size, highlight, magnify, live);

  ctx.restore();
}

function draw(time = 0) {
  state.raf = null;
  if (!state.source) return;

  if (document.hidden && !state.exporting) return;

  const shouldLoop = shouldRunContinuousRender();
  const frameInterval = getFrameInterval();
  if (shouldLoop && !state.forceRender && state.lastFrameTime && time - state.lastFrameTime < frameInterval) {
    requestNextFrame();
    return;
  }

  const { width: sourceWidth, height: sourceHeight } = getSourceSize(state.source);
  if (sourceWidth <= 1 || sourceHeight <= 1) {
    queueRender({ immediate: false });
    return;
  }

  applyCanvasSize();
  const cover = getCoverRect(sourceWidth, sourceHeight, canvas.width, canvas.height, getMotionOffset(time));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawScene(state.source, cover);
  ctx.drawImage(sceneCanvas, 0, 0);
  drawGlass(sceneCanvas, null, time);
  loadingState.classList.add("hidden");

  state.forceRender = false;
  state.lastFrameTime = time;
  if (shouldLoop) {
    requestNextFrame();
  }
}

function requestNextFrame() {
  if (document.hidden && !state.exporting) return;
  if (!state.raf) state.raf = requestAnimationFrame(draw);
}

function stopQueuedRender() {
  if (state.raf) cancelAnimationFrame(state.raf);
  if (state.drawTimer) window.clearTimeout(state.drawTimer);
  state.raf = null;
  state.drawTimer = null;
}

function queueRender({ immediate = false } = {}) {
  if (state.drawTimer) {
    window.clearTimeout(state.drawTimer);
    state.drawTimer = null;
  }
  if (immediate) {
    state.forceRender = true;
    requestNextFrame();
    return;
  }
  state.drawTimer = window.setTimeout(() => {
    state.drawTimer = null;
    state.forceRender = true;
    requestNextFrame();
  }, 24);
}

function loadImage(src, sourceType = "image") {
  const image = new Image();
  image.onload = () => {
    const validationError = validateImageDimensions(image, sourceType);
    if (validationError) {
      rejectObjectUrl(src, validationError);
      return;
    }
    state.rawSource = image;
    state.rawSourceType = sourceType;
    state.matteSource = null;
    state.matteToken += 1;
    videoSource.pause();
    applyMatteMode({ immediate: true });
  };
  image.onerror = () => {
    rejectObjectUrl(src, "这张素材暂时无法读取");
  };
  image.src = src;
}

function loadVideo(src) {
  let accepted = false;
  state.rawSource = null;
  state.rawSourceType = "video";
  state.matteSource = null;
  state.matteToken += 1;
  updateMatteControls();
  videoSource.pause();
  videoSource.onloadedmetadata = () => {
    const validationError = validateVideoMetadata(videoSource);
    if (validationError) {
      videoSource.pause();
      videoSource.removeAttribute("src");
      videoSource.load();
      rejectObjectUrl(src, validationError);
      return;
    }
    accepted = true;
  };
  videoSource.src = src;
  videoSource.onloadeddata = () => {
    if (!accepted) return;
    state.rawSource = videoSource;
    state.rawSourceType = "video";
    state.matteSource = null;
    updateMatteControls();
    videoSource.play().catch(() => undefined);
    useDisplaySource(videoSource, "video");
  };
  videoSource.onerror = () => {
    rejectObjectUrl(src, "这个视频暂时无法读取");
  };
  videoSource.load();
}

function setActivePreset(index) {
  state.activePreset = index;
  document.querySelectorAll(".preset").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.presetIndex) === index);
  });
}

function renderPresets() {
  presetGrid.innerHTML = "";

  const uploadLabel = document.createElement("label");
  uploadLabel.className = "upload-cell";
  uploadLabel.htmlFor = "fileInput";
  uploadLabel.setAttribute("aria-label", "上传图片、GIF 或视频");
  uploadLabel.innerHTML = `
    <span class="upload-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M12 3v12" />
        <path d="m7 8 5-5 5 5" />
        <path d="M4 17v3h16v-3" />
      </svg>
    </span>
    <span class="asset-label">上传</span>
  `;
  presetGrid.append(uploadLabel);

  const totalPages = Math.max(1, Math.ceil(presets.length / assetPageSize));
  state.assetPage = clamp(state.assetPage, 0, totalPages - 1);
  const pageStart = state.assetPage * assetPageSize;
  const visiblePresets = presets.slice(pageStart, pageStart + assetPageSize);

  visiblePresets.forEach((preset, visibleIndex) => {
    const index = pageStart + visibleIndex;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `preset${index === state.activePreset ? " active" : ""}`;
    button.dataset.presetIndex = String(index);
    button.setAttribute("aria-label", `选择${preset.name}`);
    button.addEventListener("click", () => {
      setActivePreset(index);
      resetSourceControls();
      loadImage(preset.src);
    });

    const image = document.createElement("img");
    image.src = preset.src;
    image.alt = preset.name;
    button.append(image);

    const label = document.createElement("span");
    label.textContent = preset.name;
    button.append(label);
    presetGrid.append(button);
  });

  assetPrev.disabled = state.assetPage === 0;
  assetNext.disabled = state.assetPage >= totalPages - 1;
  assetPageValue.textContent = `${state.assetPage + 1}/${totalPages}`;
}

function updateOutputs() {
  outputs.sourceScale.value = `${controls.sourceScale.value}%`;
  outputs.sourceX.value = controls.sourceX.value;
  outputs.sourceY.value = controls.sourceY.value;
  const gridCount = Number(controls.gridCount.value);
  outputs.gridCount.value = gridCount * gridCount;
  outputs.distortion.value = controls.distortion.value;
  outputs.magnify.value = Number(controls.magnify.value) - 100;
  outputs.softness.value = controls.softness.value;
  outputs.highlight.value = controls.highlight.value;
}

function resetSourceControls() {
  controls.sourceScale.value = 100;
  controls.sourceX.value = 0;
  controls.sourceY.value = 0;
  updateOutputs();
}

function setSourcePosition(nextX, nextY) {
  controls.sourceX.value = Math.round(clamp(nextX, Number(controls.sourceX.min), Number(controls.sourceX.max)));
  controls.sourceY.value = Math.round(clamp(nextY, Number(controls.sourceY.min), Number(controls.sourceY.max)));
  updateOutputs();
}

function bindCanvasDrag() {
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
    state.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      sourceX: Number(controls.sourceX.value),
      sourceY: Number(controls.sourceY.value),
      width: Math.max(1, canvas.getBoundingClientRect().width),
      height: Math.max(1, canvas.getBoundingClientRect().height),
    };
    queueRender({ immediate: true });
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    const dx = ((event.clientX - state.drag.startX) / state.drag.width) * 100;
    const dy = ((event.clientY - state.drag.startY) / state.drag.height) * 100;
    setSourcePosition(state.drag.sourceX + dx, state.drag.sourceY + dy);
    queueRender({ immediate: true });
  });

  const endDrag = (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    state.drag = null;
    canvas.classList.remove("dragging");
    queueRender({ immediate: true });
  };

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
}

function bindControls() {
  Object.entries(controls).forEach(([key, control]) => {
    control.addEventListener("input", () => {
      if (outputs[key]) updateOutputs();
      queueRender({ immediate: true });
    });
  });

  document.querySelectorAll(".motion-segment").forEach((button) => {
    button.addEventListener("click", () => {
      state.motion = button.dataset.motion;
      document.querySelectorAll(".motion-segment").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      queueRender({ immediate: true });
    });
  });

  document.querySelectorAll(".matte-segment").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      state.matteEnabled = button.dataset.matte === "on";
      applyMatteMode();
    });
  });

  document.querySelectorAll(".range-default-button").forEach((button) => {
    button.addEventListener("click", () => {
      const control = controls[button.dataset.control];
      if (!control) return;
      control.value = button.dataset.value;
      updateOutputs();
      queueRender({ immediate: true });
    });
  });

  document.querySelector("#randomizeButton").addEventListener("click", () => {
    controls.gridCount.value = Math.round(3 + Math.random() * 12);
    controls.distortion.value = Math.round(10 + Math.random() * 28);
    controls.magnify.value = Math.round(108 + Math.random() * 24);
    controls.softness.value = Math.round(2 + Math.random() * 5);
    controls.highlight.value = Math.round(44 + Math.random() * 42);
    state.seed = Math.random() * 1000;
    updateOutputs();
    queueRender({ immediate: true });
  });

  document.querySelector("#downloadButton").addEventListener("click", () => {
    downloadGlassResult();
  });

  assetPrev.addEventListener("click", () => {
    state.assetPage = Math.max(0, state.assetPage - 1);
    renderPresets();
  });

  assetNext.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(presets.length / assetPageSize));
    state.assetPage = Math.min(totalPages - 1, state.assetPage + 1);
    renderPresets();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const kind = getFileKind(file);
    const sizeError = validateFileSize(file, kind);
    if (sizeError) {
      showMediaError(sizeError);
      fileInput.value = "";
      return;
    }
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    const url = URL.createObjectURL(file);
    state.objectUrl = url;
    setActivePreset(-1);
    resetSourceControls();
    loadingState.textContent = "正在读取素材...";
    loadingState.classList.remove("hidden");
    if (file.type.startsWith("video/")) loadVideo(url);
    else loadImage(url, kind === "gif" ? "gif" : "image");
    fileInput.value = "";
  });

  window.addEventListener("resize", () => queueRender({ immediate: false }));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.sourceType === "video") videoSource.pause();
      stopQueuedRender();
      return;
    }
    if (state.sourceType === "video") videoSource.play().catch(() => undefined);
    queueRender({ immediate: true });
  });
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => queueRender({ immediate: false }));
    observer.observe(canvasFrame);
  }
}

renderPresets();
bindControls();
bindCanvasDrag();
updateMatteControls();
updateOutputs();
loadImage(presets[0].src);

import sharp from 'sharp';

export type SyntheticBubbleShape =
  | 'ellipse'
  | 'rounded-rectangle'
  | 'narration-box'
  | 'thought-cloud'
  | 'irregular'
  | 'speech-tail'
  | 'partial';

/** Draw synthetic, location-parameterized bubble fixtures; no sample comic coordinates are used. */
export async function createBubbleFixture(
  shape: SyntheticBubbleShape,
  width = 400,
  height = 300,
): Promise<Buffer> {
  const centerX = width / 2;
  const centerY = height / 2;
  let drawing: string;
  if (shape === 'ellipse') {
    drawing = `<ellipse cx="${centerX}" cy="${centerY}" rx="${width * 0.24}" ry="${height * 0.25}" fill="#fff" stroke="#111" stroke-width="4"/>`;
  } else if (shape === 'rounded-rectangle') {
    drawing = `<rect x="${width * 0.25}" y="${height * 0.28}" width="${width * 0.5}" height="${height * 0.44}" rx="28" fill="#fff" stroke="#111" stroke-width="4"/>`;
  } else if (shape === 'narration-box') {
    drawing = `<rect x="${width * 0.27}" y="${height * 0.32}" width="${width * 0.46}" height="${height * 0.36}" fill="#fff" stroke="#111" stroke-width="4"/>`;
  } else if (shape === 'thought-cloud') {
    const radii = Array.from({ length: 12 }, (_, index) => {
      const angle = (index / 12) * Math.PI * 2;
      const radius = index % 2 === 0 ? width * 0.22 : width * 0.19;
      return `${(centerX + Math.cos(angle) * radius).toFixed(2)},${(centerY + Math.sin(angle) * radius * 0.72).toFixed(2)}`;
    });
    const points = radii.map(
      (pair) => pair.split(',').map(Number) as [number, number],
    );
    const path =
      points.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ') +
      ' Z';
    drawing = `<path d="${path}" fill="#fff" stroke="#111" stroke-width="4"/>`;
  } else if (shape === 'irregular') {
    const points = Array.from({ length: 18 }, (_, index) => {
      const angle = (index / 18) * Math.PI * 2;
      const radius = index % 2 === 0 ? width * 0.25 : width * 0.13;
      return `${(centerX + Math.cos(angle) * radius).toFixed(2)},${(centerY + Math.sin(angle) * radius * 0.72).toFixed(2)}`;
    });
    const path =
      points.map((point, index) => `${index ? 'L' : 'M'}${point}`).join(' ') +
      ' Z';
    drawing = `<path d="${path}" fill="#fff" stroke="#111" stroke-width="4"/>`;
  } else if (shape === 'speech-tail') {
    drawing = `<path d="M${centerX - width * 0.23},${centerY} C${centerX - width * 0.23},${centerY - height * 0.24} ${centerX + width * 0.23},${centerY - height * 0.24} ${centerX + width * 0.23},${centerY} C${centerX + width * 0.23},${centerY + height * 0.18} ${centerX + width * 0.08},${centerY + height * 0.2} ${centerX + width * 0.08},${centerY + height * 0.2} L${centerX},${centerY + height * 0.39} L${centerX - width * 0.08},${centerY + height * 0.2} C${centerX - width * 0.08},${centerY + height * 0.2} ${centerX - width * 0.23},${centerY + height * 0.18} ${centerX - width * 0.23},${centerY} Z" fill="#fff" stroke="#111" stroke-width="4"/>`;
  } else {
    drawing = `<ellipse cx="${width * 0.96}" cy="${centerY}" rx="${width * 0.28}" ry="${height * 0.26}" fill="#fff" stroke="#111" stroke-width="4"/>`;
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#999"/>${drawing}</svg>`,
  );
  return sharp(svg).png().toBuffer();
}

export async function createBlankWhitePanelFixture(
  width = 400,
  height = 300,
): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#999"/><rect x="${width * 0.25}" y="${height * 0.2}" width="${width * 0.5}" height="${height * 0.6}" fill="#fff" stroke="#111" stroke-width="4"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

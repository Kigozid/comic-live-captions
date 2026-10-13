import sharp from 'sharp';

export interface SyntheticAlignmentCase {
  readonly width?: number;
  readonly height?: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly translateX?: number;
  readonly translateY?: number;
  readonly scale?: number;
  readonly rotationDegrees?: number;
}

/** Generated abstract shapes and gradients; contains no comic page artwork. */
export async function createSyntheticAlignmentPair(
  options: SyntheticAlignmentCase = {},
): Promise<{ readonly original: Buffer; readonly cleaned: Buffer }> {
  const width = options.width ?? 240;
  const height = options.height ?? 180;
  const sourceWidth = options.sourceWidth ?? width;
  const sourceHeight = options.sourceHeight ?? height;
  const scale = options.scale ?? 1;
  const rotation = options.rotationDegrees ?? 0;
  const translateX = options.translateX ?? 0;
  const translateY = options.translateY ?? 0;
  const centerX = width / 2;
  const centerY = height / 2;
  const background = `<defs>
      <linearGradient id="background" x2="1" y2="1"><stop stop-color="#fafafa"/><stop offset="1" stop-color="#c8d3df"/></linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#background)"/>`;
  const features = `<g fill="none" stroke="#17212b" stroke-width="4">
      <path d="M${width * 0.12} ${height * 0.22} Q${width * 0.3} ${height * 0.05} ${width * 0.43} ${height * 0.24} L${width * 0.34} ${height * 0.42} Z"/>
      <circle cx="${width * 0.73}" cy="${height * 0.31}" r="${Math.min(width, height) * 0.13}"/>
      <path d="M${width * 0.17} ${height * 0.68} L${width * 0.29} ${height * 0.52} L${width * 0.42} ${height * 0.79} Z"/>
      <path d="M${width * 0.59} ${height * 0.68} C${width * 0.66} ${height * 0.48} ${width * 0.86} ${height * 0.88} ${width * 0.91} ${height * 0.59}"/>
    </g>
    <g fill="#e44d36"><circle cx="${width * 0.48}" cy="${height * 0.54}" r="8"/><rect x="${width * 0.78}" y="${height * 0.76}" width="17" height="11"/></g>
    <path d="M${width * 0.1} ${height * 0.88} H${width * 0.55}" stroke="#253d8f" stroke-width="6"/>`;
  const originalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background}${features}</svg>`;
  const cleanedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth}" height="${sourceHeight}" viewBox="0 0 ${width} ${height}">
    ${background}
    <g transform="translate(${translateX},${translateY}) translate(${centerX},${centerY}) rotate(${rotation}) scale(${scale}) translate(${-centerX},${-centerY})">${features}</g>
  </svg>`;
  return {
    original: await sharp(Buffer.from(originalSvg)).png().toBuffer(),
    cleaned: await sharp(Buffer.from(cleanedSvg)).png().toBuffer(),
  };
}

/** Abstract page and removed glyph-like strokes; deliberately not comic artwork. */
export async function createSyntheticTextRemovalPair(): Promise<{
  readonly original: Buffer;
  readonly cleaned: Buffer;
}> {
  const width = 320;
  const height = 180;
  const glyphs = Array.from({ length: 7 }, (_, index) => {
    const x = 32 + index * 15;
    const pattern = [
      `<rect x="${x}" y="34" width="3" height="13"/>`,
      `<rect x="${x + 7}" y="34" width="3" height="13"/>`,
      `<rect x="${x}" y="34" width="10" height="3"/>`,
      `<rect x="${x}" y="44" width="10" height="3"/>`,
    ];
    if (index % 2 === 0)
      pattern.push(`<rect x="${x}" y="39" width="10" height="2"/>`);
    return pattern.join('');
  }).join('');
  const originalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>
    <g fill="#141414">${glyphs}</g>
    <rect x="210" y="72" width="62" height="34" fill="#333"/>
    <rect x="180" y="145" width="2" height="2" fill="#111"/>
  </svg>`;
  const cleanedSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#fff"/>
  </svg>`;
  return {
    original: await sharp(Buffer.from(originalSvg)).png().toBuffer(),
    cleaned: await sharp(Buffer.from(cleanedSvg)).png().toBuffer(),
  };
}

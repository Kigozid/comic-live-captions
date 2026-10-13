export interface ChangedRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
}
export interface ImageDifference {
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  readonly changedPixelRatio: number;
  readonly meanAbsoluteChannelDifference: number;
  readonly maximumChannelDifference: number;
  readonly changedRegions: readonly ChangedRegion[];
}

/** Exact decoded-pixel comparison with 8-connected changed-region bounds. */
export function compareRgbaImages(
  reference: Uint8Array,
  actual: Uint8Array,
  width: number,
  height: number,
): ImageDifference {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    reference.length !== width * height * 4 ||
    actual.length !== reference.length
  )
    throw new RangeError(
      'RGBA images must have matching positive dimensions and four channels.',
    );
  const pixelCount = width * height;
  const changed = new Uint8Array(pixelCount);
  let changedPixels = 0;
  let sumDifference = 0;
  let maximumChannelDifference = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = Math.abs(
        reference[pixel * 4 + channel]! - actual[pixel * 4 + channel]!,
      );
      sumDifference += difference;
      maximumChannelDifference = Math.max(maximumChannelDifference, difference);
      pixelChanged ||= difference !== 0;
    }
    if (pixelChanged) {
      changed[pixel] = 1;
      changedPixels += 1;
    }
  }
  const visited = new Uint8Array(pixelCount);
  const regions: ChangedRegion[] = [];
  for (let index = 0; index < pixelCount; index += 1) {
    if (!changed[index] || visited[index]) continue;
    const queue = [index];
    visited[index] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (changed[neighbor] && !visited[neighbor]) {
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
        }
    }
    regions.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      changedPixels: count,
    });
  }
  regions.sort(
    (a, b) => b.changedPixels - a.changedPixels || a.y - b.y || a.x - b.x,
  );
  return {
    width,
    height,
    changedPixels,
    changedPixelRatio: changedPixels / pixelCount,
    meanAbsoluteChannelDifference: sumDifference / (pixelCount * 4),
    maximumChannelDifference,
    changedRegions: regions,
  };
}

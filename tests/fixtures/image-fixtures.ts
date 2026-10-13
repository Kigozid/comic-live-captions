import sharp, { type FormatEnum } from 'sharp';

export async function createImage(
  width: number,
  height: number,
  format: keyof FormatEnum = 'png',
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 235, g: 231, b: 224, alpha: 1 },
    },
  });
  if (format === 'jpeg') return image.jpeg().toBuffer();
  if (format === 'webp') return image.webp().toBuffer();
  return image.png().toBuffer();
}

export async function createOversizedPngHeader(): Promise<Buffer> {
  const image = await createImage(1, 1);
  const oversized = Buffer.from(image);
  oversized.writeUInt32BE(7000, 16);
  oversized.writeUInt32BE(6000, 20);
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
  return oversized;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

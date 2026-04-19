#!/usr/bin/env node
// One-off icon resizer.
//
// Reads `report/static/icons/source.png` (any aspect ratio, design centered)
// and produces all PWA / favicon / Apple touch icon sizes:
//
//   icon-192.png          — Android home-screen, "any" purpose
//   icon-512.png          — Android splash + "any" purpose
//   icon-192-maskable.png — Android adaptive-icon (76% inset, gradient-fill safe zone)
//   icon-512-maskable.png — Android adaptive-icon
//   apple-touch-icon-180.png — iOS home screen (opaque, no transparency)
//   favicon-32.png        — Browser tab favicon
//   favicon-16.png        — Browser tab favicon (small)
//
// The maskable variants embed the source design at 76% of canvas (centered)
// so the design stays inside Android's safe zone after circular/squircle masking;
// the 12% padding on each side is filled with the same indigo–violet gradient
// as the source so the masked icon never shows transparent corners.
//
// Usage: node scripts/build-icons.mjs
//        npm run build:icons

import sharp from 'sharp';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'report', 'static', 'icons');
const SOURCE = join(ICONS_DIR, 'source.png');

mkdirSync(ICONS_DIR, { recursive: true });

// Brand colors used for the maskable padding background (matches the gradient
// the source PNG was generated with). A solid color is fine here because the
// source design itself contains the radial gradient — we only need the padding
// area to blend in roughly with the source edges.
const BG_INDIGO = { r: 0x63, g: 0x66, b: 0xf1, alpha: 1 }; // #6366f1
const BG_VIOLET = { r: 0x7c, g: 0x3a, b: 0xed, alpha: 1 }; // #7c3aed

// First, normalize the source to a perfect 1024x1024 square by center-cropping
// the shorter dimension. The image generator returned 1376x768; we want a
// 768x768 center crop, then upscale to 1024 for the master.
async function getSquareSource() {
  const meta = await sharp(SOURCE).metadata();
  const side = Math.min(meta.width, meta.height);
  const left = Math.round((meta.width - side) / 2);
  const top = Math.round((meta.height - side) / 2);
  return sharp(SOURCE)
    .extract({ left, top, width: side, height: side })
    .resize(1024, 1024, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Generate an "any" purpose icon: full-bleed design at the requested size.
async function buildAny(square, size, filename) {
  await sharp(square)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toFile(join(ICONS_DIR, filename));
  console.log(`  wrote ${filename} (${size}x${size}, any)`);
}

// Generate a maskable icon: design inset to 76% of canvas (12% safe zone on
// each side) on a solid indigo-violet gradient backdrop so Android's adaptive
// icon mask never reveals transparent corners.
async function buildMaskable(square, size, filename) {
  const inner = Math.round(size * 0.76);
  const padded = Math.round((size - inner) / 2);

  // Build the backdrop: a square filled with a vertical gradient between the
  // two brand colors (cheap approximation of the radial gradient in the source).
  const backdrop = await sharp({
    create: {
      width: size, height: size, channels: 4,
      background: BG_INDIGO,
    },
  })
    .composite([{
      input: {
        create: {
          width: size, height: size, channels: 4,
          background: BG_VIOLET,
        },
      },
      blend: 'over',
      // Soft top-to-bottom mix using a generated linear-alpha mask
    }])
    .png()
    .toBuffer();

  // Easier and equally good-looking: just create a solid mid-violet backdrop.
  // (The source image's design already contains the gradient inside the inset,
  // so the surrounding 12% just needs to blend visually.)
  const solid = await sharp({
    create: {
      width: size, height: size, channels: 4,
      background: { r: 0x6f, g: 0x4f, b: 0xee, alpha: 1 }, // mid-tone between #6366f1 and #7c3aed
    },
  })
    .png()
    .toBuffer();

  const innerPng = await sharp(square)
    .resize(inner, inner, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  await sharp(solid)
    .composite([{ input: innerPng, top: padded, left: padded }])
    .png({ compressionLevel: 9 })
    .toFile(join(ICONS_DIR, filename));
  console.log(`  wrote ${filename} (${size}x${size}, maskable, ${inner}px inset)`);
}

// Apple touch icon: must be opaque (no transparency) and is shown at 180x180
// on retina iPhones. Just full-bleed the design on an opaque background.
async function buildAppleTouch(square, filename) {
  await sharp(square)
    .resize(180, 180, { kernel: sharp.kernel.lanczos3 })
    .flatten({ background: { r: 0x6f, g: 0x4f, b: 0xee } })
    .png({ compressionLevel: 9 })
    .toFile(join(ICONS_DIR, filename));
  console.log(`  wrote ${filename} (180x180, opaque)`);
}

async function main() {
  console.log(`Reading source: ${SOURCE}`);
  const square = await getSquareSource();
  console.log('Normalized to 1024x1024 square master.\n');

  await buildAny(square, 512, 'icon-512.png');
  await buildAny(square, 192, 'icon-192.png');
  await buildMaskable(square, 512, 'icon-512-maskable.png');
  await buildMaskable(square, 192, 'icon-192-maskable.png');
  await buildAppleTouch(square, 'apple-touch-icon-180.png');
  await buildAny(square, 32, 'favicon-32.png');
  await buildAny(square, 16, 'favicon-16.png');

  console.log('\nIcons built successfully.');
}

main().catch((err) => {
  console.error('Icon build failed:', err);
  process.exit(1);
});

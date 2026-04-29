# Pollinations Image Generator

A lightweight browser-based AI image generation workspace powered by the [Pollinations API](https://pollinations.ai).

## Features

- **BYOP Authorization** - Supports Pollinations OAuth for fast authorization and one-click account connection
- **Multiple AI Models** - Supports flux, turbo, z-image, gptimage, seedream, and more
- **Batch Generation** - Generate 2, 4, 6, or 9 images at once with concurrent processing
- **Customizable Parameters** - Control size, seed, quality, guidance scale, and more
- **Generation History** - Automatically saves the last 20 generation records locally
- **Dark/Light Theme** - Theme switch with persistent preference storage
- **Zero Dependencies** - Built with plain HTML, CSS, and vanilla JavaScript

## Quick Start

0. Use online: dot com here

1. Clone the repository:
   ```bash
git clone https://github.com/yourusername/pollinations.git
cd pollinations
```

2. Open `index.html` in your browser.

3. Get an API key (one of the two options):
   - **Quick Authorization**: Click the "Connect Pollinations Account" button in settings and complete OAuth authorization
   - **Custom Key**: Get a key from [enter.pollinations.ai](https://enter.pollinations.ai) (select Publishable Key) and enter it manually

4. Enter a prompt and start generating!

## Project Structure

```
pollinations/
├── README.md            # English documentation
├── index.html           # UI and styles
├── app.js               # Application logic
└── vercel.json          # Vercel deployment settings
```

## Generation Parameters

| Parameter | Description | Range / Options |
|-----------|-------------|-----------------|
| Prompt | Text description for the image | Required |
| Negative Prompt | Content to avoid in the image | Optional |
| Width | Image width (pixels) | 0-9007199254740991 |
| Height | Image height (pixels) | 0-9007199254740991 |
| Seed | Reproducibility seed (-1 for random) | -1-2147483647 |
| Quality | Output quality level | low, medium, high, hd |
| Guidance Scale | How closely the prompt is followed | 1-20 |
| Model | AI model to use | flux, turbo, z-image, etc. |

### Optional Enhancements

- **Prompt Optimization** - AI-enhanced prompt improvement
- **Remove Watermark** - Remove watermark from generated images
- **Safety Mode** - Filter inappropriate content
- **Transparent Background** - Generate images with an alpha channel

## Deployment

### Vercel (Recommended)

1. Fork this repository
2. Import it into [Vercel](https://vercel.com)
3. Deploy - no extra configuration needed

### Static Hosting

Upload the `image-generator` folder to any static hosting service (GitHub Pages, Netlify, etc.).

## API Reference

This project uses the Pollinations API. For full API documentation, see [Pollinations Official Docs](https://enter.pollinations.ai/api/docs)

## Acknowledgements

- [Pollinations.ai](https://pollinations.ai) for providing the AI image generation API

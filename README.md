# Pollimage

A small, phone-first image generator that runs entirely in the browser. It works with the [Pollinations](https://pollinations.ai) API and with any OpenAI-compatible image API, such as [Logfare](https://logfare.ai/docs#images).

Plain HTML, CSS and JavaScript. No build step, no backend.

## Features

- **Phone-first layout** – the image fills the screen, the prompt sits in a bottom dock, and options, history and settings open as bottom sheets.
- **Pollinations models** – the model list is loaded live from the API, and only the settings each model supports are shown and sent (seed, negative prompt, quality, reference image, transparency).
- **Custom providers** – add any OpenAI-compatible endpoint (`POST {base}/images/generations`, `GET {base}/models`). Presets for Logfare and ModelScope are built in.
- **Aspect presets** – 1:1, 3:4, 4:3, 2:3, 3:2, 9:16, 16:9, or type your own size.
- **Batch generation** – 1, 2, 4, 6 or 9 images at once, with a per-provider limit on parallel requests.
- **History** – the last 50 images are stored in your browser (IndexedDB) and restore their prompt and settings when tapped.
- **Clear errors** – a plain-language reason with Try again, and Open settings when the key is the problem.
- **Dark and light themes**.

## Use it

1. Open the deployed site, or open `index.html` locally (any static server also works).
2. Open **Settings** and add a key:
   - **Pollinations** – use *Connect Pollinations Account*, or paste a key from [enter.pollinations.ai](https://enter.pollinations.ai).
   - **Custom provider** – choose *Add Logfare*, *Add ModelScope* (or add your own), enter the key, then tap **Test connection**.
   - **ModelScope** – use the site your account was made on: `https://api-inference.modelscope.ai/v1` (English site) or `https://api-inference.modelscope.cn/v1`, with a token from the same site. Its model list is mostly chat models, so the app keeps only names that look like image models (Qwen-Image, Z-Image, FLUX and similar; "Edit" models are left out). If one is missing, type it into *Models*.
3. Pick a model, write a prompt and tap Generate (Ctrl+Enter also works).

## Privacy

- Keys and providers are stored only in your browser's `localStorage`. They are sent only to the service you configured.
- Pollinations keys are sent in an `Authorization` header, not in the image URL.
- Generated images and history stay in your browser. Nothing is sent to any server of this project.
- ModelScope blocks its async headers from browser pages, so those requests go through `api/modelscope.js` on your own Vercel deployment. It only forwards to ModelScope hosts, adds nothing, and stores nothing. Your token passes through it in the `Authorization` header. This needs the Vercel deployment; it will not work from a local `index.html`.
- Other custom providers must allow requests from your site (CORS). If a provider blocks it, the app says so.

## Files

```
├── index.html          # layout, styles and icons
├── app.js              # providers, generation, history
├── api/modelscope.js   # Vercel function that forwards ModelScope requests
└── vercel.json         # Vercel settings
```

## Deploy

**Vercel:** import the repository and deploy. No settings are needed.

**Other static hosts:** upload `index.html` and `app.js` to GitHub Pages, Netlify or similar.

## API references

- Pollinations: [enter.pollinations.ai/api/docs](https://enter.pollinations.ai/api/docs)
- Logfare images: [logfare.ai/docs#images](https://logfare.ai/docs#images)

## Acknowledgements

Thanks to [Pollinations.ai](https://pollinations.ai) for the image API.

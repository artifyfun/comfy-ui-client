# ComfyUI Client

[![npm][badge-version]][npm]
[![license][badge-license]][license]

Node.js [ComfyUI](https://github.com/comfyanonymous/ComfyUI) client based on the [WebSockets API example](https://github.com/comfyanonymous/ComfyUI/blob/master/script_examples/websockets_api_example.py).

See example in [`examples/generate`][examples-generate].

## Install

To install `@artifyfun/comfy-ui-client` in an existing project:

```sh
npm install @artifyfun/comfy-ui-client
```

## Example Usage

```ts
import { ComfyUIClient } from '@artifyfun/comfy-ui-client';
import type { Prompt } from '@artifyfun/comfy-ui-client';

// Your prompt / workflow
const prompt: Prompt = {
    '3': {
        class_type: 'KSampler',
        inputs: {
            cfg: 8,
            denoise: 1,
            latent_image: ['5', 0],
            model: ['4', 0],
            negative: ['7', 0],
            positive: ['6', 0],
            sampler_name: 'euler',
            scheduler: 'normal',
            seed: 8566257,
            steps: 20,
        },
    },
    '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: {
            ckpt_name: 'v1-5-pruned-emaonly.cpkt',
        },
    },
    '5': {
        class_type: 'EmptyLatentImage',
        inputs: {
            batch_size: 1,
            height: 512,
            width: 512,
        },
    },
    '6': {
        class_type: 'CLIPTextEncode',
        inputs: {
            clip: ['4', 1],
            text: 'masterpiece best quality girl',
        },
    },
    '7': {
        class_type: 'CLIPTextEncode',
        inputs: {
            clip: ['4', 1],
            text: 'bad hands',
        },
    },
    '8': {
        class_type: 'VAEDecode',
        inputs: {
            samples: ['3', 0],
            vae: ['4', 2],
        },
    },
    '9': {
        class_type: 'SaveImage',
        inputs: {
            filename_prefix: 'ComfyUI',
            images: ['8', 0],
        },
    },
};

// Set the text prompt for our positive CLIPTextEncode
prompt['6'].inputs.text = 'masterpiece best quality man';

// Set the seed for our KSampler node
prompt['3'].inputs.seed = 5;

// Create client
const serverAddress = '127.0.0.1:8188';
// Create client (options are optional)
const serverAddress = '127.0.0.1:8188'; // or https://comfy.example.com
const clientId = 'baadbabe-b00b-4206-9420-deadd00d1337';
const client = new ComfyUIClient(serverAddress, clientId, {
  // apiToken: '...',           // Bearer auth for multi-user servers
  // requestTimeoutMs: 60000,   // HTTP request timeout (default 60s)
  // logger: console,           // inject your own pino-like logger
});

// Connect to server (rejects on failure / timeout)
await client.connect();

// Generate images with progress reporting, per-node callbacks,
// and a timeout. Rejects on execution_error / interrupted /
// disconnect / timeout instead of hanging forever.
const images = await client.getImages(prompt, {
  timeoutMs: 10 * 60_000,
  onProgress: (p) => console.log(`progress: ${p.value}/${p.max}`),
  onExecuting: (d) => {
    if (d.node) console.log(`executing node ${d.node}`);
  },
});

// Save images to file (parallel, preserves subfolders)
const outputDir = './tmp/output';
await client.saveImages(images, outputDir);

// Disconnect
client.disconnect();
```

## API

### Client options

```ts
new ComfyUIClient(serverAddress, clientId, options?)
```

| Option                     | Type        | Default        | Description                                            |
| -------------------------- | ----------- | -------------- | ------------------------------------------------------ |
| `serverAddress`            | `string`    | —              | `host:port`; `http(s)://` / `ws(s)://` detected automatically |
| `clientId`                 | `string`    | —              | Session id used on the WebSocket connection            |
| `options.apiToken`         | `string`    | —              | Sent as `Authorization: Bearer` (multi-user servers)   |
| `options.requestTimeoutMs` | `number`    | `60000`        | Per-request HTTP timeout; `0` disables                 |
| `options.logger`           | `LoggerLike`| pino (`info`)  | pino-like logger (`console` works)                     |

### High-level helpers

- `connect(timeoutMs?)` / `disconnect()` / `isConnected()` — WebSocket lifecycle. `connect` rejects on connection failure or timeout.
- `getImages(prompt, options?)` — queue a workflow, wait for completion, download **image** outputs.
- `getOutputs(prompt, options?)` — same, but downloads **all** output kinds (images, videos, audio).
- `waitForPrompt(prompt, options?)` — queue and wait, resolving with the history entry (no downloads).
- `saveImages(images, outputDir)` — write downloaded outputs to disk in parallel, preserving subfolders.

`GetImagesOptions`:

| Option        | Type                        | Description                                      |
| ------------- | --------------------------- | ------------------------------------------------ |
| `timeoutMs`   | `number`                    | Overall execution timeout (`0`/undefined = none) |
| `onProgress`  | `(p: ProgressData) => void` | Sampling progress (`value` / `max`)              |
| `onExecuting` | `(d: ExecutingData) => void`| Node execution events (`node === null` = done)   |
| `signal`      | `AbortSignal`               | Cancel waiting (does not stop server execution)  |

### Events

`client.on(event, handler)` / `client.off(event, handler)`:

`status`, `progress`, `executing`, `executing_cached`, `execution_start`,
`execution_success`, `execution_error`, `execution_interrupted`,
`preview` (parsed binary previews), `disconnected`.

### HTTP endpoints

- `getEmbeddings()`, `getExtensions()`
- `getSystemStats()`, `getStats()` (newer servers)
- `getPrompt()` — queue remaining
- `queuePrompt(prompt)`, `interrupt()`
- `getQueue()`, `editQueue({ clear?, delete?, delete_iterative? })`
- `freeMemory({ unload_models?, free_memory? })` — `POST /free`
- `getHistory(promptId?, maxItems?)`, `editHistory({ clear?, delete? })`
- `getObjectInfo(nodeClass?)`, `getObjectInfoFor(nodeClasses[])` — subset via `POST /object_info` (newer servers)
- `viewMetadata(folderName, filename)`
- `getImage({ filename, subfolder, type, channel?, download? })` — `GET /view`; also accepts positional `(filename, subfolder, type)`
- `uploadImage(image, filename, { overwrite?, type?, subfolder? }?)`
- `uploadMask(image, filename, originalRef, { overwrite? }?)`

All failures throw `ComfyUIClientError` with `.status` (HTTP status, when
applicable) and `.payload` (raw server error, e.g. `node_errors`).

### Compatibility notes

Aligned with ComfyUI master (`server.py`):

- Completion is detected via the `execution_success` WS message (new servers)
  with fallback to the legacy `executing` + `node === null` signal.
- History keys are **prompt ids**; outputs include `images`, `videos`
  (formerly `gifs`), and `audio`.
- Binary WS previews are parsed (8-byte header: event type, format, width,
  height) and emitted as `preview` events.


## License

This project is licensed under the [MIT License][license].

[badge-version]: https://img.shields.io/npm/v/@artifyfun/comfy-ui-client.svg
[badge-license]: https://img.shields.io/npm/l/@artifyfun/comfy-ui-client.svg

[npm]: https://www.npmjs.com/package/@artifyfun/comfy-ui-client
[license]: https://github.com/artifyfun/comfy-ui-client/blob/main/LICENSE

[examples-generate]: https://github.com/artifyfun/comfy-ui-client/tree/main/examples/generate
